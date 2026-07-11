/**
 * Resolve browser object delivery independently from the S3 endpoint used by
 * server processes.  This module deliberately has no framework dependencies:
 * bootstrap, Next, and the compute worker all load the exact same contract.
 */
function bool(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function endpoint(value, name, { requireHttps = false } = {}) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (!parsed.hostname) throw new Error(`${name} must include a hostname.`);
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use https:// because browsers use it for direct object transfers.`);
  }
  if (requireHttps && parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${name} must be a dedicated S3 hostname, not a path-mounted endpoint.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function isEmbeddedStorage(env = process.env) {
  return bool(env.USE_EMBEDDED_WEED_MINI, true);
}

export function resolveStorageTransport(env = process.env, options = {}) {
  const embedded = options.embedded ?? isEmbeddedStorage(env);
  const cloud = options.cloud ?? Boolean(env.VERCEL);
  const configured = (env.S3_BROWSER_TRANSPORT || 'auto').trim().toLowerCase();
  if (!['auto', 'proxy', 'presigned'].includes(configured)) {
    throw new Error('S3_BROWSER_TRANSPORT must be one of: auto, proxy, presigned.');
  }

  const internalEndpoint = endpoint(
    (env.S3_INTERNAL_ENDPOINT || env.S3_ENDPOINT || '').trim(),
    env.S3_INTERNAL_ENDPOINT ? 'S3_INTERNAL_ENDPOINT' : 'S3_ENDPOINT',
  );
  const explicitPublicEndpoint = endpoint(env.S3_PUBLIC_ENDPOINT?.trim(), 'S3_PUBLIC_ENDPOINT', { requireHttps: true });

  let mode = configured;
  if (mode === 'auto') {
    if (embedded) mode = 'proxy';
    else if (explicitPublicEndpoint) mode = 'presigned';
    else {
      throw new Error(
        'S3_BROWSER_TRANSPORT=auto requires S3_PUBLIC_ENDPOINT for external storage. '
        + 'Set S3_BROWSER_TRANSPORT=proxy for self-hosted proxy delivery or configure a public HTTPS S3 endpoint.',
      );
    }
  }
  if (mode === 'proxy' && cloud) {
    throw new Error('S3_BROWSER_TRANSPORT=proxy is not supported on Vercel/cloud request-duration hosting. Use presigned with S3_PUBLIC_ENDPOINT.');
  }

  const publicEndpoint = mode === 'presigned'
    ? explicitPublicEndpoint || endpoint(env.S3_ENDPOINT?.trim(), 'S3_ENDPOINT', { requireHttps: true })
    : undefined;
  if (mode === 'presigned' && !publicEndpoint) {
    throw new Error('S3_BROWSER_TRANSPORT=presigned requires S3_PUBLIC_ENDPOINT (or deprecated S3_ENDPOINT).');
  }
  if (!internalEndpoint) {
    throw new Error('S3_INTERNAL_ENDPOINT is required for server and compute-worker S3 operations (S3_ENDPOINT is a deprecated compatibility alias).');
  }

  return {
    mode,
    internalEndpoint,
    publicEndpoint,
    usesDeprecatedEndpoint: Boolean(env.S3_ENDPOINT?.trim()),
  };
}

export function applyStorageTransportEnv(env = process.env, options = {}) {
  const resolved = resolveStorageTransport(env, options);
  env.S3_INTERNAL_ENDPOINT = resolved.internalEndpoint;
  if (resolved.publicEndpoint) env.S3_PUBLIC_ENDPOINT = resolved.publicEndpoint;
  env.S3_BROWSER_TRANSPORT = resolved.mode;
  return resolved;
}
