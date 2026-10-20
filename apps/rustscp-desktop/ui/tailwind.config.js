/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI Variable Text"', '"Segoe UI"', 'Inter', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"'],
        mono: ['ui-monospace', '"SF Mono"', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      colors: {
        // Warm neutral scale (Claude-style). Overrides Tailwind's cool slate so every
        // existing `slate-*` class across the app picks up the calmer, warmer tone.
        slate: {
          50: '#FAF9F5',
          100: '#F4F3EE',
          200: '#E8E6DC',
          300: '#D6D4C9',
          400: '#A9A79E',
          500: '#78776F',
          600: '#5E5D58',
          700: '#45443F',
          800: '#33322F',
          900: '#262624',
          950: '#141413',
        },
        dark: {
          950: 'rgb(var(--color-dark-950) / <alpha-value>)',
          900: 'rgb(var(--color-dark-900) / <alpha-value>)',
          850: 'rgb(var(--color-dark-850) / <alpha-value>)',
          800: 'rgb(var(--color-dark-800) / <alpha-value>)',
          750: 'rgb(var(--color-dark-750) / <alpha-value>)',
          700: 'rgb(var(--color-dark-700) / <alpha-value>)',
          650: 'rgb(var(--color-dark-650) / <alpha-value>)',
          600: 'rgb(var(--color-dark-600) / <alpha-value>)',
        },

        rust: {
          50: '#FBF2EE',
          100: '#F6E3DA',
          200: '#EDC6B5',
          300: '#E2A68C',
          400: 'rgb(var(--color-rust-400) / <alpha-value>)',
          500: 'rgb(var(--color-rust-500) / <alpha-value>)',
          600: 'rgb(var(--color-rust-600) / <alpha-value>)',
          700: '#9C4A31',
          800: '#7A3A27',
          900: '#4A2419',
          DEFAULT: 'rgb(var(--color-rust-500) / <alpha-value>)',
        },
        mcp: {
          cyan: 'rgb(var(--color-mcp-cyan) / <alpha-value>)',
          amber: 'rgb(var(--color-mcp-amber) / <alpha-value>)',
        },
        // Semantic surface/text tokens for new components
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
          overlay: 'rgb(var(--surface-overlay) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--color-rust-500) / <alpha-value>)',
          hover: 'rgb(var(--color-rust-600) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
        },
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
      },
      boxShadow: {
        xs: '0 1px 1px rgb(0 0 0 / 0.04)',
        pop: '0 8px 30px -6px rgb(0 0 0 / 0.18), 0 2px 6px -2px rgb(0 0 0 / 0.08)',
        modal: '0 24px 60px -12px rgb(0 0 0 / 0.30), 0 0 0 1px rgb(var(--line) / 0.6)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
