/** Refused because the lock or a connection for it was not available in time. */
export class AdvisoryLockBusyError extends Error {
  constructor() {
    super('Advisory lock is busy.');
    this.name = 'AdvisoryLockBusyError';
  }
}

const LOCK_WAIT_MS = 10_000;
// This connection is idle for all of `fn`, so this limits the whole hold. Past it,
// Postgres ends the session and the lock while `fn` keeps running.
const LOCK_HOLD_IDLE_MS = 120_000;
const LOCK_NOT_AVAILABLE = '55P03';

// A holder waits on other services, and its work uses the shared pool. Holding
// locks on that pool lets a few slow commands starve every other database query.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lockPool: any = null;

function getLockPool() {
  if (lockPool) return lockPool;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg');
  lockPool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 5,
    connectionTimeoutMillis: LOCK_WAIT_MS,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  // A connection can drop while idle; the pool replaces it.
  lockPool.on('error', () => undefined);
  return lockPool;
}

/** Runs `fn` holding a Postgres advisory lock on `key`. Throws AdvisoryLockBusyError when it cannot be had in time. */
export async function withPostgresAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  try {
    client = await getLockPool().connect();
  } catch {
    throw new AdvisoryLockBusyError();
  }
  // A dropped connection only ends the lock. Without a listener it would crash the process.
  const onError = () => undefined;
  client.on('error', onError);
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${LOCK_HOLD_IDLE_MS}`);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    } catch (error) {
      if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE) throw new AdvisoryLockBusyError();
      throw error;
    }
    return await fn();
  } finally {
    // The transaction only holds the lock, so ending it either way releases it
    // and never affects work done by `fn`.
    await client.query('ROLLBACK').catch(() => { broken = true; });
    client.off('error', onError);
    client.release(broken);
  }
}
