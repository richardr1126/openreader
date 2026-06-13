import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

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

export async function waitForEndpoint(url, timeoutSeconds, serviceName = 'service') {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
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
