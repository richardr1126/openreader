import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { GithubIcon } from '@/components/icons/Icons';
import { getLandingConfig } from './landing';
import { LINKS } from './links';
import { getReleaseFeed } from './release-feed';
import './lumen.css';

const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

// Rebuilt at most once a minute so public pages stay CDN-cached while the
// sign-up links follow admin edits. Links into the app are plain anchors: the
// root layout's injected runtime config only refreshes on a full page load, so a
// client-side navigation would carry these cached values into the app.
export const revalidate = 60;

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const [{ canSignUp }, { stars }] = await Promise.all([getLandingConfig(), getReleaseFeed()]);

  return (
    <div className="lumen">
      <a href="#main" className="lu-skip">Skip to content</a>
      <div className="lu-aurora" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <header className="lu-nav">
        <div className="lu-nav-inner lu-glass">
          <Link href="/" className="lu-logo" aria-label="OpenReader home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" width="26" height="26" />
            OpenReader
          </Link>
          <nav aria-label="Primary" className="lu-nav-links">
            <a
              href={LINKS.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="lu-nav-gh"
              aria-label={stars === null ? 'Star OpenReader on GitHub' : `Star OpenReader on GitHub, ${stars.toLocaleString('en-US')} stars`}
            >
              <GithubIcon width="1.15em" height="1.15em" aria-hidden="true" />
              {stars === null ? null : (
                <span aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="12" height="12">
                    <path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z" fill="currentColor" />
                  </svg>
                  {compactCount.format(stars)}
                </span>
              )}
            </a>
            <a href={LINKS.docs}>Docs</a>
            <Link href="/download">Download</Link>
            <a href="/signin">Sign in</a>
            <a href="/app" className="lu-btn lu-btn-solid lu-btn-sm">Open app</a>
          </nav>
        </div>
      </header>

      {children}

      <footer className="lu-footer">
        <div className="lu-wrap">
          <div className="lu-footer-slab lu-glass">
            <div className="lu-footer-lede">
              <Link href="/" className="lu-logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.svg" alt="" width="26" height="26" />
                OpenReader
              </Link>
              <p>
                An open-source reading room that turns documents into synchronized, listenable audio.
                Yours to self-host.
              </p>
              <div className="lu-footer-cta">
                {canSignUp ? <a href="/signup" className="lu-btn lu-btn-glass lu-btn-sm">Sign up</a> : null}
                <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-glass lu-btn-sm">
                  Star on GitHub
                </a>
              </div>
            </div>
            <nav className="lu-footer-cols" aria-label="Footer">
              <div>
                <p>Product</p>
                <a href="/app">Open app</a>
                <Link href="/download">Download</Link>
                <a href="/signin">Sign in</a>
                <a href={LINKS.docs} target="_blank" rel="noopener noreferrer">Documentation</a>
              </div>
              <div>
                <p>Project</p>
                <a href={LINKS.readme} target="_blank" rel="noopener noreferrer">GitHub</a>
                <a href={LINKS.discussions} target="_blank" rel="noopener noreferrer">Discussions</a>
                <a href={LINKS.issues} target="_blank" rel="noopener noreferrer">Issues</a>
              </div>
              <div>
                <p>Legal</p>
                <Link href="/privacy">Privacy &amp; data</Link>
                <Link href="/desktop-privacy">Desktop app privacy</Link>
                <Link href="/ios-privacy">iPhone, iPad &amp; Mac privacy</Link>
                <a href={LINKS.license} target="_blank" rel="noopener noreferrer">MIT license</a>
              </div>
            </nav>
          </div>
          <p className="lu-footer-word" aria-hidden="true">
            {'OpenReader'.split('').map((ch, i) => (
              <span key={i} style={{ '--i': i } as CSSProperties}>{ch}</span>
            ))}
          </p>
          <p className="lu-footer-base">
            <span>© {new Date().getFullYear()} OpenReader</span>
            <span>MIT licensed · Self-host friendly</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
