'use client';

import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import type { DesktopInstaller } from '@/lib/shared/changelog';
import { LINKS, NATIVE_APP_BYTES } from '../links';
import type { DesktopRelease } from '../release-feed';
import { PLATFORMS, PLATFORM_ORDER, formatBytes, installerLabel, pickInstaller } from '../desktop-downloads';
import { useVisitorPlatform } from '../useVisitorPlatform';

const Lit = ({ children }: { children: ReactNode }) => <mark className="lu-mark">{children}</mark>;

const DownloadGlyph = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function InstallerRow({ installer, showPlatform = false }: { installer: DesktopInstaller; showPlatform?: boolean }) {
  const label = installerLabel(installer);
  return (
    <li>
      <a href={installer.url} className="lu-dl-row">
        <span>{showPlatform ? `${PLATFORMS[installer.platform].name} · ${label}` : label}</span>
        <span className="lu-dl-size">{formatBytes(installer.size)}</span>
        <DownloadGlyph />
      </a>
    </li>
  );
}

/** The native Swift app, with its size beside the desktop build's so the difference is plain. */
function NativeMacCard({ desktopBytes }: { desktopBytes: number | null }) {
  const sizes = [
    { name: 'OpenReader for Mac', note: 'Native Swift', bytes: NATIVE_APP_BYTES },
    ...(desktopBytes ? [{ name: 'OpenReader Desktop', note: 'Full stack', bytes: desktopBytes }] : []),
  ];
  const max = Math.max(...sizes.map((s) => s.bytes));
  return (
    <section className="lu-dl-native lu-glass" aria-labelledby="lu-dl-native">
      <div>
        <p className="lu-eyebrow">On a Mac · TestFlight beta</p>
        <h2 id="lu-dl-native">Prefer a <Lit>native</Lit> Mac app?</h2>
        <p>
          OpenReader for iPhone, iPad, and Mac is a separate Swift app with on-device voices and voice cloning,
          powered by Apple&rsquo;s Core AI. No account, no data collected, and a fraction of the download.
        </p>
        <div className="lu-actions">
          <a href={LINKS.testflight} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
            Join the TestFlight beta
          </a>
          <Link href="/ios-privacy" className="lu-btn lu-btn-glass">Privacy</Link>
        </div>
      </div>
      <figure className="lu-dl-sizes">
        <figcaption className="lu-eyebrow">Download size</figcaption>
        <ul>
          {sizes.map((s) => (
            <li key={s.name} style={{ '--w': `${Math.max(4, (s.bytes / max) * 100)}%` } as CSSProperties}>
              <span><strong>{s.name}</strong> {s.note}</span>
              <b>{formatBytes(s.bytes)}</b>
              <i aria-hidden="true" />
            </li>
          ))}
        </ul>
        <p>Before voices, which either app downloads only when you choose them.</p>
      </figure>
    </section>
  );
}

export function DesktopDownloads({ latest }: { latest: DesktopRelease | null }) {
  const { os, arch } = useVisitorPlatform();
  const installers = latest?.installers ?? [];
  const desktopOs = os === 'mac' || os === 'windows' || os === 'linux' ? os : null;
  const primary = desktopOs ? pickInstaller(installers, desktopOs, arch) : null;
  const macDmg = pickInstaller(installers, 'mac', 'arm64');
  const native = <NativeMacCard desktopBytes={macDmg?.size ?? null} />;

  return (
    <>
      <div className="lu-wrap lu-dl-cta lu-in" style={{ '--d': 3 } as CSSProperties}>
        <div className="lu-actions">
          {primary ? (
            <a href={primary.url} className="lu-btn lu-btn-solid">
              <DownloadGlyph />
              Download for {PLATFORMS[primary.platform].name}
              <span className="lu-dl-btn-size">{formatBytes(primary.size)}</span>
            </a>
          ) : os === 'ios' ? (
            <a href={LINKS.testflight} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
              Get the iPhone and iPad beta
            </a>
          ) : !latest ? (
            <a href={LINKS.releases} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
              Watch GitHub releases
            </a>
          ) : null}
          <a href="#platforms" className="lu-btn lu-btn-glass">All platforms</a>
        </div>
        <p className="lu-dl-meta">
          {!latest
            ? 'The first desktop builds ship with OpenReader 5.3.0.'
            : primary
              ? `${installerLabel(primary)} · ${PLATFORMS[primary.platform].requirement}`
              : os === 'ios' || os === 'android'
                ? 'OpenReader Desktop runs on macOS, Windows, and Linux computers.'
                : `Version ${latest.version} for macOS, Windows, and Linux.`}
        </p>
      </div>

      <div className="lu-wrap lu-dl-body">
        {os === 'mac' ? native : null}

        <section id="platforms" className="lu-dl-grid" aria-label="Downloads by platform">
          {PLATFORM_ORDER.map((platform, i) => {
            const rows = installers.filter((x) => x.platform === platform);
            return (
              <article
                key={platform}
                className="lu-dl-card lu-glass lu-reveal"
                data-current={platform === desktopOs || undefined}
                style={{ '--i': i } as CSSProperties}
              >
                <header>
                  <h2>{PLATFORMS[platform].name}</h2>
                  {platform === desktopOs ? <span className="lu-dl-badge">Your system</span> : null}
                </header>
                <p>{PLATFORMS[platform].requirement}</p>
                {rows.length ? (
                  <ul>
                    {rows.map((installer) => <InstallerRow key={installer.name} installer={installer} />)}
                  </ul>
                ) : (
                  <p className="lu-dl-empty">{latest ? 'No build in this release.' : 'Arrives with 5.3.0.'}</p>
                )}
              </article>
            );
          })}
        </section>

        {os === 'mac' ? null : native}
      </div>
    </>
  );
}
