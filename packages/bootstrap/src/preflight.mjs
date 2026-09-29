const KNOWN_EXAMPLE_VALUES = [
  ['AUTH_SECRET', 'local-openreader-auth-secret-change-me', 'Changing AUTH_SECRET later makes saved provider API keys undecryptable until they are saved again in Settings → Admin → Providers.'],
  ['COMPUTE_CREDENTIAL_BROKER_TOKEN', 'local-credential-broker-token', 'It authorizes the worker to read provider credentials from the app.'],
  ['COMPUTE_WORKER_TOKEN', 'local-compute-token', 'It authorizes control of the compute worker.'],
];

function isBlank(value) {
  return !value || !value.trim();
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  return host === 'localhost'
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

// An address that only works from the machine running the worker: loopback, or the
// unspecified bind address, which is not something a remote browser can connect to.
function isLocalOnlyHost(hostname) {
  return isLoopbackHost(hostname) || normalizeHost(hostname) === '0.0.0.0';
}

/**
 * Evaluates startup configuration and returns every problem at once so an operator
 * can fix them in one pass instead of restarting to discover the next one.
 *
 * errors   - startup cannot continue
 * warnings - startup continues, but a feature will probably not work
 */
export function evaluateStartupConfig(env, { hasNatsBinary = true } = {}) {
  const errors = [];
  const warnings = [];
  const externalWorker = !isBlank(env.COMPUTE_WORKER_URL);

  if (isBlank(env.AUTH_SECRET)) {
    errors.push({
      message: 'AUTH_SECRET is not set.',
      fix: 'Set a stable random value (openssl rand -base64 32) and keep it the same across restarts. It also encrypts saved provider API keys.',
    });
  }

  const baseUrl = isBlank(env.BASE_URL) ? null : parseUrl(env.BASE_URL.trim());
  if (isBlank(env.BASE_URL)) {
    errors.push({
      message: 'BASE_URL is not set.',
      fix: 'Set it to the address people use to open OpenReader, for example http://localhost:3003.',
    });
  } else if (!baseUrl || !/^https?:$/.test(baseUrl.protocol)) {
    errors.push({
      message: `BASE_URL is not a valid http(s) URL: ${env.BASE_URL.trim()}`,
      fix: 'Use a full URL such as http://localhost:3003 or https://reader.example.com.',
    });
  }

  if (externalWorker) {
    for (const [name, why] of [
      ['COMPUTE_WORKER_TOKEN', 'authenticates this app to the external worker'],
      ['COMPUTE_CREDENTIAL_BROKER_TOKEN', 'authenticates the worker when it asks this app for provider credentials'],
      ['TTS_PLAYBACK_TOKEN_SECRET', 'signs the audio URLs the browser loads from the worker'],
    ]) {
      if (isBlank(env[name])) {
        errors.push({
          message: `${name} is required because COMPUTE_WORKER_URL points at an external worker.`,
          fix: `It ${why}. Generate one with openssl rand -base64 32 and set the same value on the app and the worker.`,
        });
      }
    }
  } else if (!hasNatsBinary) {
    errors.push({
      message: '`nats-server` was not found, but the embedded compute worker needs it.',
      fix: 'Use the official Docker image, install nats-server, or set COMPUTE_WORKER_URL (plus COMPUTE_WORKER_TOKEN, COMPUTE_CREDENTIAL_BROKER_TOKEN, TTS_PLAYBACK_TOKEN_SECRET) to use an external worker.',
    });
  }

  if (!isBlank(env.ADMIN_EMAILS)) {
    warnings.push({
      message: 'ADMIN_EMAILS is set but no longer used in v5.',
      fix: 'Existing administrators keep their access. Grant more in Settings → Admin → Users. On a fresh install use BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD once.',
    });
  }

  const appIsLocal = baseUrl ? isLoopbackHost(baseUrl.hostname) : true;
  const workerUrl = parseUrl((externalWorker ? env.COMPUTE_WORKER_URL : 'http://127.0.0.1:8081').trim());
  const publicUrl = isBlank(env.COMPUTE_WORKER_PUBLIC_URL) ? null : parseUrl(env.COMPUTE_WORKER_PUBLIC_URL.trim());

  const effectivePublic = publicUrl ?? workerUrl;

  if (!appIsLocal && effectivePublic && isLocalOnlyHost(effectivePublic.hostname)) {
    warnings.push({
      message: `Playback audio will be requested from ${effectivePublic.origin}, which only works in a browser on this machine.`,
      fix: 'Publish worker port 8081 and set COMPUTE_WORKER_PUBLIC_URL to an address browsers can reach, for example http://<host>:8081 (or an https URL behind your reverse proxy).',
    });
  }

  if (baseUrl?.protocol === 'https:' && effectivePublic?.protocol === 'http:' && !isLoopbackHost(effectivePublic.hostname)) {
    warnings.push({
      message: `BASE_URL is https but the playback audio URL (${effectivePublic.origin}) is http; browsers block that mixed content.`,
      fix: 'Serve the worker over https and point COMPUTE_WORKER_PUBLIC_URL at it.',
    });
  }

  if (!appIsLocal) {
    for (const [name, example, consequence] of KNOWN_EXAMPLE_VALUES) {
      if (env[name]?.trim() === example) {
        warnings.push({
          message: `${name} is still the published example value while BASE_URL is not localhost.`,
          fix: `Replace it with a private random value. ${consequence}`,
        });
      }
    }
  }

  return { errors, warnings };
}

function formatEntries(entries) {
  return entries.map(({ message, fix }) => `  - ${message}\n    ${fix}`).join('\n');
}

export function formatConfigProblems({ errors }) {
  return `OpenReader cannot start until ${errors.length === 1 ? 'this is' : 'these are'} fixed:\n${formatEntries(errors)}\n\nSee https://docs.openreader.richardr.dev/reference/environment-variables`;
}

export function formatConfigWarnings({ warnings }) {
  return `OpenReader configuration notes:\n${formatEntries(warnings)}`;
}
