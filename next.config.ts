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

const bundleWorkerCompute = true;
const serverExternalPackages = [
  '@napi-rs/canvas',
  'better-sqlite3',
  'ffmpeg-static',
  ...(!bundleWorkerCompute ? ['onnxruntime-node', '@huggingface/tokenizers'] : []),
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
  transpilePackages: [],
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
      './node_modules/onnxruntime-node/**/*',
      './node_modules/@huggingface/tokenizers/**/*',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer && bundleWorkerCompute) {
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        '@openreader/compute-core/local-runtime$': false,
        'onnxruntime-node$': false,
        '@huggingface/tokenizers$': false,
      };
    }
    return config;
  },
};

export default nextConfig;
