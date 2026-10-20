import { ACCENT, MUTED, LitSentence, renderCard, size } from './og/card';

export const alt = 'OpenReader: every word, lit as it’s spoken. Read-along audio for EPUB, PDF, and DOCX.';
export { size };
export const contentType = 'image/png';

const SAMPLE = ['Dorothy', 'lived', 'in', 'the', 'midst', 'of', 'the', 'great', 'Kansas', 'prairies,'];

export default function OpenGraphImage() {
  return renderCard([
    <div key="hero" style={{ display: 'flex', flexDirection: 'column', gap: 28, marginTop: 'auto' }}>
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
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <LitSentence words={SAMPLE} active={4} fontSize={32} />
      </div>
    </div>,
    <div key="formats" style={{ display: 'flex', marginTop: 'auto', fontSize: 28, color: MUTED }}>
      EPUB · PDF · TXT · Markdown · DOCX  —  open source and self-hostable
    </div>,
  ]);
}
