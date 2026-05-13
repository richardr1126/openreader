import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  clearRuntimeConfigKey,
  RUNTIME_CONFIG_SCHEMA,
  setRuntimeConfigKey,
  type RuntimeConfigKey,
} from '@/lib/server/admin/settings';
import { getResolvedRuntimeConfigWithSources } from '@/lib/server/runtime-config';

export const dynamic = 'force-dynamic';

const VALID_KEYS = new Set<RuntimeConfigKey>(
  Object.keys(RUNTIME_CONFIG_SCHEMA) as RuntimeConfigKey[],
);

function isRuntimeKey(value: unknown): value is RuntimeConfigKey {
  return typeof value === 'string' && VALID_KEYS.has(value as RuntimeConfigKey);
}

export async function GET(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { values, sources } = await getResolvedRuntimeConfigWithSources();
  return NextResponse.json({ values, sources });
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Expected JSON object' }, { status: 400 });
  }

  const rec = body as Record<string, unknown>;
  const updates = (rec.updates && typeof rec.updates === 'object'
    ? (rec.updates as Record<string, unknown>)
    : rec) as Record<string, unknown>;
  const resets = Array.isArray(rec.reset) ? (rec.reset as unknown[]) : [];

  const errors: Array<{ key: string; message: string }> = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!isRuntimeKey(key)) {
      errors.push({ key, message: 'unknown key' });
      continue;
    }
    try {
      await setRuntimeConfigKey(key, value as never);
    } catch (error) {
      errors.push({ key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const key of resets) {
    if (!isRuntimeKey(key)) {
      errors.push({ key: String(key), message: 'unknown key' });
      continue;
    }
    try {
      await clearRuntimeConfigKey(key);
    } catch (error) {
      errors.push({ key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const { values, sources } = await getResolvedRuntimeConfigWithSources();
  return NextResponse.json({ values, sources, errors }, { status: errors.length ? 207 : 200 });
}
