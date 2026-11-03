import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneComputeLimitPolicyDocument,
  type ComputeLimitPolicyDocument,
} from '@openreader/runtime-config/compute-limits';

const databaseDirectory = mkdtempSync(join(tmpdir(), 'openreader-compute-limit-test-'));
const databasePath = join(databaseDirectory, 'limits.db');
let consumeComputeUsage: typeof import('@/lib/server/compute-limits/usage').consumeComputeUsage;
let reserveComputeAdmission: typeof import('@/lib/server/compute-limits/admission').reserveComputeAdmission;
let finishComputeAdmission: typeof import('@/lib/server/compute-limits/admission').finishComputeAdmission;

function policy(boundary: 'strict' | 'soft_unit'): ComputeLimitPolicyDocument {
  const value = cloneComputeLimitPolicyDocument();
  value.actions.tts_synthesis.enabled = true;
  value.actions.tts_synthesis.usage = [{
    scope: 'user',
    audience: 'authenticated',
    metric: 'characters',
    window: 'utc_day',
    limit: 10,
    boundary,
  }];
  return value;
}

beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath;
  process.env.AUTH_SECRET = 'compute-limit-test-secret';
  const sqlite = new Database(databasePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    create table user (id text primary key);
    insert into user (id) values ('user-1');
    create table compute_limit_admissions (
      id text primary key,
      request_key text not null,
      user_id text not null references user(id) on delete cascade,
      is_anonymous integer not null,
      action text not null,
      state text not null,
      operation_id text,
      device_scope_key text,
      ip_scope_key text,
      active_scopes_json text not null default '[]',
      policy_version integer not null,
      created_at integer not null,
      activated_at integer,
      finished_at integer,
      lease_expires_at integer not null,
      unique (user_id, action, request_key)
    );
    create table compute_limit_buckets (
      scope_type text not null,
      scope_key text not null,
      action text not null,
      metric text not null,
      window_start integer not null,
      window_end integer not null,
      used integer not null default 0,
      updated_at integer not null,
      primary key (scope_type, scope_key, action, metric, window_start)
    );
    create table compute_limit_events (
      event_key text primary key,
      admission_id text references compute_limit_admissions(id) on delete set null,
      user_id text not null references user(id) on delete cascade,
      action text not null,
      metric text not null,
      units integer not null,
      policy_version integer not null,
      created_at integer not null
    );
  `);
  sqlite.close();
  vi.resetModules();
  ({ consumeComputeUsage } = await import('@/lib/server/compute-limits/usage'));
  ({ reserveComputeAdmission, finishComputeAdmission } = await import('@/lib/server/compute-limits/admission'));
});

afterAll(() => {
  rmSync(databaseDirectory, { recursive: true, force: true });
});

describe('compute usage limits', () => {
  const subject = { userId: 'user-1', isAnonymous: false };
  const nowMs = Date.UTC(2026, 8, 8, 12);

  test('soft segment thresholds admit one complete overshooting segment, then stop', async () => {
    const first = await consumeComputeUsage({
      policy: policy('soft_unit'), action: 'tts_synthesis', metric: 'characters',
      units: 8, eventKey: 'soft-1', subject, nowMs,
    });
    const overshoot = await consumeComputeUsage({
      policy: policy('soft_unit'), action: 'tts_synthesis', metric: 'characters',
      units: 8, eventKey: 'soft-2', subject, nowMs,
    });
    const denied = await consumeComputeUsage({
      policy: policy('soft_unit'), action: 'tts_synthesis', metric: 'characters',
      units: 1, eventKey: 'soft-3', subject, nowMs,
    });
    const retry = await consumeComputeUsage({
      policy: policy('soft_unit'), action: 'tts_synthesis', metric: 'characters',
      units: 8, eventKey: 'soft-2', subject, nowMs,
    });

    expect(first).toMatchObject({ allowed: true, charged: true, idempotent: false });
    expect(overshoot).toMatchObject({ allowed: true, charged: true, idempotent: false });
    expect(overshoot.buckets[0]?.used).toBe(16);
    expect(denied).toMatchObject({ allowed: false, charged: false });
    expect(denied.buckets[0]?.used).toBe(16);
    expect(retry).toMatchObject({ allowed: true, charged: false, idempotent: true });
  });

  test('strict boundaries reject a unit that would cross the cap', async () => {
    const strictNowMs = nowMs + 24 * 60 * 60 * 1000;
    const first = await consumeComputeUsage({
      policy: policy('strict'), action: 'tts_synthesis', metric: 'characters',
      units: 8, eventKey: 'strict-1', subject, nowMs: strictNowMs,
    });
    const denied = await consumeComputeUsage({
      policy: policy('strict'), action: 'tts_synthesis', metric: 'characters',
      units: 3, eventKey: 'strict-2', subject, nowMs: strictNowMs,
    });

    expect(first.allowed).toBe(true);
    expect(denied).toMatchObject({ allowed: false, charged: false });
    expect(denied.buckets[0]?.used).toBe(8);
  });
});

describe('compute admission limits', () => {
  test('atomically admits only one active job and releases its gauge', async () => {
    const admissionPolicy = cloneComputeLimitPolicyDocument();
    admissionPolicy.actions.pdf_layout.enabled = true;
    admissionPolicy.actions.pdf_layout.admission.windows = [];
    admissionPolicy.actions.pdf_layout.admission.active = [
      { scope: 'user', limit: 1, leaseSeconds: 60 },
    ];
    const subject = { userId: 'user-1', isAnonymous: false };
    const [first, second] = await Promise.all([
      reserveComputeAdmission({
        policy: admissionPolicy, action: 'pdf_layout', requestKey: 'pdf-1', subject,
      }),
      reserveComputeAdmission({
        policy: admissionPolicy, action: 'pdf_layout', requestKey: 'pdf-2', subject,
      }),
    ]);
    const admitted = [first, second].filter((decision) => decision.allowed);
    const denied = [first, second].filter((decision) => !decision.allowed);

    expect(admitted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    await finishComputeAdmission({ admissionId: admitted[0]!.admissionId!, state: 'finished' });
    await expect(reserveComputeAdmission({
      policy: admissionPolicy, action: 'pdf_layout', requestKey: 'pdf-3', subject,
    })).resolves.toMatchObject({ allowed: true });
  });

  test('reclaims a terminal stable request key as a newly charged admission', async () => {
    const admissionPolicy = cloneComputeLimitPolicyDocument();
    admissionPolicy.actions.document_preview.enabled = true;
    admissionPolicy.actions.document_preview.admission.windows = [
      { scope: 'user', windowSeconds: 3_600, limit: 2 },
    ];
    admissionPolicy.actions.document_preview.admission.active = [
      { scope: 'user', limit: 1, leaseSeconds: 60 },
    ];
    const subject = { userId: 'user-1', isAnonymous: false };
    const first = await reserveComputeAdmission({
      policy: admissionPolicy,
      action: 'document_preview',
      requestKey: 'stable-preview-key',
      subject,
    });
    await finishComputeAdmission({ admissionId: first.admissionId!, state: 'finished' });

    const reused = await reserveComputeAdmission({
      policy: admissionPolicy,
      action: 'document_preview',
      requestKey: 'stable-preview-key',
      subject,
    });
    const blocked = await reserveComputeAdmission({
      policy: admissionPolicy,
      action: 'document_preview',
      requestKey: 'another-preview-key',
      subject,
    });

    expect(reused).toMatchObject({ allowed: true, idempotent: false, state: 'reserved' });
    expect(reused.admissionId).not.toBe(first.admissionId);
    expect(blocked).toMatchObject({ allowed: false });
    await finishComputeAdmission({ admissionId: reused.admissionId!, state: 'finished' });
  });

  test('an admission from before the upgrade can finish with its retired scopes ignored', async () => {
    const enforced = cloneComputeLimitPolicyDocument();
    enforced.actions.account_export.enabled = true;
    enforced.actions.account_export.admission.windows = [];
    enforced.actions.account_export.admission.active = [{ scope: 'user', limit: 1, leaseSeconds: 60 }];
    const subject = { userId: 'user-1', isAnonymous: false };
    const reserve = (requestKey: string) => reserveComputeAdmission({ policy: enforced, action: 'account_export', requestKey, subject });
    const older = await reserve('export-before-upgrade');
    const sqlite = new Database(databasePath);
    const { active_scopes_json: stored } = sqlite.prepare('select active_scopes_json from compute_limit_admissions where id = ?').get(older.admissionId!) as { active_scopes_json: string };
    sqlite.prepare('update compute_limit_admissions set active_scopes_json = ? where id = ?').run(
      JSON.stringify([...JSON.parse(stored), { scope: 'ip', scopeKey: 'old-ip' }, { scope: 'anonymous_device', scopeKey: 'old-device' }]),
      older.admissionId!,
    );
    sqlite.close();

    await finishComputeAdmission({ admissionId: older.admissionId!, state: 'finished' });

    const next = await reserve('export-after-upgrade');
    expect(next.allowed).toBe(true);
    await finishComputeAdmission({ admissionId: next.admissionId!, state: 'finished' });
  });

  test('completion decrements only the active scopes charged at admission time', async () => {
    const offPolicy = cloneComputeLimitPolicyDocument();
    offPolicy.actions.account_export.enabled = false;
    offPolicy.actions.account_export.admission.windows = [];
    offPolicy.actions.account_export.admission.active = [
      { scope: 'user', limit: 1, leaseSeconds: 60 },
    ];
    const subject = { userId: 'user-1', isAnonymous: false };
    const uncharged = await reserveComputeAdmission({
      policy: offPolicy,
      action: 'account_export',
      requestKey: 'export-while-off',
      subject,
    });

    const enforcedPolicy = cloneComputeLimitPolicyDocument();
    enforcedPolicy.actions.account_export.enabled = true;
    enforcedPolicy.actions.account_export.admission.windows = [];
    enforcedPolicy.actions.account_export.admission.active = [
      { scope: 'user', limit: 1, leaseSeconds: 60 },
    ];
    const charged = await reserveComputeAdmission({
      policy: enforcedPolicy,
      action: 'account_export',
      requestKey: 'export-while-enforced',
      subject,
    });
    await finishComputeAdmission({ admissionId: uncharged.admissionId!, state: 'finished' });
    const blocked = await reserveComputeAdmission({
      policy: enforcedPolicy,
      action: 'account_export',
      requestKey: 'export-still-blocked',
      subject,
    });

    expect(charged.allowed).toBe(true);
    expect(blocked).toMatchObject({ allowed: false });
    await finishComputeAdmission({ admissionId: charged.admissionId!, state: 'finished' });
  });
});
