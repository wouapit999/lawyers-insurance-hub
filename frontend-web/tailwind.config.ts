import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        ink: { DEFAULT: 'var(--ink)', soft: 'var(--ink-soft)' },
        navy: 'var(--navy)',
        gold: 'var(--gold)',
        line: 'var(--line)',
      },
      fontFamily: {
        // Serif for headings carries the legal gravity the blueprint asked
        // for; the system stack avoids a webfont round-trip on a slow mobile
        // connection.
        serif: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
