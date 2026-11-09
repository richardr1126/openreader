import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiRequestError } from '@/lib/server/api/responses';
import type { ApiPrincipal } from '@/lib/server/api/principal';

/**
 * A signed transfer URL for one prepared upload, for clients that hold no v1
 * token: an MCP client's shell sends the file with it. It authorizes only the
 * PUT of that upload's bytes, for its owner, until it expires; registering the
 * document still takes the client's own token.
 */
const LINK_TTL_MS = 30 * 60 * 1000;

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error('AUTH_SECRET is required to sign upload links');
  return value;
}

function mac(userId: string, uploadId: string, expiresAt: number): Buffer {
  return createHmac('sha256', secret()).update(`openreader:upload-link:v1\0${userId}\0${uploadId}\0${expiresAt}`).digest();
}

/** The query that lets `PUT /api/v1/uploads/{id}/file` accept the upload without a token. */
export function signUploadLink(userId: string, uploadId: string, now = Date.now()): { query: string; expiresAt: number } {
  const expiresAt = now + LINK_TTL_MS;
  const owner = Buffer.from(userId).toString('base64url');
  return { query: `owner=${owner}&expires=${expiresAt}&signature=${mac(userId, uploadId, expiresAt).toString('base64url')}`, expiresAt };
}

export function hasUploadLinkSignature(query: URLSearchParams): boolean {
  return query.has('signature');
}

/** The upload's owner, as the principal a signed link stands for. */
export function verifyUploadLink(uploadId: string, query: URLSearchParams, now = Date.now()): ApiPrincipal {
  const invalid = () => new ApiRequestError(403, 'UPLOAD_LINK_INVALID', 'This upload link is invalid or has expired. Run "docs upload" again for a new one.');
  const expiresAt = Number(query.get('expires'));
  const signature = Buffer.from(query.get('signature') ?? '', 'base64url');
  const userId = Buffer.from(query.get('owner') ?? '', 'base64url').toString('utf8');
  if (!userId || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + LINK_TTL_MS) throw invalid();
  const expected = mac(userId, uploadId, expiresAt);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw invalid();
  return { userId, isAnonymous: false, scopes: ['documents:write'] };
}
