import "./globals.css";
import { ReactNode } from "react";
import { Metadata } from "next";
import { Figtree } from "next/font/google";
import { ConsentAwareAnalytics } from "@/components/ConsentAwareAnalytics";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-display",
});

const themeInitScript = `
(() => {
  const themes = ['system', 'light', 'dark', 'ocean', 'forest', 'sunset', 'sea', 'mint'];
  const root = document.documentElement;
  const stored = localStorage.getItem('theme');
  const selected = stored && themes.includes(stored) ? stored : 'system';
  const effective = selected === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : selected;
  root.classList.remove(...themes);
  root.classList.add(effective);
  root.style.colorScheme = effective === 'dark' ? 'dark' : 'light';
})();
`;

export const metadata: Metadata = {
  title: {
    default: "OpenReader",
    template: "%s | OpenReader",
  },
  manifest: "/manifest.json",
  metadataBase: new URL("https://openreader.richardr.dev"),
  verification: {
    google: "MJXyTudn1kgQF8EtGD-tsnAWev7Iawso9hEvqeGHB3U",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        {children}
        <CookieConsentBanner />
        <ConsentAwareAnalytics />
      </body>
    </html>
  );
}
