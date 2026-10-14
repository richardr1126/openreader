'use client';

import { useEffect } from 'react';
import { desktopBridge } from '@/lib/client/desktop-bridge';

/**
 * Tells the desktop shell the top bar's colours, so the window controls it draws
 * on Windows and Linux match every theme. Theme changes always rewrite the root
 * element's class or inline style, so observing those catches each one. Renders
 * nothing, and does nothing without the bridge.
 */
export function DesktopTitleBarColors() {
  useEffect(() => {
    const setTitleBarColors = desktopBridge()?.setTitleBarColors;
    if (!setTitleBarColors) return;
    const root = document.documentElement;
    let last = '';
    const report = () => {
      const style = getComputedStyle(root);
      const background = style.getPropertyValue('--base').trim();
      const foreground = style.getPropertyValue('--foreground').trim();
      const key = `${background} ${foreground}`;
      if (key === last) return;
      last = key;
      setTitleBarColors({ background, foreground });
    };
    report();
    const observer = new MutationObserver(report);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);

  return null;
}
