import { getResolvedRuntimeConfigForRsc } from '@/lib/server/runtime-config-rsc';
import type { ReaderDemo } from './reader-demo-timeline';
import wizardOfOzTimeline from './wizard-of-oz.timeline.json';

export const WIZARD_OF_OZ_DEMO: ReaderDemo = {
  audioSrc: '/demo/wizard-of-oz.mp3',
  fileName: 'wizard-of-oz.epub',
  chapter: 'Chapter 1 · The Cyclone',
  voiceLabel: 'English · Gemini · Kore · 1.5×',
  ...wizardOfOzTimeline,
};

export const FORMATS = ['EPUB', 'PDF', 'TXT', 'MD', 'DOCX'] as const;

export const PROVIDERS = ['Kokoro', 'KittenTTS', 'Orpheus', 'OpenAI', 'Replicate', 'DeepInfra'] as const;

export const STEPS = [
  {
    title: 'Upload a document',
    body: 'Drop an EPUB, PDF, TXT, Markdown, or DOCX into your library, or import one straight from the server. It stays organized for every session after.',
  },
  {
    title: 'Pick a voice',
    body: 'Hosted OpenAI, Replicate, or DeepInfra, or your own Kokoro, KittenTTS, or Orpheus server. Set the language, choose a compatible voice, and tune the speed.',
  },
  {
    title: 'Read, listen, export',
    body: 'Follow word-level highlighting on the original page as it plays, resume on any device, and export an audiobook for the road.',
  },
] as const;

export const FEATURES = [
  {
    key: 'formats',
    kicker: 'Formats',
    title: 'Native EPUB and PDF, kept intact',
    body: 'Your file renders in a built-in EPUB and PDF reader, never flattened to plain text. Layout-aware parsing (PP-DocLayoutV3, ONNX) follows the true reading order, even in dense multi-column PDFs.',
  },
  {
    key: 'alignment',
    kicker: 'Alignment',
    title: 'Word-by-word timing',
    body: 'ONNX Whisper alignment through a JetStream-backed compute worker maps each spoken word back to the page, so the cursor tracks speech precisely.',
  },
  {
    key: 'languages',
    kicker: 'Languages',
    title: 'Multilingual narration',
    body: 'Choose a document language for language-aware narration, highlighting, and compatible voice selection.',
  },
  {
    key: 'export',
    kicker: 'Export',
    title: 'Audiobook output',
    body: 'Render m4b and mp3 files with resumable processing, ready for any offline player you already use.',
  },
  {
    key: 'sync',
    kicker: 'Sync',
    title: 'Progress that follows you',
    body: 'Reading position, queue state, and per-document settings sync across sessions and devices through your account.',
  },
  {
    key: 'stack',
    kicker: 'Backend',
    title: 'A stack you actually control',
    body: 'Embedded SeaweedFS or any S3-compatible bucket, SQLite or Postgres, Docker on amd64 or arm64, with built-in auth and automatic startup migrations.',
  },
] as const;

export const QUICK_START = [
  { kind: 'comment', text: '# run the maintained Compose example' },
  { kind: 'command', text: 'git clone https://github.com/richardr1126/openreader.git' },
  { kind: 'command', text: 'cd openreader' },
  { kind: 'comment', text: '# add first-admin credentials to .env' },
  { kind: 'command', text: 'docker compose -f examples/docker/compose.yml up -d' },
  { kind: 'comment', text: '# open the reading room' },
  { kind: 'command', text: 'open localhost:3003' },
] as const;

export async function getLandingConfig() {
  const runtimeConfig = await getResolvedRuntimeConfigForRsc();
  const isOfficial = process.env.RICHARDRDEV_PRODUCTION?.trim().toLowerCase() === 'true';
  return {
    canSignUp: runtimeConfig.signupPolicy !== 'closed',
    isOfficial,
    instanceBadge: isOfficial ? 'Official OpenReader instance' : 'Open-source document reader',
  };
}
