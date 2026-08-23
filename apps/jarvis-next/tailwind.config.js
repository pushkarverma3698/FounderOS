/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Single-accent system. `accent` is the ONLY decorative colour.
        // `signal` = HITL gate, `alarm` = kernel failure. Both semantic only.
        accent: 'var(--accent)',
        signal: 'var(--signal)',
        alarm: 'var(--alarm)',
        void: '#000206',
        panel: '#060e16',
        chrome: '#c6e4ee',
        dim: 'rgba(190,225,235,0.45)',
      },
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      animation: {
        drift: 'drift 22s linear infinite',
        breathe: 'breathe 4s ease-in-out infinite',
        sweep: 'sweep 7s linear infinite',
      },
      keyframes: {
        drift: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '0.9' },
        },
        sweep: {
          '0%': { transform: 'translateY(-10%)', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { transform: 'translateY(1000%)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
