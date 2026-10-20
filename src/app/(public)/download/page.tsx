import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LINKS } from '../links';
import { getReleaseFeed } from '../release-feed';
import { PLATFORM_ORDER, formatReleaseDate } from '../desktop-downloads';
import { DesktopDownloads, InstallerRow } from './DesktopDownloads';

export const metadata: Metadata = {
  title: 'Download OpenReader Desktop',
  description:
    'OpenReader Desktop for macOS, Windows, and Linux: the full read-along reader with local voices and audiobook export, no server required.',
  alternates: { canonical: '/download' },
  robots: { index: true, follow: true },
};

export default async function DownloadPage() {
  const { desktopReleases } = await getReleaseFeed();
  const [latest = null, ...older] = desktopReleases;

  return (
    <main id="main" className="lu-main lu-dl">
      <header className="lu-wrap lu-policy-head">
        <p className="lu-pill lu-glass lu-in" style={{ '--d': 0 } as CSSProperties}>
          <span className="lu-pill-dot" aria-hidden="true" />
          {latest ? `OpenReader Desktop ${latest.version} · ${formatReleaseDate(latest.publishedAt)}` : 'OpenReader Desktop'}
        </p>
        <h1 className="lu-policy-title lu-in" style={{ '--d': 1 } as CSSProperties}>
          The whole reading room, <mark className="lu-mark">on your desktop.</mark>
        </h1>
        <p className="lu-lede lu-in" style={{ '--d': 2 } as CSSProperties}>
          Read-along audio, local voices, and audiobook export in one app, with no server, Docker, or account to
          set up. Your library stays on your computer, and new versions install themselves.
        </p>
      </header>

      <DesktopDownloads latest={latest} />

      <section className="lu-wrap lu-dl-past" aria-labelledby="lu-dl-past">
        <header>
          <h2 id="lu-dl-past" className="lu-eyebrow">Past versions</h2>
          <div className="lu-actions">
            {latest ? (
              <a href={latest.notesUrl} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-glass lu-btn-sm">
                {latest.version} release notes
              </a>
            ) : null}
            <a href={LINKS.releases} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-glass lu-btn-sm">
              All releases on GitHub
            </a>
          </div>
        </header>
        {older.length ? (
          <ol>
            {older.map((release) => (
              <li key={release.version}>
                <details className="lu-dl-release lu-glass">
                  <summary>
                    <strong>{release.version}</strong>
                    <span>{formatReleaseDate(release.publishedAt)}</span>
                  </summary>
                  <ul>
                    {PLATFORM_ORDER.flatMap((platform) =>
                      release.installers
                        .filter((i) => i.platform === platform)
                        .map((installer) => <InstallerRow key={installer.name} installer={installer} showPlatform />),
                    )}
                  </ul>
                  <a href={release.notesUrl} target="_blank" rel="noopener noreferrer" className="lu-dl-notes">
                    Release notes
                  </a>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p className="lu-dl-empty">Earlier desktop builds will be listed here.</p>
        )}
        <p className="lu-dl-foot">
          What the app sends over the network, and when, is in the{' '}
          <Link href="/desktop-privacy">desktop app privacy policy</Link>.
        </p>
      </section>
    </main>
  );
}
