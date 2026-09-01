import { NextRequest, NextResponse } from 'next/server';
import {
  parseTtsCredentialBrokerRequest,
  type TtsCredentialBrokerErrorCode,
  type TtsCredentialBrokerResponse,
} from '@openreader/tts/credential-broker';
import {
  ProviderCredentialDecryptionError,
  resolveTtsCredentials,
} from '@/lib/server/admin/resolve-credentials';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import { hashForLog, serverLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
};
const MAX_REQUEST_BYTES = 1_024;

function brokerError(status: number, error: TtsCredentialBrokerErrorCode): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth === 'unconfigured') return brokerError(503, 'BROKER_UNAVAILABLE');
  if (auth !== 'authorized') return brokerError(401, 'BROKER_UNAUTHORIZED');

  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return brokerError(400, 'PROVIDER_REF_INVALID');
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
    return brokerError(400, 'PROVIDER_REF_INVALID');
  }
  const parsed = parseTtsCredentialBrokerRequest(parseJson(rawBody));
  if (!parsed) return brokerError(400, 'PROVIDER_REF_INVALID');

  try {
    const resolved = await resolveTtsCredentials({ providerHeader: parsed.providerRef });
    if ('error' in resolved || !resolved.adminRecord) {
      return brokerError(404, 'PROVIDER_UNAVAILABLE');
    }
    const response: TtsCredentialBrokerResponse = {
      providerRef: resolved.adminRecord.slug,
      providerType: resolved.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl ?? null,
      defaultModel: resolved.adminRecord.defaultModel,
      defaultInstructions: resolved.adminRecord.defaultInstructions,
    };
    return NextResponse.json(response, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const code: TtsCredentialBrokerErrorCode = error instanceof ProviderCredentialDecryptionError
      ? 'PROVIDER_DECRYPT_FAILED'
      : 'BROKER_UNAVAILABLE';
    serverLogger.error({
      event: 'compute.credential_broker.resolve.failed',
      code,
      providerRefHash: hashForLog(parsed.providerRef),
      error: {
        name: 'CredentialBrokerResolutionError',
        message: code,
        code,
      },
    }, 'Compute credential broker failed to resolve provider');
    return brokerError(code === 'PROVIDER_DECRYPT_FAILED' ? 500 : 503, code);
  }
}
