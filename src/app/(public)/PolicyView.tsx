import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { PolicyDocument } from './policies';
import { LINKS } from './links';
import { ScrollSpy } from './ScrollSpy';

export function PolicyView({
  doc,
  eyebrow,
  sibling,
}: {
  doc: PolicyDocument;
  eyebrow: string;
  sibling: { href: string; label: string };
}) {
  return (
    <main id="main" className="lu-main lu-policy">
      <span className="lu-progress" aria-hidden="true" />
      <header className="lu-wrap lu-policy-head">
        <p className="lu-pill lu-glass lu-in" style={{ '--d': 0 } as CSSProperties}>
          <span className="lu-pill-dot" aria-hidden="true" />
          {eyebrow} · Effective {doc.effectiveDate}
        </p>
        <h1 className="lu-policy-title lu-in" style={{ '--d': 1 } as CSSProperties}>{doc.title}</h1>
        <p className="lu-lede lu-in" style={{ '--d': 2 } as CSSProperties}>{doc.intro}</p>
        <ul className="lu-facts lu-in" aria-label="Key policy facts" style={{ '--d': 3 } as CSSProperties}>
          {doc.facts.map((fact) => (
            <li key={fact} className="lu-glass">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {fact}
            </li>
          ))}
        </ul>
        <aside className="lu-note lu-glass lu-in" style={{ '--d': 4 } as CSSProperties}>
          <p className="lu-eyebrow">{doc.operatorNote.label}</p>
          <p>{doc.operatorNote.body}</p>
        </aside>
      </header>

      <section className="lu-wrap lu-glance" aria-labelledby="lu-glance">
        <h2 id="lu-glance" className="lu-eyebrow lu-reveal">At a glance</h2>
        <ol>
          {doc.sections.map((s, i) => (
            <li key={s.id} className="lu-reveal" style={{ '--i': i } as CSSProperties}>
              <a href={`#${s.id}`} className="lu-glass">
                <span className="lu-glance-num">{String(i + 1).padStart(2, '0')}</span>
                <strong>{s.title}</strong>
                <span>{s.summary}</span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      <div className="lu-wrap lu-policy-grid">
        <ScrollSpy className="lu-toc lu-glass" label="Sections">
          <p className="lu-eyebrow">Contents</p>
          <ol>
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </ScrollSpy>
        <div className="lu-policy-body">
          {doc.sections.map((s, i) => (
            <section key={s.id} id={s.id} className="lu-sheet lu-glass">
              <p className="lu-eyebrow">Section {i + 1}</p>
              <h2>{s.title}</h2>
              <p className="lu-summary">{s.summary}</p>
              <div className="lu-prose">{s.body}</div>
            </section>
          ))}
          <div className="lu-actions lu-policy-end">
            <a href={LINKS.issues} target="_blank" rel="noopener noreferrer" className="lu-btn lu-btn-solid">
              Project issues
            </a>
            <Link href={sibling.href} className="lu-btn lu-btn-glass">{sibling.label}</Link>
            <Link href="/" className="lu-btn lu-btn-glass">Back to home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
