import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };

// The social cards use the default dark theme's tokens (globals.css `html.dark`),
// since an image cannot follow the viewer's theme.
export const BG = '#111111';
export const FG = '#ededed';
export const MUTED = '#a3a3a3';
export const ACCENT = '#f87171';
export const ACCENT_2 = '#eb6262';

const ASSETS = join(process.cwd(), 'src/app/(public)/og');

/** One continuous sentence tint with the spoken word stronger, as in the reader. */
export function LitSentence({ words, active, fontSize }: { words: string[]; active: number; fontSize: number }) {
  return (
    <div style={{ display: 'flex', fontSize, backgroundColor: `${ACCENT}38`, borderRadius: 4 }}>
      {words.map((word, i) => (
        <span
          key={i}
          style={{ padding: '0 6px', borderRadius: 4, backgroundColor: i === active ? `${ACCENT}8c` : 'transparent' }}
        >
          {word}
        </span>
      ))}
    </div>
  );
}

/** The card frame shared by every public page: theme glow, the logo lockup, and Figtree like the landing page. */
export async function renderCard(children: ReactNode, wordmark = 'OpenReader') {
  // Satori reads TTF/OTF/WOFF but not WOFF2, so the card ships its own Figtree files.
  const [regular, bold, heavy, logo] = await Promise.all(
    ['figtree-400.woff', 'figtree-700.woff', 'figtree-800.woff', 'logo.png'].map((f) => readFile(join(ASSETS, f))),
  );

  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 40,
          padding: '72px 80px',
          backgroundColor: BG,
          backgroundImage: `radial-gradient(circle at 12% 0%, ${ACCENT}55, transparent 45%), radial-gradient(circle at 100% 30%, ${ACCENT_2}40, transparent 45%)`,
          color: FG,
          fontFamily: 'Figtree',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 34, fontWeight: 700, letterSpacing: -0.4 }}>
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={`data:image/png;base64,${logo.toString('base64')}`} width={52} height={52} style={{ borderRadius: 14 }} />
          {wordmark}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flexGrow: 1 }}>{children}</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Figtree', data: regular, weight: 400, style: 'normal' },
        { name: 'Figtree', data: bold, weight: 700, style: 'normal' },
        { name: 'Figtree', data: heavy, weight: 800, style: 'normal' },
      ],
    },
  );
}
