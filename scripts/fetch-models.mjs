#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modelDir = path.join(process.cwd(), 'docstore', 'model');
const modelPath = path.join(modelDir, 'docling-layout-heron.onnx');
const configPath = path.join(modelDir, 'docling-layout-heron.config.json');
const licensePath = path.join(modelDir, 'docling-layout-heron.LICENSE.txt');
const staticLicensePath = path.join(process.cwd(), 'src', 'lib', 'server', 'pdf-layout', 'model', 'LICENSE.txt');

const modelUrl = process.env.OPENREADER_DOCLING_MODEL_URL || 'https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/main/model.onnx';
const configUrl = process.env.OPENREADER_DOCLING_CONFIG_URL || 'https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/main/config.json';

await mkdir(modelDir, { recursive: true });

const modelRes = await fetch(modelUrl);
if (!modelRes.ok) {
  throw new Error(`Failed to fetch model: ${modelRes.status} ${modelRes.statusText}`);
}
await writeFile(modelPath, new Uint8Array(await modelRes.arrayBuffer()));

const configRes = await fetch(configUrl);
if (!configRes.ok) {
  throw new Error(`Failed to fetch config: ${configRes.status} ${configRes.statusText}`);
}
await writeFile(configPath, new Uint8Array(await configRes.arrayBuffer()));

const staticLicense = await import('node:fs/promises').then((m) => m.readFile(staticLicensePath));
await writeFile(licensePath, staticLicense);

console.log(`Saved model to ${modelPath}`);
