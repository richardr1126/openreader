import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';

function isMissingBucketError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.$metadata?.httpStatusCode === 404) return true;
  return error.name === 'NotFound' || error.name === 'NoSuchBucket';
}

function parseBoolean(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createS3Client(env) {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_INTERNAL_ENDPOINT,
    forcePathStyle: parseBoolean(env.S3_FORCE_PATH_STYLE),
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

export async function ensureS3Bucket(env, client = createS3Client(env)) {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) throw new Error('S3 bucket name is required.');

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { bucket, created: false };
  } catch (error) {
    if (!isMissingBucketError(error)) throw error;
  }

  const createInput = { Bucket: bucket };
  if (env.S3_REGION && env.S3_REGION !== 'us-east-1') {
    createInput.CreateBucketConfiguration = { LocationConstraint: env.S3_REGION };
  }
  await client.send(new CreateBucketCommand(createInput));
  return { bucket, created: true };
}

function isPrivateIPv4(address) {
  if (!address) return false;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (!match) return false;
  const second = Number.parseInt(match[1], 10);
  return second >= 16 && second <= 31;
}

export function hasWeedBinary() {
  return !spawnSync('weed', ['version'], { stdio: 'ignore' }).error;
}

export function detectHostForDefaultEndpoint() {
  const ipv4 = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry && !entry.internal && String(entry.family) === 'IPv4')
    .map((entry) => entry.address);

  return ipv4.find(isPrivateIPv4) || ipv4[0] || '127.0.0.1';
}

export function resolveWeedMiniAdvertiseHost(
  bindHost,
  configuredAdvertiseHost,
  detectedHost = detectHostForDefaultEndpoint(),
) {
  const explicit = configuredAdvertiseHost?.trim();
  if (explicit) return explicit;

  const bind = bindHost?.trim() || '127.0.0.1';
  if (bind === '0.0.0.0' || bind === '::' || bind === '[::]') {
    return detectedHost;
  }
  return bind;
}

export function parseS3Endpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid S3_ENDPOINT: ${endpoint}`);
  }

  if (!url.hostname) throw new Error(`Invalid S3_ENDPOINT host: ${endpoint}`);
  const port = Number.parseInt(url.port || '8333', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid S3_ENDPOINT port: ${endpoint}`);
  }

  return {
    hostname: url.hostname,
    port,
    normalized: `${url.protocol}//${url.hostname}:${port}`,
  };
}

export function loopbackS3Endpoint(endpoint) {
  const parsed = parseS3Endpoint(endpoint);
  const url = new URL(parsed.normalized);
  return `${url.protocol}//127.0.0.1:${parsed.port}`;
}

export function parseUrlHost(urlValue, fieldName) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${urlValue}`);
  }

  if (!url.hostname) throw new Error(`Invalid ${fieldName} host: ${urlValue}`);
  return url.hostname;
}

export async function waitForEndpoint(url, timeoutSeconds, serviceName = 'service', fetchImpl = fetch) {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      if (response) return;
    } catch {
      // Retry until the startup deadline.
    } finally {
      clearTimeout(timeoutId);
    }
    await delay(1000);
  }
  throw new Error(`${serviceName} did not become ready at ${url} within ${timeoutSeconds}s.`);
}

export function isRunningInDocker() {
  if (process.platform !== 'linux') return false;
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    return /(docker|containerd|kubepods|podman)/i.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

// weed mini runs a master, filer, volume server and admin server behind its S3
// gateway. OpenReader only talks to S3, but each of these still listens, on
// ports mini fixes at these defaults unless told otherwise.
const WEED_MINI_INTERNAL_PORTS = [
  ['master.port', 9333],
  ['master.port.grpc', 19333],
  ['filer.port', 8888],
  ['filer.port.grpc', 18888],
  ['volume.port', 9340],
  ['volume.port.grpc', 19340],
  ['s3.port.grpc', 18333],
  ['admin.port', 23646],
  ['admin.port.grpc', 33646],
];

// Components OpenReader never uses. The admin server cannot be turned off, but
// without its UI it serves only health and metrics. It ignores -ip.bind and
// listens on every interface, so its UI (which has no login unless a password is
// configured) must stay off.
export const WEED_MINI_DISABLED_COMPONENTS = ['-webdav=false', '-s3.port.iceberg=0', '-admin.ui=false'];

/** Reads `key=value` lines from the mini.options file weed mini persists in its data directory. */
export function readWeedMiniOptions(dir) {
  const options = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'mini.options'), 'utf8');
  } catch {
    return options;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([\w.]+)\s*=\s*(\S+)\s*$/.exec(line);
    if (match) options.set(match[1], match[2]);
  }
  return options;
}

// OpenReader stores every object with SSE-S3. SeaweedFS before 4.26 keeps that
// key (the KEK) only on the filer, at /etc/s3/sse_kek. Since seaweedfs#9524,
// weed mini creates a random key in this file on its first start, never looks
// at the filer's, and then refuses to decrypt anything the old key wrapped.
const WEED_MINI_KEK_FILE = '.mini_sse_kek';
const FILER_KEK_PATH = '/etc/s3/sse_kek';

/**
 * Whether this data directory was last run by a weed mini that kept its SSE-S3
 * key only on the filer, so that key has to be carried into `.mini_sse_kek`
 * before a newer weed mini starts S3 here. An operator-supplied key wins.
 */
export function needsWeedMiniKekAdoption(dir, env = {}) {
  if (env.WEED_S3_SSE_KEK || env.WEED_S3_SSE_KEY) return false;
  return fs.existsSync(path.join(dir, 'mini.options'))
    && !fs.existsSync(path.join(dir, WEED_MINI_KEK_FILE));
}

/**
 * Copies the filer's SSE-S3 key into `.mini_sse_kek`, read from a weed mini
 * the caller started with S3 off (S3 startup would rewrap the key and lock out
 * the data). Without a filer key nothing was ever encrypted, so mini's own key
 * is kept.
 *
 * @param {string} dir
 * @param {string} filerUrl
 * @param {{ waitTimeout?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<boolean>} whether a filer key was adopted
 */
export async function adoptWeedMiniFilerKek(dir, filerUrl, { waitTimeout = 20, fetchImpl = fetch } = {}) {
  const keyFile = path.join(dir, WEED_MINI_KEK_FILE);
  try {
    await waitForEndpoint(filerUrl, waitTimeout, 'Embedded SeaweedFS filer', fetchImpl);
    const response = await fetchImpl(`${filerUrl}${FILER_KEK_PATH}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`the filer answered ${response.status}`);
    const kek = (await response.text()).trim();
    if (!/^[0-9a-f]{64}$/i.test(kek)) throw new Error('the filer key is not a plaintext 32-byte hex key');
    fs.writeFileSync(keyFile, kek, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    return true;
  } catch (error) {
    // Mini wrote a random key while it ran; left in place it would hide the
    // filer's key from the next start.
    fs.rmSync(keyFile, { force: true });
    throw new Error(
      `Could not carry the SeaweedFS encryption key from ${FILER_KEK_PATH} into ${keyFile}: `
      + `${error instanceof Error ? error.message : String(error)}. No stored data was changed.`,
    );
  }
}

function listenOnce(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      const bound = server.address().port;
      server.close(() => resolve(bound));
    });
  });
}

/** A port is free when it can be bound on the weed bind host and on every interface (the admin server's). */
export async function isPortFree(port, bindHost) {
  for (const host of new Set([bindHost, '0.0.0.0'])) {
    if (await listenOnce(port, host) === null) return false;
  }
  return true;
}

async function pickFreePort(bindHost) {
  for (;;) {
    const port = await listenOnce(0, bindHost);
    if (port !== null && await isPortFree(port, bindHost)) return port;
  }
}

/**
 * Chooses weed mini's internal ports. Each one keeps the value weed persisted in
 * mini.options, else mini's default, as long as it is free; a taken port moves
 * to a free one. Every choice is passed explicitly, so weed persists it and the
 * next start keeps it (the master keeps its state in a directory named after its
 * port). Another weed, Jupyter on 8888 or a second OpenReader no longer collide.
 *
 * @param {string} dir
 * @param {string} bindHost
 * @param {{
 *   reserved?: number[],
 *   isFree?: (port: number, bindHost: string) => Promise<boolean>,
 *   pickFree?: (bindHost: string) => Promise<number>,
 * }} [options]
 * @returns {Promise<Array<[string, number]>>}
 */
export async function resolveWeedMiniInternalPorts(dir, bindHost, {
  reserved = [],
  isFree = isPortFree,
  pickFree = pickFreePort,
} = {}) {
  const persisted = readWeedMiniOptions(dir);
  const taken = new Set(reserved.map(Number));
  const chosen = [];
  for (const [key, fallback] of WEED_MINI_INTERNAL_PORTS) {
    const candidates = [Number.parseInt(persisted.get(key) ?? '', 10), fallback]
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
    let port = null;
    for (const candidate of candidates) {
      if (!taken.has(candidate) && await isFree(candidate, bindHost)) {
        port = candidate;
        break;
      }
    }
    while (port === null || taken.has(port)) port = await pickFree(bindHost);
    taken.add(port);
    chosen.push([key, port]);
  }
  return chosen;
}
