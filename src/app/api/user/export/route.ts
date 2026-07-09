import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { buildAccountExportArtifactId } from '@openreader/tts/playback-scope';
import { db } from '@openreader/database';
import {
  documents,
  documentSettings,
  userDocumentProgress,
  userJobEvents,
  userPreferences,
  userFolders,
  userOnboarding,
  userTtsChars,
} from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { desc, eq } from 'drizzle-orm';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { documentKey } from '@/lib/server/documents/blobstore';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { getS3Client, getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import {
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  buildUserExportManifest,
} from '@/lib/server/user/data-export';
import { auth } from '@/lib/server/auth/auth';
import { nowTimestampMs } from '@/lib/shared/timestamps';

export const dynamic = 'force-dynamic';

function accountExportManifestObjectKey(input: {
  prefix: string;
  artifactId: string;
  storageUserId: string;
  namespace: string | null;
}): string {
  const namespaceSegment = input.namespace ? `ns/${input.namespace}/` : '';
  return `${input.prefix}/account_exports_v1/${namespaceSegment}users/${encodeURIComponent(input.storageUserId)}/${input.artifactId}/manifest.json`;
}

function buildAccountExportDownloadUrl(input: {
  artifactId: string;
  manifestHash: string;
}): string {
  const params = new URLSearchParams({
    artifactId: input.artifactId,
    manifestHash: input.manifestHash,
  });
  return `/api/user/export/download?${params.toString()}`;
}

export async function POST(req: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/user/export',
    request: req,
  });
  try {
    if (!auth) {
      return errorResponse(new Error('Auth not initialized'), {
        apiErrorMessage: 'Auth not initialized',
        normalize: { code: 'USER_EXPORT_AUTH_NOT_INITIALIZED', errorClass: 'auth', httpStatus: 500 },
      });
    }
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for account export.' },
        { status: 503 },
      );
    }
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Object storage is required for account export.' },
        { status: 503 },
      );
    }

    const body = await req.json().catch(() => null);
    const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : {};

    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const storageUserId = userId;
    const namespace = getOpenReaderTestNamespace(req.headers);

    const existingArtifactId = typeof bodyRecord.artifactId === 'string' ? bodyRecord.artifactId.trim() : '';
    const existingManifestHash = typeof bodyRecord.manifestHash === 'string' ? bodyRecord.manifestHash.trim() : '';
    if (existingArtifactId || existingManifestHash) {
      if (!/^[a-f0-9]{8,128}$/i.test(existingArtifactId) || !/^[a-f0-9]{64}$/i.test(existingManifestHash)) {
        return NextResponse.json({ error: 'Invalid account export artifact reference' }, { status: 400 });
      }
      const resolved = await new ComputeWorkerClient().resolveAccountExport({
        artifactId: existingArtifactId,
        storageUserId,
        namespace,
        schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
        manifestHash: existingManifestHash,
      });
      return NextResponse.json({
        artifactId: existingArtifactId,
        manifestHash: existingManifestHash,
        status: resolved.artifact ? 'ready' : resolved.operation?.status ?? 'queued',
        operationId: resolved.operation?.opId ?? null,
        progress: resolved.operation?.progress ?? null,
        downloadUrl: resolved.artifact
          ? buildAccountExportDownloadUrl({ artifactId: existingArtifactId, manifestHash: existingManifestHash })
          : null,
      });
    }

    const exportedAtMs = nowTimestampMs();

    const [
      prefs,
      progress,
      ttsUsage,
      jobEvents,
      perDocumentSettings,
      userDocs,
      folders,
      onboarding,
    ] = await Promise.all([
      db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
      db
        .select()
        .from(userDocumentProgress)
        .where(eq(userDocumentProgress.userId, userId))
        .orderBy(desc(userDocumentProgress.updatedAt)),
      db
        .select()
        .from(userTtsChars)
        .where(eq(userTtsChars.userId, userId))
        .orderBy(desc(userTtsChars.date)),
      db
        .select()
        .from(userJobEvents)
        .where(eq(userJobEvents.userId, userId))
        .orderBy(desc(userJobEvents.createdAt)),
      db
        .select()
        .from(documentSettings)
        .where(eq(documentSettings.userId, userId))
        .orderBy(desc(documentSettings.updatedAt)),
      db
        .select()
        .from(documents)
        .where(eq(documents.userId, userId))
        .orderBy(desc(documents.lastModified)),
      db.select().from(userFolders).where(eq(userFolders.userId, userId)).orderBy(userFolders.position),
      db.select().from(userOnboarding).where(eq(userOnboarding.userId, userId)).limit(1),
    ]);

    const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
    // Auth exports intentionally select metadata only. Credential and session
    // secrets must never be written into the archive.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const database = db as any;
    const [authSessions, linkedAccounts] = await Promise.all([
      database
        .select({
          id: authSchema.session.id,
          expiresAt: authSchema.session.expiresAt,
          createdAt: authSchema.session.createdAt,
          updatedAt: authSchema.session.updatedAt,
          ipAddress: authSchema.session.ipAddress,
          userAgent: authSchema.session.userAgent,
        })
        .from(authSchema.session)
        .where(eq(authSchema.session.userId, userId)),
      database
        .select({
          id: authSchema.account.id,
          accountId: authSchema.account.accountId,
          providerId: authSchema.account.providerId,
          scope: authSchema.account.scope,
          createdAt: authSchema.account.createdAt,
          updatedAt: authSchema.account.updatedAt,
        })
        .from(authSchema.account)
        .where(eq(authSchema.account.userId, userId)),
    ]);

    const manifest = buildUserExportManifest({
      userId,
      storageUserId,
      namespace,
      exportedAtMs,
      profileData: { user: session.user, exportedAtMs },
      preferences: prefs[0] ?? null,
      folders,
      onboarding: onboarding[0] ?? null,
      readingHistory: progress,
      ttsUsage,
      jobEvents,
      documentSettings: perDocumentSettings,
      authSessions,
      linkedAccounts,
      documents: userDocs,
      getDocumentObjectKey: (documentId) => documentKey(documentId, namespace),
    });

    const manifestBody = JSON.stringify(manifest);
    const manifestHash = createHash('sha256').update(manifestBody).digest('hex');
    const artifactId = buildAccountExportArtifactId({
      storageUserId,
      namespace,
      schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
      manifestHash,
    });
    const cfg = getS3Config();
    const manifestObjectKey = accountExportManifestObjectKey({
      prefix: cfg.prefix,
      artifactId,
      storageUserId,
      namespace,
    });
    await getS3Client().send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: manifestObjectKey,
      Body: Buffer.from(manifestBody),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));

    const client = new ComputeWorkerClient();
    let resolved = await client.resolveAccountExport({
      artifactId,
      storageUserId,
      namespace,
      schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
      manifestHash,
    });
    if (!resolved.artifact && (!resolved.operation || resolved.operation.status === 'failed' || resolved.operation.status === 'succeeded')) {
      await client.createAccountExportOperation({
        artifactId,
        userId,
        storageUserId,
        namespace,
        schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
        manifestHash,
        manifestObjectKey,
      });
      resolved = await client.resolveAccountExport({
        artifactId,
        storageUserId,
        namespace,
        schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
        manifestHash,
      });
    }

    return NextResponse.json({
      artifactId,
      manifestHash,
      status: resolved.artifact ? 'ready' : resolved.operation?.status ?? 'queued',
      operationId: resolved.operation?.opId ?? null,
      progress: resolved.operation?.progress ?? null,
      downloadUrl: resolved.artifact
        ? buildAccountExportDownloadUrl({ artifactId, manifestHash })
        : null,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'user.export.resolve_failed',
      msg: 'Failed to resolve account export',
      apiErrorMessage: 'Failed to resolve account export',
      normalize: { code: 'USER_EXPORT_RESOLVE_FAILED', errorClass: 'unknown' },
    });
  }
}
