import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { LINKS, getLandingConfig } from './landing';
import './lumen.css';

// Rebuilt at most once a minute so public pages stay CDN-cached while the
// sign-up links follow admin edits. Links into the app are plain anchors: the
// root layout's injected runtime config only refreshes on a full page load, so a
// client-side navigation would carry these cached values into the app.
export const revalidate = 60;

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const { canSignUp } = await getLandingConfig();

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
            <a href={LINKS.docs}>Docs</a>
            <a href={LINKS.readme} target="_blank" rel="noopener noreferrer">GitHub</a>
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
                <Link href="/ios-privacy">iOS app privacy</Link>
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
