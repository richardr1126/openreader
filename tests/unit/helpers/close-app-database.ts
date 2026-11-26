/**
 * Close the app's SQLite connections before a test removes its temporary
 * database. Windows cannot delete a file that a connection still holds open.
 * Import the modules here, after the test's vi.resetModules(), so these are
 * the same instances the app code under test used.
 */
export async function closeAppDatabase(): Promise<void> {
  const [{ closeTransactionConnection }, { closeDatabase }] = await Promise.all([
    import('@openreader/database/run-in-transaction'),
    import('@openreader/database'),
  ]);
  await closeTransactionConnection();
  await closeDatabase();
}
