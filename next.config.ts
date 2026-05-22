import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'self' https://*.huggingface.co https://huggingface.co",
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const computeModeRaw = (process.env.COMPUTE_MODE || 'local').trim().toLowerCase();
const computeMode = computeModeRaw === 'none' || computeModeRaw === 'worker' || computeModeRaw === 'local'
  ? computeModeRaw
  : 'local';
const computeLocal = computeMode === 'local';
const serverExternalPackages = [
  '@napi-rs/canvas',
  'better-sqlite3',
  'ffmpeg-static',
  ...(computeLocal ? ['onnxruntime-node', '@huggingface/tokenizers'] : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
  turbopack: {
    resolveAlias: {
      canvas: '@napi-rs/canvas',
    },
  },
  transpilePackages: computeLocal ? ['@openreader/compute-core'] : [],
  serverExternalPackages,
  outputFileTracingIncludes: {
    '/api/audiobook': [
      './node_modules/ffmpeg-static/ffmpeg',
    ],
    '/api/audiobook/chapter': [
      './node_modules/ffmpeg-static/ffmpeg',
    ],
    '/api/tts/segments/ensure': [
      './node_modules/ffmpeg-static/ffmpeg',
    ],
    '/api/documents/blob/preview/ensure': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    '/api/documents/blob/preview/presign': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
    '/api/documents/blob/preview/fallback': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    ],
  },
  outputFileTracingExcludes: {
    '/*': [
      './docstore/**/*',
      ...(!computeLocal
        ? [
            './node_modules/onnxruntime-node/**/*',
            './node_modules/@huggingface/tokenizers/**/*',
          ]
        : []),
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Use runtime require to avoid adding an explicit webpack TS dependency.
      const { DefinePlugin } = require('webpack') as { DefinePlugin: new (defs: Record<string, string>) => unknown };
      config.plugins = config.plugins || [];
      config.plugins.push(
        new DefinePlugin({
          __OPENREADER_COMPUTE_MODE__: JSON.stringify(computeMode),
        }),
      );
    }
    if (isServer && !computeLocal) {
      const workerComputeEntry = path.resolve(__dirname, 'src/lib/server/compute/index.worker.ts');
      const computeIndexTs = path.resolve(__dirname, 'src/lib/server/compute/index.ts');
      const computeIndexNoExt = path.resolve(__dirname, 'src/lib/server/compute/index');
      const computeDir = path.resolve(__dirname, 'src/lib/server/compute');
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        '@/lib/server/compute$': workerComputeEntry,
        '@/lib/server/compute/index$': workerComputeEntry,
        [`${computeIndexTs}$`]: workerComputeEntry,
        [`${computeIndexNoExt}$`]: workerComputeEntry,
        [`${computeDir}$`]: workerComputeEntry,
        '@openreader/compute-core/local-runtime$': false,
        'onnxruntime-node$': false,
        '@huggingface/tokenizers$': false,
      };
    }
    return config;
  },
};

export default nextConfig;
