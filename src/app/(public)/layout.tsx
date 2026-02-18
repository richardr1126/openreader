import type { ReactNode } from 'react';
import Link from 'next/link';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{`
        /* ── Keyframes ───────────────────── */
        @keyframes landing-drift {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(15px, -10px) scale(1.03); }
          66% { transform: translate(-10px, 8px) scale(0.97); }
        }
        @keyframes landing-fade-up {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes landing-scale-in {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }

        /* ── Root ────────────────────────── */
        .landing {
          --g-display: var(--font-display), system-ui, -apple-system, sans-serif;
          --g-body: var(--font-display), -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
          --g-system: var(--font-display), -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
          --g-bg: var(--background);
          --g-fg: var(--foreground);
          --g-surface: var(--base);
          --g-border: var(--offbase);
          --g-accent: var(--accent);
          --g-accent2: var(--secondary-accent);
          --g-muted: var(--muted);
          font-family: var(--g-body);
          background: var(--g-bg);
          color: var(--g-fg);
          min-height: 100vh;
          overflow-x: hidden;
          position: relative;
        }

        /* ── Ambient orbs ────────────────── */
        .landing-orbs {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
        }
        .landing-orb {
          position: absolute;
          border-radius: 50%;
          filter: blur(100px);
          opacity: 0.12;
          animation: landing-drift 20s ease-in-out infinite;
        }
        .landing-orb-1 {
          width: 500px; height: 500px;
          background: var(--g-accent);
          top: -10%; left: -8%;
          animation-delay: 0s;
        }
        .landing-orb-2 {
          width: 400px; height: 400px;
          background: var(--g-accent2);
          top: 40%; right: -12%;
          animation-delay: -7s;
        }
        .landing-orb-3 {
          width: 350px; height: 350px;
          background: var(--g-accent);
          bottom: -5%; left: 30%;
          animation-delay: -14s;
        }

        /* ── Content wrapper ─────────────── */
        .landing-content {
          position: relative;
          z-index: 1;
        }

        /* ── Glass panel ─────────────────── */
        .landing-panel {
          background: color-mix(in srgb, var(--g-surface), transparent 30%);
          backdrop-filter: blur(24px) saturate(1.4);
          -webkit-backdrop-filter: blur(24px) saturate(1.4);
          border: 1px solid color-mix(in srgb, var(--g-border), transparent 50%);
          border-radius: 1.25rem;
        }

        /* ── Sticky header wrapper ───────── */
        .landing-header-wrap {
          position: sticky;
          top: 0;
          z-index: 100;
          padding: 1rem 1.5rem 0;
          max-width: 72rem;
          margin: 0 auto;
          animation: landing-fade-up 0.6s ease-out both;
        }

        /* ── Header ──────────────────────── */
        .landing-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.5rem;
          flex-wrap: wrap;
          gap: 0.75rem;
          box-shadow: 0 2px 16px color-mix(in srgb, var(--g-bg), transparent 40%);
        }
        .landing-logo {
          font-family: var(--g-display);
          font-weight: 700;
          font-size: 1.15rem;
          letter-spacing: -0.02em;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          text-decoration: none;
          color: var(--g-fg);
        }
        .landing-logo-icon {
          width: 20px;
          height: 20px;
        }
        .landing-header-nav {
          display: flex;
          gap: 0.35rem;
          flex-wrap: wrap;
        }
        .landing-header-nav a {
          font-family: var(--g-system);
          font-size: 0.75rem;
          font-weight: 500;
          padding: 0.25rem 0.5rem;
          border-radius: 0.375rem;
          border: 1px solid var(--g-border);
          background: var(--g-surface);
          text-decoration: none;
          color: var(--g-fg);
          transform: translateZ(0);
          transition: all 200ms ease-in-out;
        }
        .landing-header-nav a:hover {
          background: var(--g-border);
          transform: scale(1.09);
          color: var(--g-accent);
        }
        .landing-header-nav a:focus {
          outline: none;
          box-shadow: 0 0 0 2px var(--g-accent), 0 0 0 4px var(--g-bg);
        }
        .landing-header-nav a.landing-primary {
          background: var(--g-accent);
          color: var(--g-bg);
          border-color: var(--g-accent);
          font-weight: 500;
        }
        .landing-header-nav a.landing-primary:hover {
          background: var(--g-accent2);
          border-color: var(--g-accent2);
          color: var(--g-bg);
          transform: scale(1.09);
        }

        /* ── Buttons ─────────────────────── */
        .landing-btn {
          font-family: var(--g-system);
          font-size: 0.875rem;
          font-weight: 500;
          padding: 0.5rem 1rem;
          border-radius: 0.5rem;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          transform: translateZ(0);
          transition: transform 200ms ease-in-out, background 200ms, box-shadow 200ms;
        }
        .landing-btn:hover {
          transform: scale(1.02);
        }
        .landing-btn:focus {
          outline: none;
          box-shadow: 0 0 0 2px var(--g-accent), 0 0 0 4px var(--g-bg);
        }
        .landing-btn-accent {
          background: var(--g-accent);
          color: var(--g-bg);
        }
        .landing-btn-accent:hover {
          background: var(--g-accent2);
        }
        .landing-btn-ghost {
          color: var(--g-fg);
          background: var(--g-surface);
          border: 1px solid var(--g-border);
        }
        .landing-btn-ghost:hover {
          background: var(--g-border);
          color: var(--g-accent);
        }

        /* ── Footer ──────────────────────── */
        .landing-footer {
          text-align: center;
          padding: 2rem 1.5rem 3rem;
          font-family: var(--g-display);
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--g-muted);
          letter-spacing: 0.05em;
          position: relative;
          z-index: 1;
        }
        .landing-footer-inner {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 0.4rem 0;
        }
        .landing-footer-dot {
          display: inline-block;
          width: 4px; height: 4px;
          border-radius: 50%;
          background: var(--g-accent);
          margin: 0 0.6rem;
          vertical-align: middle;
          opacity: 0.6;
        }
        .landing-footer a {
          color: var(--g-muted);
          text-decoration: none;
          transition: color 0.2s;
        }
        .landing-footer a:hover {
          color: var(--g-fg);
        }
        .landing-footer-link-dotted {
          text-decoration: underline;
          text-decoration-style: dotted;
          text-underline-offset: 3px;
        }
        .landing-footer-link-bold {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-weight: 600;
        }

        @media (prefers-reduced-motion: reduce) {
          .landing * {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>

      <div className="landing">
        {/* ── Ambient orbs ────────────── */}
        <div className="landing-orbs" aria-hidden="true">
          <div className="landing-orb landing-orb-1" />
          <div className="landing-orb landing-orb-2" />
          <div className="landing-orb landing-orb-3" />
        </div>

        <div className="landing-content">
          {/* ── HEADER ─────────────────── */}
          <div className="landing-header-wrap">
            <header className="landing-header landing-panel">
              <Link href="/" className="landing-logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.svg" alt="" className="landing-logo-icon" aria-hidden="true" />
                OpenReader
              </Link>
              <nav className="landing-header-nav">
                <Link href="/app" className="landing-primary">Open App</Link>
                <Link href="/signin">Sign In</Link>
                <Link href="/signup">Sign Up</Link>
                <Link href="https://docs.openreader.richardr.dev/">Docs</Link>
              </nav>
            </header>
          </div>

          {/* ── PAGE CONTENT ───────────── */}
          {children}

          {/* ── FOOTER ─────────────────── */}
          <footer className="landing-footer">
            <div className="landing-footer-inner">
              <a
                href="https://github.com/richardr1126/OpenReader-WebUI#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="landing-footer-link-bold"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z"/></svg>
                Self host
              </a>
              <span className="landing-footer-dot" />
              <Link href="/privacy" className="landing-footer-link-bold">
                Privacy
              </Link>
              <span className="landing-footer-dot" />
              <span>
                Powered by{' '}
                <a
                  href="https://huggingface.co/hexgrad/Kokoro-82M"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="landing-footer-link-dotted"
                >
                  hexgrad/Kokoro-82M
                </a>
                {' '}and{' '}
                <a
                  href="https://deepinfra.com/models?type=text-to-speech"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="landing-footer-link-dotted"
                >
                  Deepinfra
                </a>
              </span>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}
