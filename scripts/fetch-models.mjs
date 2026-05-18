#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modelDir = path.join(process.cwd(), 'docstore', 'model');
const modelPath = path.join(modelDir, 'PP-DocLayoutV3.onnx');
const modelDataPath = path.join(modelDir, 'PP-DocLayoutV3.onnx.data');
const configPath = path.join(modelDir, 'pp-doclayoutv3.config.json');
const preprocessorPath = path.join(modelDir, 'pp-doclayoutv3.preprocessor_config.json');
const licensePath = path.join(modelDir, 'pp-doclayoutv3.LICENSE.txt');
const staticLicensePath = path.join(process.cwd(), 'src', 'lib', 'server', 'pdf-layout', 'model', 'LICENSE.txt');

const modelUrl = process.env.OPENREADER_PDF_LAYOUT_MODEL_URL
  || 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/PP-DocLayoutV3.onnx';
const modelDataUrl = process.env.OPENREADER_PDF_LAYOUT_MODEL_DATA_URL
  || 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/PP-DocLayoutV3.onnx.data';
const configUrl = process.env.OPENREADER_PDF_LAYOUT_CONFIG_URL
  || 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/config.json';
const preprocessorUrl = process.env.OPENREADER_PDF_LAYOUT_PREPROCESSOR_URL
  || 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main/preprocessor_config.json';

await mkdir(modelDir, { recursive: true });

const modelRes = await fetch(modelUrl);
if (!modelRes.ok) {
  throw new Error(`Failed to fetch model: ${modelRes.status} ${modelRes.statusText}`);
}
await writeFile(modelPath, new Uint8Array(await modelRes.arrayBuffer()));

const modelDataRes = await fetch(modelDataUrl);
if (!modelDataRes.ok) {
  throw new Error(`Failed to fetch model data: ${modelDataRes.status} ${modelDataRes.statusText}`);
}
await writeFile(modelDataPath, new Uint8Array(await modelDataRes.arrayBuffer()));

const configRes = await fetch(configUrl);
if (!configRes.ok) {
  throw new Error(`Failed to fetch config: ${configRes.status} ${configRes.statusText}`);
}
await writeFile(configPath, new Uint8Array(await configRes.arrayBuffer()));

const preprocessorRes = await fetch(preprocessorUrl);
if (!preprocessorRes.ok) {
  throw new Error(`Failed to fetch preprocessor config: ${preprocessorRes.status} ${preprocessorRes.statusText}`);
}
await writeFile(preprocessorPath, new Uint8Array(await preprocessorRes.arrayBuffer()));

const staticLicense = await import('node:fs/promises').then((m) => m.readFile(staticLicensePath));
await writeFile(licensePath, staticLicense);

console.log(`Saved model to ${modelPath}`);
