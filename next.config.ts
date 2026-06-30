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

const pdfjsTraceFiles = [
  './node_modules/pdfjs-dist/package.json',
  './node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  './node_modules/pdfjs-dist/standard_fonts/**/*',
];
const serverExternalPackages = [
  '@napi-rs/canvas',
  'better-sqlite3',
  'ffmpeg-static',
  // Keep pdfjs-dist as a real package in node_modules. Server-side preview
  // rendering resolves pdf.js runtime assets from the filesystem at runtime.
  'pdfjs-dist',
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
  transpilePackages: ['@openreader/database'],
  serverExternalPackages,
  outputFileTracingIncludes: {
    '/api/documents/blob/preview/ensure': [
      // pdf.js runtime assets are resolved through filesystem paths at runtime,
      // so trace them explicitly for Vercel/standalone serverless bundles.
      ...pdfjsTraceFiles,
    ],
    '/api/documents/blob/preview/presign': [
      ...pdfjsTraceFiles,
    ],
    '/api/documents/blob/preview/fallback': [
      ...pdfjsTraceFiles,
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
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        {
          canvas: 'commonjs @napi-rs/canvas',
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
