import type {
  AccountExportResolution,
  AccountExportResolveRequest,
} from '@/lib/server/compute-worker/protocol';
import { ACCOUNT_EXPORT_SCHEMA_VERSION } from './data-export';

export type SupportedAccountExportSchemaVersion = 4 | typeof ACCOUNT_EXPORT_SCHEMA_VERSION;

const SUPPORTED_ACCOUNT_EXPORT_SCHEMA_VERSIONS = [
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  4,
] as const satisfies readonly SupportedAccountExportSchemaVersion[];

type AccountExportResolver = {
  resolveAccountExport: (input: AccountExportResolveRequest) => Promise<AccountExportResolution>;
};

export function parseSupportedAccountExportSchemaVersion(
  value: unknown,
): SupportedAccountExportSchemaVersion | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return SUPPORTED_ACCOUNT_EXPORT_SCHEMA_VERSIONS.find((version) => version === parsed) ?? null;
}

export async function resolveAccountExportReference(input: {
  client: AccountExportResolver;
  reference: Omit<AccountExportResolveRequest, 'schemaVersion'>;
  preferredSchemaVersion?: SupportedAccountExportSchemaVersion | null;
}): Promise<{
  resolution: AccountExportResolution;
  schemaVersion: SupportedAccountExportSchemaVersion;
}> {
  const candidates = input.preferredSchemaVersion
    ? [input.preferredSchemaVersion]
    : [...SUPPORTED_ACCOUNT_EXPORT_SCHEMA_VERSIONS];
  let unresolved: AccountExportResolution | null = null;

  for (const schemaVersion of candidates) {
    const resolution = await input.client.resolveAccountExport({
      ...input.reference,
      schemaVersion,
    });
    unresolved ??= resolution;
    if (resolution.artifact || resolution.operation) {
      return {
        resolution,
        schemaVersion: parseSupportedAccountExportSchemaVersion(
          resolution.artifact?.exportSchemaVersion,
        ) ?? schemaVersion,
      };
    }
  }

  return {
    resolution: unresolved ?? { artifact: null, operation: null },
    schemaVersion: input.preferredSchemaVersion ?? ACCOUNT_EXPORT_SCHEMA_VERSION,
  };
}
