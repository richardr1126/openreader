import { getTtsCredentialBrokerConfig } from '../infrastructure/credential-broker-config';
import type { ArtifactStorage } from '../infrastructure/storage';
import type { MaintenanceJobRequest, MaintenanceJobResult, MaintenanceProgress } from '../operations/contracts';
import { expireArtifactFoldersUnderRoot } from '../storage/artifact-retention';
import { clearDocumentPreviewArtifacts, clearPdfLayoutArtifacts, clearTtsPlaybackPlanArtifacts, listDocumentDerivedIds } from '../storage/document-derived-cleanup';
import type { registerCleanupRoutes } from '../api/routes/cleanup';

type CleanupRow = { id: string; userId: string; documentId: string | null; notBeforeMs: number; attempts: number };

export async function maintenanceDatabaseStep<T>(body: Record<string, unknown>): Promise<T> {
  const config = getTtsCredentialBrokerConfig();
  const url = new URL('/api/internal/compute/maintenance', config.url);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(config.timeoutMs, 10_000)),
  });
  if (!response.ok) throw new Error(`Maintenance database step ${body.action} failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function createMaintenanceHandler(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  cleanup: ReturnType<typeof registerCleanupRoutes>;
  databaseStep?: typeof maintenanceDatabaseStep;
  logger: { warn(data: unknown, message?: string): void };
}) {
  const { storage, s3Prefix, cleanup } = input;
  const database = input.databaseStep ?? maintenanceDatabaseStep;
  const clearUserStorage = (userId: string) => cleanup.cleanupUserStorage({ storageUserId: userId, namespace: null, documentIds: [] });
  return async (request: MaintenanceJobRequest, _queueWaitMs: number, hooks?: {
    onProgress?: (progress: MaintenanceProgress) => Promise<void>;
  }): Promise<MaintenanceJobResult> => {
    let completed = 0;
    let failed = 0;
    const report = async (phase: string) => hooks?.onProgress?.({ phase, completed, failed });
    const attempt = async (run: () => Promise<void>, phase: string): Promise<boolean> => {
      // Object deletion and the SQL completions are idempotent. Short transient
      // outages should not turn an entire selected page into stranded accounts.
      for (let retry = 0; ; retry++) {
        try { await run(); return true; }
        catch (error) {
          if (retry < 2) { await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** retry)); continue; }
          failed++;
          input.logger.warn({ task: request.task, phase, error: String(error) }, 'maintenance.item_failed');
          await report(phase);
          return false;
        }
      }
    };
    await report('Starting');

    const deleteAccounts = async (claim: boolean) => {
      let after: string | null = null;
      do {
        const { userIds }: { userIds: string[] } = claim
          ? await database<{ userIds: string[] }>({ action: 'claim-users', after, idleBefore: request.idleBefore })
          : { userIds: request.userIds ?? [] };
        if (!userIds.length) break;
        for (const userId of userIds) {
          if (await attempt(async () => {
            await clearUserStorage(userId);
            await database({ action: 'finalize-user', userId });
          }, 'Deleting accounts')) completed++;
          await report('Deleting accounts');
        }
        after = userIds.at(-1)!;
      } while (claim);
    };

    if (request.task === 'delete-users' || request.task === 'expire-anonymous-users') {
      await deleteAccounts(request.task === 'expire-anonymous-users');
      return { summary: `Deleted ${completed} account(s); ${failed} failed`, completed, failed };
    }

    if (request.task === 'retry-storage-cleanups') {
      // Without an idle cutoff the claim only finds accounts already marked for
      // deletion. A failed claim must not keep queued storage cleanup waiting.
      try { await deleteAccounts(true); }
      catch (error) {
        failed++;
        // The cleanup loop's next progress report carries this failure.
        input.logger.warn({ task: request.task, phase: 'Deleting accounts', error: String(error) }, 'maintenance.item_failed');
      }
      const accounts = completed;
      let after: string | null = null;
      for (;;) {
        const page: { rows: CleanupRow[]; after: string | null; done: boolean } = await database({ action: 'cleanup-next', after });
        if (page.done) break;
        for (const row of page.rows) {
          const ok = await attempt(async () => {
            if (row.documentId === null) await clearUserStorage(row.userId);
            else await cleanup.clearPlaybackScope({ storageUserId: row.userId, documentId: row.documentId });
            await database({ action: 'cleanup-settle', row });
          }, 'Clearing queued storage');
          if (ok) completed++;
          else await database({ action: 'cleanup-settle', row, failed: true });
          await report('Clearing queued storage');
        }
        after = page.after;
      }
      return { summary: `Deleted ${accounts} pending account(s), cleared ${completed - accounts} storage scope(s); ${failed} failed`, completed, failed };
    }

    if (request.task === 'cleanup-temp-uploads') {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for await (const page of storage.listPrefixPages(`${s3Prefix}/document_uploads_temp_v1/`)) {
        const expired = page.filter((object) => object.lastModifiedMs > 0 && object.lastModifiedMs < cutoff);
        for (let index = 0; index < expired.length; index += 32) {
          await Promise.all(expired.slice(index, index + 32).map(async (object) => {
            if (await attempt(() => storage.deleteObject(object.key), 'Deleting expired uploads')) completed++;
          }));
          await report('Deleting expired uploads');
        }
      }
      await report('Expiring DOCX conversions');
      const uploads = completed;
      const conversions = await expireArtifactFoldersUnderRoot({ storage, root: `${s3Prefix}/document_conversions_v1/`, maxAgeMs: 24 * 60 * 60 * 1000 });
      await report('Expiring account exports');
      const exports = await expireArtifactFoldersUnderRoot({ storage, root: `${s3Prefix}/account_exports_v1/`, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
      completed += conversions.expiredArtifacts + exports.expiredArtifacts;
      return {
        summary: `Deleted ${uploads} expired upload(s), ${conversions.expiredArtifacts} DOCX conversion(s), ${exports.expiredArtifacts} account export(s); ${failed} failed`,
        completed, failed,
      };
    }

    if (request.task === 'reap-orphaned-blobs') {
      const root = `${s3Prefix}/documents_v1/`;
      const sources = new Set<string>();
      const candidates = new Set<string>();
      await report('Finding unowned documents');
      for await (const page of storage.listPrefixPages(root)) {
        for (const object of page) {
          const id = object.key.slice(root.length);
          if (!/^[a-f0-9]{64}$/i.test(id)) continue;
          sources.add(id);
          if (Date.now() - object.lastModifiedMs > 60 * 60 * 1000) candidates.add(id);
        }
      }
      for (const id of await listDocumentDerivedIds({ storage, s3Prefix })) if (!sources.has(id)) candidates.add(id);
      for (const documentId of candidates) {
        await attempt(async () => {
          const { owner } = await database<{ owner: string | null }>({ action: 'reap-claim', documentId });
          if (!owner) return;
          let lostLease = false;
          let renewal: Promise<void> | null = null;
          const renew = async () => {
            const result = await database<{ renewed: boolean }>({ action: 'reap-renew', documentId, owner });
            if (!result.renewed) lostLease = true;
          };
          const timer = setInterval(() => {
            if (renewal) return;
            renewal = renew().catch(() => { lostLease = true; }).finally(() => { renewal = null; });
          }, 30_000);
          try {
            // Uploads wait on this lease, so a lost lease stops deletion mid-prefix.
            const scope = { storage, s3Prefix, documentId, namespace: null, shouldStop: () => lostLease };
            await Promise.all([clearPdfLayoutArtifacts(scope), clearDocumentPreviewArtifacts(scope), clearTtsPlaybackPlanArtifacts(scope)]);
            await renewal;
            if (lostLease) throw new Error('Document cleanup lease was lost');
            await renew();
            if (lostLease) throw new Error('Document cleanup lease was lost');
            if (sources.has(documentId)) await storage.deleteObject(`${root}${documentId}`);
            completed++;
          } finally {
            clearInterval(timer);
            await renewal;
            await database({ action: 'reap-release', documentId, owner });
          }
        }, 'Removing unowned documents');
        await report('Removing unowned documents');
      }
      return { summary: `Reaped ${completed} unowned document(s); ${failed} failed`, completed, failed };
    }
    throw new Error(`Unknown maintenance task: ${String(request.task)}`);
  };
}
