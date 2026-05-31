import type { ReactNode } from 'react';
import Link from 'next/link';
import { getResolvedRuntimeConfigForRsc } from '@/lib/server/runtime-config-rsc';
import { buttonClass } from '@/components/ui/buttonPrimitives';
import './public.css';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = await getResolvedRuntimeConfigForRsc();
  const enableUserSignups = runtimeConfig.enableUserSignups;

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
                <Link href="/signin" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                  Sign in
                </Link>
                <Link href="/app" className={buttonClass({ variant: 'primary', size: 'sm' })}>
                  Open app
                </Link>
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
                  {enableUserSignups ? (
                    <Link href="/signup" className={buttonClass({ variant: 'outline', size: 'sm' })}>
                      Create account
                    </Link>
                  ) : null}
                  <a
                    href="https://github.com/richardr1126/openreader"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass({ variant: 'ghost', size: 'sm' })}
                  >
                    Star on GitHub
                  </a>
                </div>
              </div>

              <nav className="public-footer-cols" aria-label="Footer">
                <div className="public-footer-col">
                  <p className="public-footer-col-title">Product</p>
                  <Link href="/app">Open app</Link>
                  <Link href="/signin">Sign in</Link>
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
