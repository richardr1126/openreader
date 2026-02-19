import { createHash } from 'crypto';
import path from 'path';

export const DOCSTORE_DIR = path.join(process.cwd(), 'docstore');
export const DOCUMENTS_V1_DIR = path.join(DOCSTORE_DIR, 'documents_v1');
export const AUDIOBOOKS_V1_DIR = path.join(DOCSTORE_DIR, 'audiobooks_v1');

export const UNCLAIMED_USER_ID = 'unclaimed';

function safeDocumentName(rawName: string, fallback: string): string {
  const baseName = path.basename(rawName || fallback);
  return baseName.replaceAll('\u0000', '').slice(0, 240) || fallback;
}

export function getMigratedDocumentFileName(id: string, name: string): string {
  const normalizedName = safeDocumentName(name, `${id}.bin`);
  const prefix = `${id}__`;
  const encodedName = encodeURIComponent(normalizedName);
  let targetFileName = `${prefix}${encodedName}`;

  // Keep migrated document filenames under conservative filesystem length limits.
  if (targetFileName.length > 240) {
    const nameHash = createHash('sha256').update(normalizedName).digest('hex').slice(0, 32);
    targetFileName = `${prefix}truncated-${nameHash}`;
  }
  return targetFileName;
}
