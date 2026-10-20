import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
// ports mini fixes at these defaults unless told otherwise. Each gRPC port must
// stay its HTTP port plus this offset: parts of weed (the admin's maintenance
// worker among them) derive it instead of reading the configured value.
const WEED_GRPC_PORT_OFFSET = 10000;
const WEED_MINI_INTERNAL_PORTS = [
  ['master.port', 9333],
  ['filer.port', 8888],
  ['volume.port', 9340],
  ['admin.port', 23646],
];
const MAX_PAIRED_PORT = 65535 - WEED_GRPC_PORT_OFFSET;

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

// OpenReader stores every object with SSE-S3. SeaweedFS keeps the key that
// wraps each object key (the KEK) on the filer at /etc/s3/sse_kek. Since
// seaweedfs#9524 (4.26), weed mini also writes a random KEK to .mini_sse_kek on
// its first start and refuses to serve SSE-S3 when the two differ. A data
// directory from an older weed already has a filer KEK, so its objects become
// unreadable. Mini leaves the filer's key in place (wrapped with
// .mini_kek_passphrase), so it can still be read back and made the one in
// .mini_sse_kek.
const WEED_MINI_KEK_FILE = '.mini_sse_kek';
const WEED_MINI_KEK_PASSPHRASE_FILE = '.mini_kek_passphrase';
const FILER_KEK_PATH = '/etc/s3/sse_kek';
const WRAPPED_KEK_MAGIC = Buffer.from('SWv2');
const WRAPPED_KEK_SALT_BYTES = 32;
const WRAPPED_KEK_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HEX_KEK = /^[0-9a-f]{64}$/i;

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Unwraps a KEK that weed stored as base64(`SWv2` || salt || nonce || ciphertext+tag). */
export function unwrapWeedFilerKek(wrapped, passphrase) {
  const raw = Buffer.from(wrapped, 'base64');
  const header = WRAPPED_KEK_MAGIC.length + WRAPPED_KEK_SALT_BYTES;
  if (raw.length <= header + WRAPPED_KEK_NONCE_BYTES + GCM_TAG_BYTES
    || !raw.subarray(0, WRAPPED_KEK_MAGIC.length).equals(WRAPPED_KEK_MAGIC)) {
    throw new Error('the filer key is in an unknown format');
  }
  const salt = raw.subarray(WRAPPED_KEK_MAGIC.length, header);
  const nonce = raw.subarray(header, header + WRAPPED_KEK_NONCE_BYTES);
  const sealed = raw.subarray(header + WRAPPED_KEK_NONCE_BYTES);
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(passphrase), salt, Buffer.from('kek-wrapping'), 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)),
    decipher.final(),
  ]).toString('hex');
}

/**
 * Makes `.mini_sse_kek` hold the KEK the filer already has, read from the
 * running filer. Returns true when the file changed, in which case weed must be
 * restarted to load it. An operator-supplied key or passphrase is left alone.
 *
 * @param {string} dir
 * @param {string} filerUrl
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function reconcileWeedMiniKek(dir, filerUrl, env = {}, fetchImpl = fetch) {
  if (env.WEED_S3_SSE_KEK || env.WEED_S3_SSE_KEY || env.WEED_S3_SSE_KEK_PASSPHRASE) return false;
  const keyFile = path.join(dir, WEED_MINI_KEK_FILE);
  const current = readTrimmed(keyFile);
  if (!current) return false;

  try {
    const response = await fetchImpl(`${filerUrl}${FILER_KEK_PATH}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`the filer answered ${response.status}`);
    const stored = (await response.text()).trim();
    const filerKek = HEX_KEK.test(stored)
      ? stored
      : unwrapWeedFilerKek(stored, readTrimmed(path.join(dir, WEED_MINI_KEK_PASSPHRASE_FILE)));
    if (filerKek.toLowerCase() === current.toLowerCase()) return false;
    fs.writeFileSync(keyFile, filerKek, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    return true;
  } catch (error) {
    throw new Error(
      `Could not check the SeaweedFS encryption key in ${keyFile} against ${FILER_KEK_PATH}: `
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

/** A random HTTP port whose gRPC partner is still a valid port. */
async function pickPairedPortCandidate() {
  return 10000 + crypto.randomInt(MAX_PAIRED_PORT - 10000 + 1);
}

/**
 * Chooses weed mini's internal ports. Each HTTP port keeps the value weed
 * persisted in mini.options, else mini's default, as long as it and its gRPC
 * partner are free; otherwise the pair moves together. Every choice is passed
 * explicitly, so weed persists it and the next start keeps it (the master keeps
 * its state in a directory named after its HTTP port). A persisted gRPC port is
 * never kept on its own, which repairs data directories from before pairing.
 * Another weed, Jupyter on 8888 or a second OpenReader no longer collide.
 *
 * @param {string} dir
 * @param {string} bindHost
 * @param {{
 *   s3Port?: number,
 *   reserved?: number[],
 *   isFree?: (port: number, bindHost: string) => Promise<boolean>,
 *   pickFree?: (bindHost: string) => Promise<number>,
 * }} [options]
 * @returns {Promise<Array<[string, number]>>}
 */
export async function resolveWeedMiniInternalPorts(dir, bindHost, {
  s3Port = 8333,
  reserved = [],
  isFree = isPortFree,
  pickFree = pickPairedPortCandidate,
} = {}) {
  const persisted = readWeedMiniOptions(dir);
  const taken = new Set([s3Port, ...reserved].map(Number));
  const usable = async (port) => Number.isInteger(port) && port > 0 && port <= 65535 && !taken.has(port) && await isFree(port, bindHost);
  const usablePair = async (port) => port <= MAX_PAIRED_PORT
    && await usable(port) && await usable(port + WEED_GRPC_PORT_OFFSET);

  const chosen = [];
  const claim = (key, port) => {
    taken.add(port);
    chosen.push([key, port]);
  };
  for (const [key, fallback] of WEED_MINI_INTERNAL_PORTS) {
    let port = null;
    for (const candidate of [Number.parseInt(persisted.get(key) ?? '', 10), fallback]) {
      if (await usablePair(candidate)) {
        port = candidate;
        break;
      }
    }
    while (port === null) {
      const candidate = await pickFree(bindHost);
      if (await usablePair(candidate)) port = candidate;
    }
    claim(key, port);
    claim(`${key}.grpc`, port + WEED_GRPC_PORT_OFFSET);
  }

  // The S3 gateway's HTTP port is the operator's, so only its gRPC partner is chosen here.
  let s3Grpc = s3Port + WEED_GRPC_PORT_OFFSET;
  while (!await usable(s3Grpc)) s3Grpc = await pickFree(bindHost);
  claim('s3.port.grpc', s3Grpc);
  return chosen;
}
