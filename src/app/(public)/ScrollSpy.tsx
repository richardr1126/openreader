'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Marks the in-page link whose section is currently being read with
 * `aria-current="location"`, so designs can style it with plain CSS.
 */
export function ScrollSpy({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    const sections = links
      .map((link) => document.getElementById(link.hash.slice(1)))
      .filter((el): el is HTMLElement => el !== null);
    const visible = new Set<string>();

    const update = () => {
      const current = sections.find((s) => visible.has(s.id))?.id;
      for (const link of links) {
        if (link.hash.slice(1) === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        update();
      },
      { rootMargin: '-20% 0px -60% 0px' },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return (
    <nav ref={navRef} className={className} aria-label={label}>
      {children}
    </nav>
  );
}
