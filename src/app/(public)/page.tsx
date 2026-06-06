import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { getResolvedRuntimeConfigForRsc } from '@/lib/server/runtime-config-rsc';
import { ButtonAnchor, ButtonLink } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Open Source Read-Along Workspace',
  description:
    'OpenReader converts EPUB, PDF, TXT, MD, and DOCX files into multilingual, synchronized read-along audio with multi-provider text-to-speech support.',
  keywords:
    'OpenReader, document reader, multilingual text to speech, PDF read aloud, EPUB read aloud, OpenAI compatible TTS, self-hosted reader',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: process.env.BASE_URL || 'https://openreader.richardr.dev',
    siteName: 'OpenReader',
    title: 'OpenReader | Read documents with synchronized audio',
    description:
      'Upload documents and turn them into a multilingual, synchronized listening experience with word-level highlighting and audiobook export.',
    images: [
      {
        url: '/web-app-manifest-512x512.png',
        width: 512,
        height: 512,
        alt: 'OpenReader icon',
      },
    ],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

// Words that receive the looping read-along highlight sweep in the hero. This
// is the product's actual word-level highlighting, used as the page's signature.
const SWEEP = ['highlighted', 'word', 'by', 'word.'];

const PROVIDERS = ['Kokoro', 'KittenTTS', 'Orpheus', 'OpenAI', 'Replicate', 'DeepInfra'];

const FORMATS = ['EPUB', 'PDF', 'TXT', 'MD', 'DOCX'];

export default async function LandingPage() {
  const runtimeConfig = await getResolvedRuntimeConfigForRsc();
  const enableUserSignups = runtimeConfig.enableUserSignups;

  const instanceBadge =
    process.env.RICHARDRDEV_PRODUCTION === 'true'
      ? 'Official OpenReader instance'
      : 'Open-source document reader';

  return (
    <main className="public-main">
      {/* ───────────────────────────── Hero ───────────────────────────── */}
      <section className="public-hero">
        <div className="public-wrap public-hero-grid">
          <div className="public-hero-lede public-reveal-1">
            <p className="public-eyebrow">
              <span className="public-eyebrow-dot" aria-hidden="true" />
              {instanceBadge}
            </p>

            <h1 className="public-hero-title">
              Hear every document,
              <br />
              <span className="public-sweep" aria-hidden="true">
                {SWEEP.map((word, i) => (
                  <span
                    key={word + i}
                    className="public-sweep-word"
                    style={{ '--i': i } as CSSProperties}
                  >
                    {word}
                    {i < SWEEP.length - 1 ? ' ' : ''}
                  </span>
                ))}
              </span>
              <span className="public-visually-hidden">highlighted word by word.</span>
            </h1>

            <p className="public-hero-copy">
              OpenReader turns EPUB, PDF, TXT, Markdown, and DOCX into a
              synchronized read-along surface, reading your original file in a
              native viewer with multilingual text-to-speech, language-aware
              highlighting, and audiobook export. It&rsquo;s open source, and
              entirely yours to self-host.
            </p>

            <div className="public-actions">
              <ButtonLink href="/app" variant="primary" size="lg">Open the reader</ButtonLink>
              {enableUserSignups ? (
                <ButtonLink href="/signup" variant="outline" size="lg">Create account</ButtonLink>
              ) : (
                <ButtonLink href="/signin" variant="outline" size="lg">Sign in</ButtonLink>
              )}
              <ButtonAnchor href="https://docs.openreader.richardr.dev/" target="_blank" rel="noopener noreferrer" variant="ghost" size="lg">Read the docs →</ButtonAnchor>
            </div>

            <div className="public-formats" aria-label="Supported formats">
              <span className="public-formats-label">Reads</span>
              <div className="public-formats-list">
                {FORMATS.map((fmt) => (
                  <span key={fmt} className="public-format-chip">
                    {fmt}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Reader mockup: demonstrates the synchronized highlight + playback */}
          <aside className="public-reader public-reveal-2" aria-hidden="true">
            <div className="public-reader-glow" aria-hidden="true" />
            <div className="public-reader-bar">
              <span className="public-reader-dot" data-tone="a" />
              <span className="public-reader-dot" data-tone="b" />
              <span className="public-reader-dot" data-tone="c" />
              <span className="public-reader-file">wizard-of-oz.epub</span>
              <span className="public-reader-voice">English · Kokoro · af_sky</span>
            </div>

            <div className="public-reader-body">
              <p className="public-reader-chapter">Chapter 1 · The Cyclone</p>
              <p className="public-reader-text">
                Dorothy lived in the midst of the great Kansas prairies, with
                Uncle Henry, who was a farmer, and Aunt Em, who was the
                farmer&rsquo;s wife.{' '}
                <span className="public-reader-sentence">
                  Their house was small, for the lumber to build it had to be
                  carried by <span className="public-reader-word">wagon</span>{' '}
                  many miles.
                </span>{' '}
                There were four walls, a floor and a roof, which made one room.
              </p>
            </div>

            <div className="public-player">
              <button type="button" className="public-player-play" aria-label="Playing" tabIndex={-1}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="M8 5v14l11-7z" fill="currentColor" />
                </svg>
              </button>
              <div className="public-wave" aria-hidden="true">
                {Array.from({ length: 28 }).map((_, i) => (
                  <span
                    key={i}
                    className="public-wave-bar"
                    style={{ '--b': i } as CSSProperties}
                  />
                ))}
              </div>
              <span className="public-player-time">04:12 / 18:30</span>
              <span className="public-player-speed">1.1×</span>
            </div>
          </aside>
        </div>

        <div className="public-wrap">
          <div className="public-providers public-reveal-3" aria-label="Supported text-to-speech providers">
            <span className="public-providers-label">Speaks through</span>
            <div className="public-providers-track">
              {PROVIDERS.map((p) => (
                <span key={p} className="public-provider">
                  {p}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ────────────────────────── How it works ───────────────────────── */}
      <section className="public-section" aria-labelledby="how-heading">
        <div className="public-wrap">
          <div className="public-section-head">
            <p className="public-kicker">The flow</p>
            <h2 id="how-heading">From a raw file to a voice in three moves.</h2>
          </div>

          <ol className="public-steps">
            <li className="public-step">
              <span className="public-step-num">01</span>
              <h3>Upload a document</h3>
              <p>
                Drop an EPUB, PDF, TXT, Markdown, or DOCX into your library, or
                import one straight from the server, and it stays organized for
                every session after.
              </p>
            </li>
            <li className="public-step">
              <span className="public-step-num">02</span>
              <h3>Pick a voice</h3>
              <p>
                Choose a provider and model: hosted OpenAI, Replicate, or
                DeepInfra, or your own self-hosted Kokoro, KittenTTS, or Orpheus
                server. Set the document language, choose a compatible voice,
                and adjust the speed to your pace.
              </p>
            </li>
            <li className="public-step">
              <span className="public-step-num">03</span>
              <h3>Read, listen, export</h3>
              <p>
                Follow word-level highlighting right on the original page as it
                plays, pick up where you left off on any device, and export a
                chaptered m4b or mp3 audiobook for the road.
              </p>
            </li>
          </ol>
        </div>
      </section>

      {/* ──────────────────────────── Features ─────────────────────────── */}
      <section className="public-section" aria-labelledby="features-heading">
        <div className="public-wrap">
          <div className="public-section-head">
            <p className="public-kicker">Under the hood</p>
            <h2 id="features-heading">Engineered for deep reading, not playback demos.</h2>
          </div>

          <div className="public-features">
            <article className="public-feature public-feature-wide">
              <span className="public-feature-kicker">Formats</span>
              <h3>Native EPUB and PDF, kept intact</h3>
              <p>
                Your file renders in a built-in EPUB and PDF reader, never
                flattened to plain text. Layout-aware parsing (PP-DocLayoutV3,
                ONNX) maps the structure underneath, so read-along highlighting
                follows the true reading order, even in dense, multi-column
                PDFs.
              </p>
            </article>

            <article className="public-feature">
              <span className="public-feature-kicker">Alignment</span>
              <h3>Word-by-word timing</h3>
              <p>
                ONNX Whisper alignment through a JetStream-backed compute worker
                maps each spoken word back to the page, so the cursor tracks
                speech precisely.
              </p>
            </article>

            <article className="public-feature">
              <span className="public-feature-kicker">Languages</span>
              <h3>Multilingual support</h3>
              <p>
                Choose a document language for language-aware narration,
                highlighting, and compatible voice selection.
              </p>
            </article>

            <article className="public-feature">
              <span className="public-feature-kicker">Export</span>
              <h3>Audiobook output</h3>
              <p>
                Render chaptered m4b and mp3 files with resumable processing,
                ready for any offline player you already use.
              </p>
            </article>

            <article className="public-feature">
              <span className="public-feature-kicker">Sync</span>
              <h3>Progress that follows you</h3>
              <p>
                Reading position, queue state, and per-document settings sync
                across browser sessions and devices through your account.
              </p>
            </article>

            <article className="public-feature public-feature-wide">
              <span className="public-feature-kicker">Backend</span>
              <h3>A stack you actually control</h3>
              <p>
                Run on embedded SeaweedFS or any S3-compatible bucket, back it
                with SQLite or Postgres, and ship it with Docker on amd64 or
                arm64, with built-in auth and automatic startup migrations.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* ───────────────────────── Self-host CTA ───────────────────────── */}
      <section className="public-section" aria-labelledby="selfhost-heading">
        <div className="public-wrap">
          <div className="public-callout">
            <div className="public-callout-glow" aria-hidden="true" />
            <div className="public-callout-copy">
              <p className="public-kicker">Open source · MIT</p>
              <h2 id="selfhost-heading">Run your own private reading stack.</h2>
              <p className="public-callout-text">
                Deploy OpenReader for yourself or your team in minutes. The docs
                cover Docker, provider integration, object storage, and the
                external compute worker. Every piece is yours to host.
              </p>
              <div className="public-actions">
                <ButtonAnchor href="https://github.com/richardr1126/openreader#readme" target="_blank" rel="noopener noreferrer" variant="primary" size="lg">
                  View the repository
                </ButtonAnchor>
                <ButtonAnchor href="https://docs.openreader.richardr.dev/docker-quick-start" target="_blank" rel="noopener noreferrer" variant="outline" size="lg">
                  Deployment guides
                </ButtonAnchor>
              </div>
            </div>

            <div className="public-terminal" aria-hidden="true">
              <div className="public-terminal-bar">
                <span className="public-reader-dot" data-tone="a" />
                <span className="public-reader-dot" data-tone="b" />
                <span className="public-reader-dot" data-tone="c" />
                <span className="public-terminal-title">quick start</span>
              </div>
              <pre className="public-terminal-body">
                <code>
                  <span className="public-term-comment"># pull and run</span>
                  {'\n'}
                  <span className="public-term-prompt">$</span> docker run --name openreader \{'\n'}
                  {'    '}-p <span className="public-term-accent">3003:3003</span> -p{' '}
                  <span className="public-term-accent">8333:8333</span> \{'\n'}
                  {'    '}-v <span className="public-term-accent">openreader_docstore:/app/docstore</span> \{'\n'}
                  {'    '}-e BASE_URL=
                  <span className="public-term-accent">http://localhost:3003</span> \{'\n'}
                  {'    '}-e AUTH_SECRET=
                  <span className="public-term-accent">$(openssl rand -hex 32)</span> \{'\n'}
                  {'    '}-e ADMIN_EMAILS=
                  <span className="public-term-accent">you@example.com</span> \{'\n'}
                  {'    '}ghcr.io/richardr1126/openreader:latest{'\n'}
                  {'\n'}
                  <span className="public-term-comment"># open the reading room</span>
                  {'\n'}
                  <span className="public-term-prompt">$</span> open{' '}
                  <span className="public-term-accent">localhost:3003</span>
                  <span className="public-term-caret" />
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
