import { ACCENT, BG, FG, MUTED, LitSentence, renderCard, size } from '../og/card';

export const alt = 'OpenReader Desktop for macOS, Windows, and Linux: read-along audio, local voices, and audiobook export.';
export { size };
export const contentType = 'image/png';

const LINE = { height: 14, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.12)' };

/** A reader window bleeding off the card's edge, mid-sentence. */
function AppWindow() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 590,
        width: 640,
        height: 440,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 22,
        backgroundColor: '#1a1a1a',
        border: '1px solid rgba(255,255,255,0.16)',
        boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 18,
          color: MUTED,
        }}
      >
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <div key={c} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c }} />
        ))}
        <div style={{ display: 'flex', marginLeft: 16 }}>The Wonderful Wizard of Oz</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '34px 36px', color: FG }}>
        <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>Chapter I · The Cyclone</div>
        <div style={{ display: 'flex', alignSelf: 'flex-start' }}>
          <LitSentence words={['Dorothy', 'lived', 'in', 'the', 'midst', 'of', 'the']} active={4} fontSize={26} />
        </div>
        {[520, 560, 470, 540].map((w, i) => (
          <div key={i} style={{ ...LINE, width: w }} />
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          marginTop: 'auto',
          padding: '18px 36px 28px',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: ACCENT,
          }}
        >
          {/* Pause glyph: audio is actually playing. */}
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ width: 6, height: 18, borderRadius: 2, backgroundColor: BG }} />
            <div style={{ width: 6, height: 18, borderRadius: 2, backgroundColor: BG }} />
          </div>
        </div>
        <div style={{ display: 'flex', width: 440, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)' }}>
          <div style={{ width: 150, height: 8, borderRadius: 4, backgroundColor: ACCENT }} />
        </div>
      </div>
    </div>
  );
}

export default function DownloadOpenGraphImage() {
  return renderCard(
    [
      <AppWindow key="window" />,
      <div key="headline" style={{ display: 'flex', flexDirection: 'column', width: 520, marginTop: 'auto', fontSize: 68, fontWeight: 800, letterSpacing: -2.2, lineHeight: 1.04 }}>
        <div style={{ display: 'flex' }}>The whole</div>
        <div style={{ display: 'flex' }}>reading room,</div>
        <div style={{ display: 'flex', color: ACCENT }}>on your desktop.</div>
      </div>,
      <div key="platforms" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto', fontSize: 26, color: MUTED }}>
        <div style={{ display: 'flex', color: FG, fontWeight: 700 }}>macOS · Windows · Linux</div>
        <div style={{ display: 'flex' }}>Local voices, audiobook export, no server.</div>
      </div>,
    ],
    'OpenReader Desktop',
  );
}
