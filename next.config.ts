import type { NextConfig } from "next";
import { version as appVersion } from "./package.json";

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
  // linkedom's CSS parser probes for the optional cssstyle package at runtime.
  'linkedom',
  // Keep pdfjs-dist as a real package in node_modules. Server-side preview
  // rendering resolves pdf.js runtime assets from the filesystem at runtime.
  'pdfjs-dist',
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // Inlined at build time. Importing package.json from app code makes
  // Turbopack bundle the whole manifest, scripts included.
  env: {
    OPENREADER_APP_VERSION: appVersion,
  },
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
  },
  outputFileTracingExcludes: {
    '/*': [
      './docstore/**/*',
      './node_modules/onnxruntime-node/**/*',
      './node_modules/@huggingface/tokenizers/**/*',
    ],
  },
};

export default nextConfig;
