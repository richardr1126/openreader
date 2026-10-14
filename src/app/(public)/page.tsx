import type { CSSProperties, ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getSiteOrigin } from '@/lib/shared/urls';
import {
  FEATURES,
  FORMATS,
  LINKS,
  PROVIDERS,
  QUICK_START,
  STEPS,
  WIZARD_OF_OZ_DEMO,
  getLandingConfig,
} from './landing';
import { FeatureVisual } from './FeatureVisual';
import { ReaderDemo } from './ReaderDemo';
import { Spotlight } from './Spotlight';

const TITLE = 'OpenReader · Read-along text-to-speech for EPUB, PDF, and DOCX';
const DESCRIPTION =
  'Open-source, self-hostable document reader that turns EPUB, PDF, TXT, Markdown, and DOCX into multilingual read-along audio with word-by-word highlighting and audiobook export.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  keywords: [
    'OpenReader',
    'read along',
    'text to speech',
    'EPUB read aloud',
    'PDF read aloud',
    'word highlighting',
    'audiobook export',
    'self-hosted reader',
    'OpenAI compatible TTS',
    'Kokoro TTS',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: 'OpenReader',
    title: 'OpenReader · Every word, lit as it’s spoken',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OpenReader · Every word, lit as it’s spoken',
    description: DESCRIPTION,
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

const HEADLINE = ['Every', 'word,', 'lit', 'as', 'it’s', 'spoken.'];
const LIT_WORD = 2;

/** A phrase that receives the reader's highlight as the heading scrolls into view. */
const Lit = ({ children }: { children: ReactNode }) => <mark className="lu-mark">{children}</mark>;

function structuredData(origin: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: origin,
        name: 'OpenReader',
        description: DESCRIPTION,
      },
      {
        '@type': 'SoftwareApplication',
        name: 'OpenReader',
        url: origin,
        description: DESCRIPTION,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Web, Docker (amd64, arm64)',
        isAccessibleForFree: true,
        license: LINKS.license,
        sameAs: [LINKS.repo],
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        featureList: [
          'Read-along audio for EPUB, PDF, TXT, Markdown, and DOCX',
          'Word-by-word highlighting from forced alignment',
          'Multilingual narration',
          'Audiobook export to m4b and mp3',
          'Self-hosted with Docker',
        ],
      },
    ],
  };
}

export default async function LandingPage() {
  const { canSignUp, instanceBadge } = await getLandingConfig();
  const jsonLd = JSON.stringify(structuredData(getSiteOrigin())).replace(/</g, '\\u003c');

  return (
    <main id="main" className="lu-main">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="lu-hero" aria-labelledby="lu-title">
        <div className="lu-wrap lu-hero-copy">
          <p className="lu-pill lu-glass lu-in" style={{ '--d': 0 } as CSSProperties}>
            <span className="lu-pill-dot" aria-hidden="true" />
            {instanceBadge}
          </p>
          <h1 id="lu-title" className="lu-title lu-in" style={{ '--d': 1 } as CSSProperties}>
            <span className="lu-sr">Every word, lit as it’s spoken.</span>
            {HEADLINE.map((word, i) => (
              <span key={i} aria-hidden="true">
                {i > 0 ? ' ' : null}
                <span
                  className={i === LIT_WORD ? 'lu-k lu-k-lit' : 'lu-k'}
                  style={{ '--i': i } as CSSProperties}
                >
                  {word}
                </span>
              </span>
            ))}
          </h1>
          <p className="lu-lede lu-in" style={{ '--d': 2 } as CSSProperties}>
            OpenReader turns EPUB, PDF, TXT, Markdown, and DOCX into synchronized read-along audio,
            highlighting every word on your original page as it&rsquo;s spoken. Multilingual, open source,
            self-hostable.
          </p>
          <div className="lu-actions lu-in" style={{ '--d': 3 } as CSSProperties}>
            <a href="/app" className="lu-btn lu-btn-solid">Open the reader</a>
            {canSignUp ? (
              <a href="/signup" className="lu-btn lu-btn-glass">Create account</a>
            ) : (
              <a href="/signin" className="lu-btn lu-btn-glass">Sign in</a>
            )}
          </div>
        </div>

        <div className="lu-wrap lu-stage-wrap lu-in" style={{ '--d': 4 } as CSSProperties}>
          <ul className="lu-floaters" aria-hidden="true">
            {FORMATS.map((f, i) => (
              <li key={f} className="lu-glass" style={{ '--i': i } as CSSProperties}>.{f.toLowerCase()}</li>
            ))}
          </ul>
          <ReaderDemo demo={WIZARD_OF_OZ_DEMO} />
        </div>
      </section>

      {/* ── Steps ────────────────────────────────────────────────── */}
      <section className="lu-section" aria-labelledby="lu-steps">
        <div className="lu-wrap">
          <header className="lu-head lu-reveal">
            <p className="lu-eyebrow">How it works</p>
            <h2 id="lu-steps">From file to <Lit>voice</Lit> in three steps.</h2>
          </header>
          <ol className="lu-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="lu-glass lu-reveal" style={{ '--i': i } as CSSProperties}>
                <span className="lu-step-num" aria-hidden="true">{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────── */}
      <section className="lu-section" aria-labelledby="lu-features">
        <div className="lu-wrap">
          <header className="lu-head lu-reveal">
            <p className="lu-eyebrow">Under the hood</p>
            <h2 id="lu-features">Made for <Lit>deep reading.</Lit></h2>
          </header>
          <div className="lu-seq">
            <Spotlight className="lu-tiles">
              {FEATURES.map((f, i) => (
                <article
                  key={f.key}
                  className={`lu-tile lu-tile-${f.key} lu-glass lu-reveal`}
                  style={{ '--i': i } as CSSProperties}
                >
                  <FeatureVisual kind={f.key} />
                  <p className="lu-eyebrow">{f.kicker}</p>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </article>
              ))}
            </Spotlight>
          </div>
        </div>
      </section>

      {/* ── Orbit ────────────────────────────────────────────────── */}
      <section className="lu-section" aria-labelledby="lu-orbit">
        <div className="lu-wrap lu-orbit-grid">
          <div className="lu-reveal">
            <p className="lu-eyebrow">Formats &amp; voices</p>
            <h2 id="lu-orbit">Five formats in. <Lit>Any voice</Lit> out.</h2>
            <p className="lu-lede">
              Read {FORMATS.join(', ')} natively. Narrate with hosted providers or a speech server you
              run yourself: {PROVIDERS.join(', ')}.
            </p>
          </div>
          <div className="lu-orbit-stage" aria-hidden="true">
            <div className="lu-orbit">
              <span className="lu-orb lu-glass">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.svg" alt="" />
              </span>
              <ul className="lu-ring lu-ring-in" style={{ '--n': FORMATS.length } as CSSProperties}>
                {FORMATS.map((f, i) => (
                  <li key={f} style={{ '--i': i } as CSSProperties}>
                    <span className="lu-glass">{f}</span>
                  </li>
                ))}
              </ul>
              <ul className="lu-ring lu-ring-out" style={{ '--n': PROVIDERS.length } as CSSProperties}>
                {PROVIDERS.map((p, i) => (
                  <li key={p} style={{ '--i': i } as CSSProperties}>
                    <span className="lu-glass">{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── iOS ──────────────────────────────────────────────────── */}
      <section className="lu-section" aria-labelledby="lu-ios">
        <div className="lu-wrap">
          <div className="lu-ios lu-glass lu-reveal">
            <div className="lu-ios-copy">
              <p className="lu-eyebrow">iPhone + iPad · Beta</p>
              <h2 id="lu-ios">OpenReader for iOS, <Lit>entirely on-device.</Lit></h2>
              <p>
                Several voice models and voice cloning, powered by Apple&rsquo;s Core AI. No account, no
                analytics, no data collected.
              </p>
              <div className="lu-actions">
                <a href={LINKS.testflight} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
                  Join the TestFlight beta
                </a>
                <Link href="/ios-privacy" className="lu-btn lu-btn-glass">iOS privacy</Link>
              </div>
            </div>
            <div className="lu-phone" aria-hidden="true">
              <span className="lu-phone-island" />
              {['82%', '64%', '90%', '48%', '76%'].map((w, i) => (
                <span key={i} className="lu-phone-line" style={{ '--w': w, '--i': i } as CSSProperties} />
              ))}
              <span className="lu-phone-pill lu-glass">
                <i />
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Self-host ────────────────────────────────────────────── */}
      <section className="lu-section" aria-labelledby="lu-host">
        <div className="lu-wrap lu-host">
          <div className="lu-reveal">
            <p className="lu-eyebrow">Open source · MIT</p>
            <h2 id="lu-host">Host it <Lit>yourself.</Lit></h2>
            <p className="lu-lede">
              Deploy for yourself or your team in minutes. The docs cover Docker, provider integration,
              object storage, and the external compute worker.
            </p>
            <div className="lu-actions">
              <a href={LINKS.readme} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
                View the repository
              </a>
              <a href={LINKS.deploy} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-glass">
                Deployment guides
              </a>
            </div>
          </div>
          <figure className="lu-term lu-glass lu-reveal" aria-label="Quick start commands">
            <figcaption>
              <span aria-hidden="true"><i /><i /><i /></span>
              Terminal
            </figcaption>
            <pre>
              <code>
                {QUICK_START.map((line, i) => (
                  <span
                    key={i}
                    className={line.kind === 'comment' ? 'lu-term-line lu-term-c' : 'lu-term-line'}
                    style={{ '--i': i, '--n': QUICK_START.length } as CSSProperties}
                  >
                    {line.kind === 'command' ? <b aria-hidden="true">$ </b> : null}
                    {line.text}
                    {'\n'}
                  </span>
                ))}
              </code>
            </pre>
          </figure>
        </div>
      </section>
    </main>
  );
}
