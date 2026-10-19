import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {
    colors: { bg0: 'var(--bg-0)', bg1: 'var(--bg-1)', bg2: 'var(--bg-2)', line: 'var(--line)', dim: 'var(--text-dim)', ink: 'var(--text)' },
    fontFamily: { ui: ['var(--font-ui)'], headline: ['var(--font-headline)'] },
  } },
} satisfies Config;
