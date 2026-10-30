'use client';

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DisclosureIcon } from '@/components/icons/Icons';

/** Measures the contents so both disclosure and subsequent content changes animate. */
export function AnimatedCollapse({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Clipping must not create a scroll container: focus can otherwise scroll
  // this animated wrapper during pointer-down and move the clicked control.
  return <div id={id} inert={!open} aria-hidden={!open} className="overflow-clip transition-[height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
    style={{ height: open ? height ?? 'auto' : 0, opacity: open ? 1 : 0 }}>
    <div ref={content}>{children}</div>
  </div>;
}

export function ExpandableSettingsCard({ label, header, children }: { label: string; header: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="overflow-hidden rounded-lg border border-line-soft bg-surface-solid">
    <button type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-foreground hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
      {header}<DisclosureIcon className={`h-4 w-4 shrink-0 text-faint transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
    </button>
    <AnimatedCollapse open={open} id={id}><div className="space-y-5 border-t border-line-soft px-3 pb-3.5 pt-3.5">{children}</div></AnimatedCollapse>
  </section>;
}
