import type { ReactNode } from 'react';
import Link from 'next/link';
import { getResolvedRuntimeConfigForRsc } from '@/lib/server/runtime-config-rsc';
import { ButtonAnchor } from '@/components/ui';
import './public.css';

// Rebuilt at most once a minute so public pages stay CDN-cached while the
// sign-up links follow admin edits. Links into the app are plain anchors: the
// root layout's injected runtime config only refreshes on a full page load, so a
// client-side navigation would carry these cached values into the app.
export const revalidate = 60;

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = await getResolvedRuntimeConfigForRsc();
  const canSignUp = runtimeConfig.signupPolicy !== 'closed';

  return (
    <div className="public-shell">
      <div className="public-aurora" aria-hidden="true" />
      <div className="public-grain" aria-hidden="true" />

      <div className="public-frame">
        <div className="public-topbar">
          <div className="public-wrap">
            <header className="public-topbar-inner public-reveal-1">
              <Link href="/" className="public-brand" aria-label="OpenReader home">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.svg" alt="" className="public-brand-mark" aria-hidden="true" />
                <span className="public-brand-copy">
                  <span className="public-brand-text">OpenReader</span>
                  <span className="public-brand-tag">Read&nbsp;·&nbsp;Listen</span>
                </span>
              </Link>

              <nav className="public-nav" aria-label="Primary">
                <Link
                  href="https://docs.openreader.richardr.dev/"
                  className="public-nav-link"
                >
                  Docs
                </Link>
                <a
                  href="https://github.com/richardr1126/openreader#readme"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="public-nav-link"
                >
                  GitHub
                </a>
                <span className="public-nav-divider" aria-hidden="true" />
                <ButtonAnchor href="/signin" variant="ghost" size="sm">Sign in</ButtonAnchor>
                <ButtonAnchor href="/app" variant="primary" size="sm">Open app</ButtonAnchor>
              </nav>
            </header>
          </div>
        </div>

        {children}

        <footer className="public-footer">
          <div className="public-wrap">
            <div className="public-footer-inner">
              <div className="public-footer-brand">
                <div className="public-footer-mark">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/icon.svg" alt="" className="public-brand-mark" aria-hidden="true" />
                  <span className="public-brand-text">OpenReader</span>
                </div>
                <p className="public-footer-label">
                  An open-source reading room that turns documents into
                  synchronized, listenable audio that&rsquo;s yours to self-host.
                </p>
                <div className="public-footer-cta">
                  {canSignUp ? (
                    <ButtonAnchor href="/signup" variant="outline" size="sm">Sign up</ButtonAnchor>
                  ) : null}
                  <ButtonAnchor href="https://github.com/richardr1126/openreader" target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">
                    Star on GitHub
                  </ButtonAnchor>
                </div>
              </div>

              <nav className="public-footer-cols" aria-label="Footer">
                <div className="public-footer-col">
                  <p className="public-footer-col-title">Product</p>
                  <a href="/app">Open app</a>
                  <a href="/signin">Sign in</a>
                  <a href="https://docs.openreader.richardr.dev/" target="_blank" rel="noopener noreferrer">
                    Documentation
                  </a>
                </div>
                <div className="public-footer-col">
                  <p className="public-footer-col-title">Project</p>
                  <a href="https://github.com/richardr1126/openreader#readme" target="_blank" rel="noopener noreferrer">
                    GitHub
                  </a>
                  <a href="https://github.com/richardr1126/openreader/discussions" target="_blank" rel="noopener noreferrer">
                    Discussions
                  </a>
                  <a href="https://github.com/richardr1126/openreader/issues" target="_blank" rel="noopener noreferrer">
                    Issues
                  </a>
                </div>
                <div className="public-footer-col">
                  <p className="public-footer-col-title">Legal</p>
                  <Link href="/privacy">Privacy &amp; data</Link>
                  <Link href="/ios-privacy">iOS app privacy</Link>
                  <a href="https://github.com/richardr1126/openreader/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
                    MIT license
                  </a>
                </div>
              </nav>
            </div>

            <div className="public-footer-base">
              <div className="prism-divider" />
              <p>© {new Date().getFullYear()} OpenReader · MIT licensed · Self-host friendly</p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
