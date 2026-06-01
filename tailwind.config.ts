import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        base: "var(--base)",
        offbase: "var(--offbase)",
        accent: "var(--accent)",
        "secondary-accent": "var(--secondary-accent)",
        muted: "var(--muted)",
        surface: "var(--surface)",
        "surface-solid": "var(--surface-solid)",
        "surface-sunken": "var(--surface-sunken)",
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        "line-strong": "var(--line-strong)",
        soft: "var(--soft)",
        faint: "var(--faint)",
        "accent-wash": "var(--accent-wash)",
        "accent-line": "var(--accent-line)",
        "accent-strong": "var(--accent-strong)",
        danger: "var(--danger)",
        "danger-strong": "var(--danger-strong)",
        "danger-wash": "var(--danger-wash)",
      },
      boxShadow: {
        "elev-1": "var(--elev-1)",
        "elev-2": "var(--elev-2)",
        "elev-3": "var(--elev-3)",
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
        pill: "999px",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
      transitionTimingFunction: {
        standard: "var(--ease)",
      },
      animation: {
        'spin-slow': 'spin 2s linear infinite',
        'fade-in': 'fadeIn 200ms ease-in',
        'fade-out': 'fadeOut 200ms ease-out',
        'scale-in': 'scaleIn 200ms ease-in',
        'scale-out': 'scaleOut 200ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeOut: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        scaleOut: {
          '0%': { transform: 'scale(1)', opacity: '1' },
          '100%': { transform: 'scale(0.95)', opacity: '0' },
        },
      },
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-body': 'var(--foreground)',
            '--tw-prose-headings': 'var(--foreground)',
            '--tw-prose-lead': 'var(--muted)',
            '--tw-prose-links': 'var(--accent)',
            '--tw-prose-bold': 'var(--foreground)',
            '--tw-prose-counters': 'var(--muted)',
            '--tw-prose-bullets': 'var(--muted)',
            '--tw-prose-hr': 'var(--offbase)',
            '--tw-prose-quotes': 'var(--foreground)',
            '--tw-prose-quote-borders': 'var(--offbase)',
            '--tw-prose-captions': 'var(--muted)',
            '--tw-prose-code': 'var(--foreground)',
            '--tw-prose-pre-code': 'var(--foreground)',
            '--tw-prose-pre-bg': 'var(--base)',
            '--tw-prose-th-borders': 'var(--offbase)',
            '--tw-prose-td-borders': 'var(--offbase)',
          },
        },
      },
      screens: {
        xs: '410px', // custom xs breakpoint
      },
    },
  },
  plugins: [typography],
} satisfies Config;
