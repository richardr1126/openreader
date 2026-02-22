import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Read and Listen to Documents',
  description:
    'OpenReader lets you upload EPUB, PDF, TXT, MD, and DOCX files for synchronized text-to-speech reading with multi-provider TTS support.',
  keywords:
    'PDF reader, EPUB reader, text to speech, tts open ai, kokoro tts, kitten tts, OpenReader, TTS PDF reader, ebook reader, epub tts, document reader',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://openreader.richardr.dev',
    siteName: 'OpenReader',
    title: 'OpenReader | Read and Listen to Documents',
    description:
      'Upload EPUB, PDF, TXT, MD, and DOCX files, then listen with synchronized read-along playback using OpenAI-compatible TTS providers.',
    images: [
      {
        url: '/web-app-manifest-512x512.png',
        width: 512,
        height: 512,
        alt: 'OpenReader Logo',
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

export default function LandingPage() {
  return (
    <>
      <style>{`
        /* ── Hero ────────────────────────── */
        .landing-hero {
          max-width: 72rem;
          margin: 0 auto;
          padding: 3rem 1.5rem 4rem;
          text-align: center;
          animation: landing-fade-up 0.45s ease-out both;
        }
        .landing-hero-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--g-display);
          font-size: 0.72rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: var(--g-accent);
          padding: 0.4rem 1rem;
          border-radius: 2rem;
          border: 1px solid color-mix(in srgb, var(--g-accent), transparent 70%);
          background: color-mix(in srgb, var(--g-accent), transparent 92%);
          margin-bottom: 2rem;
        }
        .landing-hero h1 {
          font-family: var(--g-display);
          font-weight: 800;
          font-size: clamp(2rem, 5.5vw, 4rem);
          line-height: 1.1;
          letter-spacing: -0.03em;
          max-width: 18ch;
          margin: 0 auto 1.5rem;
        }
        .landing-hero h1 span {
          background: linear-gradient(135deg, var(--g-accent), var(--g-accent2));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .landing-hero-desc {
          font-family: var(--g-body);
          font-size: 1.1rem;
          line-height: 1.7;
          color: var(--g-muted);
          max-width: 52ch;
          margin: 0 auto 2.5rem;
        }
        .landing-hero-actions {
          display: flex;
          justify-content: center;
          gap: 0.6rem;
          flex-wrap: wrap;
        }

        /* ── Features ────────────────────── */
        .landing-features {
          max-width: 72rem;
          margin: 0 auto;
          padding: 0 1.5rem 5rem;
          display: grid;
          grid-template-columns: 1fr;
          gap: 1.25rem;
        }
        @media (min-width: 640px) {
          .landing-features {
            grid-template-columns: 1fr 1fr;
          }
        }
        @media (min-width: 1024px) {
          .landing-features {
            grid-template-columns: 1fr 1fr 1fr;
          }
        }
        .landing-feature-card {
          padding: 2rem;
          animation: landing-scale-in 0.45s ease-out both;
          transition: transform 0.3s, border-color 0.3s;
        }
        .landing-feature-card:hover {
          transform: translateY(-4px);
          border-color: color-mix(in srgb, var(--g-accent), transparent 50%);
        }
        .landing-feature-icon {
          width: 3rem; height: 3rem;
          border-radius: 0.875rem;
          background: color-mix(in srgb, var(--g-accent), transparent 85%);
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 1.25rem;
          font-size: 1.25rem;
          color: var(--g-accent);
          font-weight: 700;
          font-family: var(--g-display);
        }
        .landing-feature-card h3 {
          font-family: var(--g-display);
          font-weight: 700;
          font-size: 1.15rem;
          margin: 0 0 0.6rem;
          letter-spacing: -0.01em;
        }
        .landing-feature-card p {
          font-size: 0.92rem;
          line-height: 1.65;
          color: var(--g-muted);
        }

        /* ── TTS spotlight ────────────────── */
        .landing-tts {
          max-width: 72rem;
          margin: 0 auto;
          padding: 0 1.5rem 5rem;
          animation: landing-fade-up 0.45s ease-out both;
        }
        .landing-tts-inner {
          display: grid;
          grid-template-columns: 1fr;
          gap: 2.5rem;
          padding: 2.5rem;
        }
        @media (min-width: 768px) {
          .landing-tts-inner {
            grid-template-columns: 1fr 1fr;
          }
        }
        .landing-tts-lead h2 {
          font-family: var(--g-display);
          font-weight: 700;
          font-size: clamp(1.4rem, 3vw, 2rem);
          letter-spacing: -0.02em;
          margin: 0 0 0.75rem;
          line-height: 1.2;
        }
        .landing-tts-lead h2 span {
          background: linear-gradient(135deg, var(--g-accent), var(--g-accent2));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .landing-tts-lead > p {
          font-size: 0.95rem;
          line-height: 1.7;
          color: var(--g-muted);
        }
        .landing-tts-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }
        .landing-tts-list li {
          display: flex;
          gap: 0.75rem;
          align-items: flex-start;
        }
        .landing-tts-list-icon {
          flex-shrink: 0;
          width: 2rem;
          height: 2rem;
          border-radius: 0.5rem;
          background: color-mix(in srgb, var(--g-accent), transparent 85%);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--g-accent);
          font-size: 0.85rem;
          font-weight: 700;
          font-family: var(--g-display);
          margin-top: 0.1rem;
        }
        .landing-tts-list h4 {
          font-family: var(--g-display);
          font-weight: 600;
          font-size: 0.92rem;
          margin: 0 0 0.2rem;
        }
        .landing-tts-list p {
          font-size: 0.84rem;
          line-height: 1.55;
          color: var(--g-muted);
          margin: 0;
        }

        /* ── Formats ribbon ──────────────── */
        .landing-formats {
          max-width: 72rem;
          margin: 0 auto;
          padding: 0 1.5rem 5rem;
          text-align: center;
          animation: landing-fade-up 0.45s ease-out both;
        }
        .landing-formats-label {
          font-family: var(--g-display);
          font-size: 0.72rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--g-muted);
          margin-bottom: 1.25rem;
        }
        .landing-formats-row {
          display: flex;
          justify-content: center;
          gap: 0.6rem;
          flex-wrap: wrap;
        }
        .landing-format-pill {
          font-family: var(--g-display);
          font-weight: 600;
          font-size: 0.82rem;
          padding: 0.5rem 1.25rem;
          border-radius: 2rem;
          background: color-mix(in srgb, var(--g-surface), transparent 30%);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid color-mix(in srgb, var(--g-border), transparent 50%);
          transition: border-color 0.25s, transform 0.2s;
          cursor: default;
        }
        .landing-format-pill:hover {
          border-color: var(--g-accent);
          transform: translateY(-2px);
        }

        /* ── CTA section ─────────────────── */
        .landing-cta {
          max-width: 48rem;
          margin: 0 auto;
          padding: 0 1.5rem 5rem;
          animation: landing-fade-up 0.45s ease-out both;
        }
        .landing-cta-card {
          padding: 3rem 2rem;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .landing-cta-glow {
          position: absolute;
          width: 200px; height: 200px;
          border-radius: 50%;
          background: var(--g-accent);
          filter: blur(80px);
          opacity: 0.08;
          top: -50px; right: -50px;
          pointer-events: none;
        }
        .landing-cta-card h2 {
          font-family: var(--g-display);
          font-weight: 700;
          font-size: clamp(1.4rem, 3vw, 2rem);
          letter-spacing: -0.02em;
          margin: 0 0 0.6rem;
          position: relative;
        }
        .landing-cta-card > p {
          font-size: 0.95rem;
          color: var(--g-muted);
          margin-bottom: 2rem;
          max-width: 40ch;
          margin-left: auto;
          margin-right: auto;
          position: relative;
        }
        .landing-cta-actions {
          display: flex;
          justify-content: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          position: relative;
        }
      `}</style>

      {/* ── HERO ───────────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-badge">
          {process.env.RICHARDRDEV_PRODUCTION === 'true'
            ? "Official OpenReader Instance"
            : "Open Source Document Reader"
          }
        </div>
        <h1>
          Your documents, <span>read&nbsp;aloud</span>
        </h1>
        <p className="landing-hero-desc">
          Upload EPUB, PDF, TXT, MD, and DOCX files, then listen with your
          preferred OpenAI-compatible TTS provider. Your reading progress
          syncs across devices automatically.
        </p>
        <div className="landing-hero-actions">
          <Link href="/app" className="landing-btn landing-btn-accent">
            Open App
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
          </Link>
          <Link href="/signin" className="landing-btn landing-btn-ghost">Sign In</Link>
          <Link href="/signup" className="landing-btn landing-btn-ghost">Sign Up</Link>
          <Link href="https://docs.openreader.richardr.dev/" className="landing-btn landing-btn-ghost">Docs</Link>
        </div>
      </section>

      {/* ── FEATURES ───────────────── */}
      <section className="landing-features">
        <div className="landing-feature-card landing-panel">
          <div className="landing-feature-icon" aria-hidden="true">&uarr;</div>
          <h3>Upload documents</h3>
          <p>
            Drag and drop EPUB, PDF, TXT, Markdown, or DOCX files directly
            into the app. Documents process instantly for reading and
            text-to-speech playback.
          </p>
        </div>
        <div className="landing-feature-card landing-panel">
          <div className="landing-feature-icon" aria-hidden="true">&para;</div>
          <h3>Your library</h3>
          <p>
            Build a personal library with folders. Documents sync
            automatically so your collection is always within
            reach.
          </p>
        </div>
        <div className="landing-feature-card landing-panel">
          <div className="landing-feature-icon" aria-hidden="true">&harr;</div>
          <h3>Cross-device sync</h3>
          <p>
            Reading progress, preferences, and library state sync across
            devices. Pick up exactly where you left off on any browser.
          </p>
        </div>
      </section>

      {/* ── TTS SPOTLIGHT ──────────── */}
      <section className="landing-tts">
        <div className="landing-tts-inner landing-panel">
          <div className="landing-tts-lead">
            <h2>
              <span>Text-to-speech</span> that follows along as you read
            </h2>
            <p>
              OpenReader highlights every word as it&rsquo;s spoken, turning
              any document into a synchronized read-along experience. Connect
              any OpenAI-compatible TTS provider &mdash; including Kokoro,
              KittenTTS, Deepinfra, or your own self-hosted endpoint.
            </p>
          </div>
          <ul className="landing-tts-list">
            <li>
              <span className="landing-tts-list-icon" aria-hidden="true">&bull;</span>
              <div>
                <h4>Word-level highlighting</h4>
                <p>Each word lights up in sync with the audio so you never lose your place.</p>
              </div>
            </li>
            <li>
              <span className="landing-tts-list-icon" aria-hidden="true">&bull;</span>
              <div>
                <h4>Multiple voices &amp; providers</h4>
                <p>Choose from dozens of voices across OpenAI, Kokoro, KittenTTS, Deepinfra, or any compatible endpoint.</p>
              </div>
            </li>
            <li>
              <span className="landing-tts-list-icon" aria-hidden="true">&bull;</span>
              <div>
                <h4>Speed controls</h4>
                <p>Independent model speed and playback speed sliders from 0.5x to 3x.</p>
              </div>
            </li>
            <li>
              <span className="landing-tts-list-icon" aria-hidden="true">&bull;</span>
              <div>
                <h4>Audiobook export</h4>
                <p>Convert any document to a downloadable MP3 or M4A audiobook with chapter metadata.</p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      {/* ── FORMATS ────────────────── */}
      <section className="landing-formats">
        <p className="landing-formats-label">Supported formats</p>
        <div className="landing-formats-row">
          <span className="landing-format-pill">EPUB</span>
          <span className="landing-format-pill">PDF</span>
          <span className="landing-format-pill">TXT</span>
          <span className="landing-format-pill">MD</span>
          <span className="landing-format-pill">DOCX</span>
        </div>
      </section>

      {/* ── CTA ────────────────────── */}
      <section className="landing-cta">
        <div className="landing-cta-card landing-panel">
          <div className="landing-cta-glow" aria-hidden="true" />
          <h2>Start reading now</h2>
          <p>
            Open the app and upload a document to begin.
            Your progress syncs across devices automatically.
          </p>
          <div className="landing-cta-actions">
            <Link href="/app" className="landing-btn landing-btn-accent">Open App</Link>
            <Link href="/signin" className="landing-btn landing-btn-ghost">Sign In</Link>
            <Link href="/signup" className="landing-btn landing-btn-ghost">Sign Up</Link>
            <Link href="https://docs.openreader.richardr.dev/" className="landing-btn landing-btn-ghost">Docs</Link>
          </div>
        </div>
      </section>
    </>
  );
}
