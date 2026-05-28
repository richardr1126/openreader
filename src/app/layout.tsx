import "./globals.css";
import { ReactNode } from "react";
import { Metadata } from "next";
import { Figtree } from "next/font/google";
import { ConsentAwareAnalytics } from "@/components/ConsentAwareAnalytics";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import { getResolvedRuntimeConfig } from "@/lib/server/runtime-config";
import pkg from "../../package.json";

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-display",
});

const themeInitScript = `
(() => {
  const themes = ['system', 'light', 'dark', 'ocean', 'forest', 'sunset', 'sea', 'mint', 'lavender', 'rose', 'sand', 'sky', 'slate'];
  const lightThemes = new Set(['light', 'lavender', 'rose', 'sand', 'sky', 'slate']);
  const root = document.documentElement;
  const stored = localStorage.getItem('theme');
  const selected = stored && themes.includes(stored) ? stored : 'system';
  const effective = selected === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : selected;
  root.classList.remove(...themes);
  root.classList.add(effective);
  root.style.colorScheme = lightThemes.has(effective) ? 'light' : 'dark';
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

function jsonEmbedSafe(value: unknown): string {
  // Prevent `</script>` and U+2028/U+2029 from breaking the inline script.
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const runtimeConfig = await getResolvedRuntimeConfig();
  const runtimeConfigWithAppVersion = {
    ...runtimeConfig,
    appVersion: pkg.version,
  };
  const runtimeConfigInit = `window.__RUNTIME_CONFIG__=${jsonEmbedSafe(runtimeConfigWithAppVersion)};`;

  return (
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: runtimeConfigInit }} />
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
