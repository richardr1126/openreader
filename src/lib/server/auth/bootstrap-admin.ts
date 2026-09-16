import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hashPassword } from 'better-auth/crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { adminSettings } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { serverLogger } from '@/lib/server/logger';

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const BOOTSTRAP_KEY = 'initialAdminBootstrapped';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let bootstrapPromise: Promise<void> | null = null;

function storedMarker(userId: string | null): unknown {
  const value = { version: 1, userId };
  return process.env.POSTGRES_URL ? value : JSON.stringify(value);
}

async function configuredPassword(): Promise<string | null> {
  const inline = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const path = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE?.trim();
  if (inline && path) throw new Error('Set only one bootstrap admin password source');
  if (path) return (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  return inline ?? null;
}

/**
 * Create the first admin credential once. The admin role stays inactive until
 * the initial password is changed through Better Auth's password endpoint.
 * Both the account and the durable marker commit in the same transaction.
 */
export async function ensureInitialAdmin(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = seedInitialAdmin().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

async function seedInitialAdmin(): Promise<void> {
  const existingMarker = await db.select({ key: adminSettings.key }).from(adminSettings)
    .where(eq(adminSettings.key, BOOTSTRAP_KEY)).limit(1);
  if (existingMarker.length > 0) return;

  const rawEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  const password = await configuredPassword();
  const configured = Boolean(rawEmail || password);
  if (configured && (!EMAIL_PATTERN.test(rawEmail) || !password || password.length < 16)) {
    throw new Error('Bootstrap admin requires a valid BOOTSTRAP_ADMIN_EMAIL and a password of at least 16 characters');
  }
  const email = rawEmail.toLowerCase();
  const passwordHash = configured ? await hashPassword(password!) : null;
  let created = false;

  await runInDbTransaction(async (conn) => {
    if (configured) {
      // The unique marker serializes concurrent first requests across app
      // instances. A failed account insert rolls the marker back as well.
      const inserted = await conn.insert(adminSettings).values({
        key: BOOTSTRAP_KEY,
        valueJson: storedMarker(null) as never,
        source: 'admin',
        updatedAt: Date.now(),
      }).onConflictDoNothing().returning({ key: adminSettings.key });
      if (inserted.length === 0) return;
    }

    const admins = await conn.select({ id: authSchema.user.id }).from(authSchema.user)
      .where(eq(authSchema.user.isAdmin, true)).limit(1);
    if (admins.length > 0) {
      // Existing v4/v5 admins keep their grants; bootstrap never supersedes
      // them, and a later deletion cannot reopen first-boot seeding.
      if (!configured) {
        await conn.insert(adminSettings).values({
          key: BOOTSTRAP_KEY,
          valueJson: storedMarker(null) as never,
          source: 'admin',
          updatedAt: Date.now(),
        }).onConflictDoNothing();
      }
      return;
    }
    if (!configured) return;

    const occupied = await conn.select({ id: authSchema.user.id }).from(authSchema.user)
      .where(sql`lower(${authSchema.user.email}) = ${email}`).limit(1);
    if (occupied.length > 0) {
      throw new Error('Bootstrap admin email is already registered; choose a different address or recover the existing account');
    }

    const userId = randomUUID();
    const now = new Date();
    await conn.insert(authSchema.user).values({
      id: userId,
      name: email.split('@')[0],
      email,
      emailVerified: false,
      isAnonymous: false,
      isAdmin: false,
      adminSource: 'bootstrap',
      accessStatus: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await conn.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: 'credential',
      issuer: 'local:credential',
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    await conn.update(adminSettings).set({ valueJson: storedMarker(userId) as never })
      .where(eq(adminSettings.key, BOOTSTRAP_KEY));
    created = true;
  });
  if (created) {
    serverLogger.info({ event: 'auth.bootstrap_admin.created' }, 'Created first-boot admin account');
  }
}
