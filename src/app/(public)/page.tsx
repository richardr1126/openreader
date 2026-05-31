import type { Metadata } from 'next';
import Link from 'next/link';
import { getResolvedRuntimeConfigForRsc } from '@/lib/server/runtime-config-rsc';
import { buttonClass } from '@/components/ui/buttonPrimitives';

export const metadata: Metadata = {
  title: 'Open Source Read-Along Workspace',
  description:
    'OpenReader converts EPUB, PDF, TXT, MD, and DOCX files into synchronized read-along audio with multi-provider text-to-speech support.',
  keywords:
    'OpenReader, document reader, PDF read aloud, EPUB read aloud, text to speech, OpenAI compatible TTS, self-hosted reader',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://openreader.richardr.dev',
    siteName: 'OpenReader',
    title: 'OpenReader | Read documents with synchronized audio',
    description:
      'Upload documents and turn them into a synchronized listening experience with word-level highlighting and audiobook export.',
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

export default async function LandingPage() {
  const runtimeConfig = await getResolvedRuntimeConfigForRsc();
  const enableUserSignups = runtimeConfig.enableUserSignups;

  const instanceBadge =
    process.env.RICHARDRDEV_PRODUCTION === 'true'
      ? 'Official OpenReader Instance'
      : 'Open Source Document Reader';

  return (
    <main className="public-main">
      <div className="public-wrap">
        <section className="public-panel public-hero-shell public-reveal-1">
          <article className="public-hero-panel">
            <p className="public-eyebrow">{instanceBadge}</p>
            <h1 className="public-hero-title">
              Turn static files into a <em>living read-along surface</em>.
            </h1>
            <p className="public-hero-copy">
              OpenReader is a self-host-friendly workspace for EPUB, PDF, TXT, MD, and DOCX. It combines
              synchronized speech, fast navigation, and cloud or local TTS providers so long-form reading is easier
              to sustain.
            </p>
            <div className="public-actions">
              <Link href="/app" className={buttonClass({ variant: 'primary', size: 'lg' })}>
                Open Reader Workspace
              </Link>
              <Link href="/signin" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
                Sign In
              </Link>
              {enableUserSignups ? (
                <Link href="/signup" className={buttonClass({ variant: 'outline', size: 'lg' })}>
                  Create Account
                </Link>
              ) : null}
              <Link href="https://docs.openreader.richardr.dev/" className={buttonClass({ variant: 'ghost', size: 'lg' })}>
                Read Docs
              </Link>
            </div>
            <dl className="public-meta">
              <div className="public-meta-item">
                <dt className="public-meta-label">Input formats</dt>
                <dd className="public-meta-value">EPUB, PDF, TXT, MD, DOCX</dd>
              </div>
              <div className="public-meta-item">
                <dt className="public-meta-label">Read-along</dt>
                <dd className="public-meta-value">Word-level sync highlighting</dd>
              </div>
              <div className="public-meta-item">
                <dt className="public-meta-label">Providers</dt>
                <dd className="public-meta-value">Replicate TTS and OpenAI-compatible</dd>
              </div>
              <div className="public-meta-item">
                <dt className="public-meta-label">Export</dt>
                <dd className="public-meta-value">Audiobook workflows</dd>
              </div>
            </dl>
          </article>

          <aside className="public-signal-panel" aria-label="What makes OpenReader different">
            <p className="public-signal-title">Reader pipeline</p>
            <ul className="public-signal-list">
              <li className="public-signal-item">
                <h3>Layout-aware parsing</h3>
                <p>PDF pages are parsed into structured blocks for precise highlight alignment and consistent sentence boundaries.</p>
              </li>
              <li className="public-signal-item">
                <h3>Segment preloading</h3>
                <p>Sentence-level audio segments are generated and cached, reducing stalls while you read continuously.</p>
              </li>
              <li className="public-signal-item">
                <h3>Device sync</h3>
                <p>Progress, queue state, and document settings follow your account across browser sessions and devices.</p>
              </li>
              <li className="public-signal-item">
                <h3>Self-host path</h3>
                <p>Run with Docker, pair with S3 or SeaweedFS, and plug in hosted or self-managed TTS endpoints.</p>
              </li>
            </ul>
          </aside>
        </section>

        <section className="public-section public-reveal-2" aria-labelledby="capability-heading">
          <div className="public-section-head">
            <h2 id="capability-heading">Engine room capabilities</h2>
            <p>Built for deep reading, not just playback demos.</p>
          </div>
          <div className="public-feature-grid public-rail">
            <article className="public-feature-card">
              <span className="public-feature-kicker">Parsing</span>
              <h3>Structured document understanding</h3>
              <p>Geometry-aware parsing gives stable reading order and cleaner highlighting, especially for complex PDF layouts.</p>
            </article>
            <article className="public-feature-card">
              <span className="public-feature-kicker">Alignment</span>
              <h3>ONNX-powered timing maps</h3>
              <p>Speech alignment data links each spoken unit back to text so the cursor follows naturally during playback.</p>
            </article>
            <article className="public-feature-card">
              <span className="public-feature-kicker">Providers</span>
              <h3>Cloud + self-hosted voices</h3>
              <p>Use OpenAI, DeepInfra, Replicate, or OpenAI-compatible local servers such as Kokoro or KittenTTS.</p>
            </article>
            <article className="public-feature-card">
              <span className="public-feature-kicker">Distribution</span>
              <h3>Audiobook-ready output</h3>
              <p>Export chapterized audio and keep metadata clean for downstream players, with resumable processing for large docs.</p>
            </article>
          </div>
        </section>

        <section className="public-section public-reveal-3" aria-labelledby="workflow-heading">
          <div className="public-section-head">
            <h2 id="workflow-heading">Typical workflow</h2>
            <p>Minimal friction from upload to listen.</p>
          </div>
          <div className="public-path public-rail">
            <article className="public-path-step" data-step="01">
              <h3>Drop a file</h3>
              <p>Import a document into your library and keep it organized for repeat sessions.</p>
            </article>
            <article className="public-path-step" data-step="02">
              <h3>Choose a voice stack</h3>
              <p>Pick provider, model, and speed profile tuned to your reading pace.</p>
            </article>
            <article className="public-path-step" data-step="03">
              <h3>Read, listen, export</h3>
              <p>Track progress with synchronized highlighting and export audiobook files when you need offline playback.</p>
            </article>
          </div>
        </section>

        <section className="public-panel public-callout public-reveal-3" aria-label="Open source call to action">
          <h2>Ship your own private reading stack.</h2>
          <p>
            Run OpenReader locally or deploy it for your team. The docs cover Docker setup, provider integration,
            object storage, and compute worker configuration.
          </p>
          <div className="public-actions">
            <a
              href="https://github.com/richardr1126/openreader#readme"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({ variant: 'primary', size: 'md' })}
            >
              View Repository
            </a>
            <a
              href="https://docs.openreader.richardr.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({ variant: 'outline', size: 'md' })}
            >
              Deployment Guides
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
