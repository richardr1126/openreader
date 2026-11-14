import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parsedPdfPageSchema } from '../api/schemas';
import { isNotFound, type ArtifactStorage } from '../infrastructure/storage';
import { PDF_CHECKPOINT_BATCH_SIZE, type PdfPageCheckpoint } from '../inference/pdf/parse';
import { encodeParserVersion, PDF_PARSER_VERSION } from '../operations/contracts';
import { parsedPdfArtifactPrefix } from './artifact-addressing';
import { deletePrefix } from './prefix-cleanup';

const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  totalPages: z.number().int().positive(),
  sawText: z.boolean(),
  pages: z.array(parsedPdfPageSchema).min(1).max(PDF_CHECKPOINT_BATCH_SIZE),
});

export function createPdfParseCheckpoint(input: {
  storage: ArtifactStorage;
  documentId: string;
  namespace: string | null;
  prefix: string;
  operationKey: string;
  pdfBytes: ArrayBuffer;
}) {
  const { storage } = input;
  const identity = createHash('sha256').update(input.operationKey).update(Buffer.from(input.pdfBytes)).digest('hex');
  const prefix = `${parsedPdfArtifactPrefix(input)}checkpoint/${encodeParserVersion(PDF_PARSER_VERSION)}/${identity}/`;
  const pageKey = (pageNumber: number) => `${prefix}${String(pageNumber).padStart(10, '0')}/`;

  return {
    async read(signal: AbortSignal, requestSignal: () => AbortSignal): Promise<PdfPageCheckpoint | null> {
      const keys = (await storage.listPrefix(prefix, requestSignal())).sort();
      const checkpoint: PdfPageCheckpoint = { pages: [], totalPages: 0, sawText: false };
      let nextBlockId = 1;
      for (const key of keys) {
        signal.throwIfAborted();
        const firstPage = checkpoint.pages.length + 1;
        const expectedPrefix = pageKey(firstPage);
        if (key < expectedPrefix) continue;
        if (!key.startsWith(expectedPrefix)) break;

        const bytes = await storage.readObject(key, requestSignal()).catch((error) => {
          if (isNotFound(error)) return null;
          throw error;
        });
        if (!bytes) continue;
        let value: unknown;
        try {
          value = JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch {
          continue;
        }
        const result = checkpointSchema.safeParse(value);
        if (!result.success) continue;
        const chunk = result.data;
        if ((checkpoint.totalPages && chunk.totalPages !== checkpoint.totalPages)
          || chunk.pages.length !== Math.min(PDF_CHECKPOINT_BATCH_SIZE, chunk.totalPages - firstPage + 1)) continue;

        let blockId = nextBlockId;
        const valid = chunk.pages.every((page, offset) => page.pageNumber === firstPage + offset
          && page.blocks.every((block) => block.id === `b${String(blockId++).padStart(4, '0')}`
            && block.fragments.every((fragment) => fragment.page === page.pageNumber)));
        if (!valid) continue;
        checkpoint.pages.push(...chunk.pages);
        checkpoint.sawText ||= chunk.sawText;
        checkpoint.totalPages = chunk.totalPages;
        nextBlockId = blockId;
      }
      signal.throwIfAborted();
      return checkpoint.pages.length > 0 ? checkpoint : null;
    },
    key(chunk: PdfPageCheckpoint, opId: string, attempt: number): string {
      return `${pageKey(chunk.pages[0].pageNumber)}${opId}-${attempt}.json`;
    },
    async write(key: string, chunk: PdfPageCheckpoint, signal: AbortSignal): Promise<void> {
      await storage.putObject(key, Buffer.from(JSON.stringify({ schemaVersion: 1, ...chunk })), 'application/json', signal);
    },
    async clear(signal: AbortSignal): Promise<void> {
      await deletePrefix(storage, prefix, () => signal.aborted, signal);
    },
  };
}
