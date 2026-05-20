import type { NextConfig } from "next";

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
  'ffmpeg-static',
  'better-sqlite3',
  ...(computeLocal ? ['onnxruntime-node', '@huggingface/tokenizers'] : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
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
  transpilePackages: ['@openreader/compute-core'],
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
  ...(!computeLocal
    ? {
        outputFileTracingExcludes: {
          '/*': [
            './node_modules/onnxruntime-node/**/*',
            './node_modules/@huggingface/tokenizers/**/*',
          ],
        },
      }
    : {}),
};

export default nextConfig;
