import { ImageResponse } from 'next/og';

export const alt = 'OpenReader: every word, lit as it’s spoken. Read-along audio for EPUB, PDF, and DOCX.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The social card uses the default dark theme's tokens (globals.css `html.dark`),
// since an image cannot follow the viewer's theme.
const BG = '#111111';
const FG = '#ededed';
const MUTED = '#a3a3a3';
const ACCENT = '#f87171';
const ACCENT_2 = '#eb6262';

const SAMPLE = ['Dorothy', 'lived', 'in', 'the', 'midst', 'of', 'the', 'great', 'Kansas', 'prairies,'];
const ACTIVE = 4;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          backgroundColor: BG,
          backgroundImage: `radial-gradient(circle at 12% 0%, ${ACCENT}55, transparent 45%), radial-gradient(circle at 100% 30%, ${ACCENT_2}40, transparent 45%)`,
          color: FG,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 34, fontWeight: 700 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: `linear-gradient(140deg, ${ACCENT}, ${ACCENT_2})`,
            }}
          />
          OpenReader
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 92, fontWeight: 800, letterSpacing: -3, lineHeight: 1.02 }}>
            <div style={{ display: 'flex' }}>
              Every word,&nbsp;<span style={{ color: ACCENT }}>lit</span>
            </div>
            <div style={{ display: 'flex' }}>as it’s spoken.</div>
          </div>
          <div
            style={{
              display: 'flex',
              alignSelf: 'flex-start',
              padding: '22px 28px',
              borderRadius: 28,
              fontSize: 32,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.14)',
            }}
          >
            {/* One continuous sentence tint with the spoken word stronger, as in the reader. */}
            <div style={{ display: 'flex', backgroundColor: `${ACCENT}38`, borderRadius: 4 }}>
              {SAMPLE.map((word, i) => (
                <span
                  key={i}
                  style={{
                    padding: '0 6px',
                    borderRadius: 4,
                    backgroundColor: i === ACTIVE ? `${ACCENT}8c` : 'transparent',
                  }}
                >
                  {word}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 28, color: MUTED }}>
          EPUB · PDF · TXT · Markdown · DOCX  —  open source and self-hostable
        </div>
      </div>
    ),
    size,
  );
}
