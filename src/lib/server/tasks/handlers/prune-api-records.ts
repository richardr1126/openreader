import { and, eq, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { pruneSettledAudiobookRequests } from '@/lib/server/audiobooks/audiobooks';
import type { TaskContext, TaskResult } from '../types';

const UNUSED_CLIENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Registration is open, so a client nobody ever approved must not stay forever. */
async function pruneOAuthRecords(now: Date): Promise<number> {
  const schema = process.env.POSTGRES_URL ? postgres : sqlite;
  const { oauthAccessToken, oauthClient, oauthClientAssertion, oauthConsent, oauthRefreshToken, deviceCode } = schema;
  const removed = await Promise.all([
    db.delete(oauthAccessToken).where(lt(oauthAccessToken.expiresAt, now)).returning({ id: oauthAccessToken.id }),
    db.delete(deviceCode).where(lt(deviceCode.expiresAt, now)).returning({ id: deviceCode.id }),
    db.delete(oauthClientAssertion).where(lt(oauthClientAssertion.expiresAt, now)).returning({ id: oauthClientAssertion.id }),
  ]) as Array<Array<unknown>>;
  // Access tokens reference their refresh token, so these go after them.
  const refreshTokens = await db.delete(oauthRefreshToken).where(lt(oauthRefreshToken.expiresAt, now))
    .returning({ id: oauthRefreshToken.id }) as Array<unknown>;
  const clients = await db.delete(oauthClient).where(and(
    lt(oauthClient.createdAt, new Date(now.getTime() - UNUSED_CLIENT_RETENTION_MS)),
    or(isNull(oauthClient.skipConsent), ne(oauthClient.skipConsent, true)),
    notExists(db.select({ found: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId))),
  )).returning({ id: oauthClient.id }) as Array<unknown>;
  return removed.reduce((total, rows) => total + rows.length, refreshTokens.length + clients.length);
}

export async function pruneApiRecords(context: TaskContext): Promise<TaskResult> {
  const now = new Date();
  const oauthRecords = await pruneOAuthRecords(now);
  const audiobookRequests = await pruneSettledAudiobookRequests(now.getTime(), context.deadlineAt);
  return { summary: `Removed ${oauthRecords} app sign-in records and ${audiobookRequests} audiobook requests`, oauthRecords, audiobookRequests };
}
