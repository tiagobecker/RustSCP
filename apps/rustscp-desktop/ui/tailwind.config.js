/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: 'rgb(var(--color-rust-400) / <alpha-value>)',
          500: 'rgb(var(--color-rust-500) / <alpha-value>)',
          600: 'rgb(var(--color-rust-600) / <alpha-value>)',
          700: '#94310c',
          800: '#73270d',
          900: '#431407',
          DEFAULT: 'rgb(var(--color-rust-500) / <alpha-value>)',
        },
        mcp: {
          cyan: 'rgb(var(--color-mcp-cyan) / <alpha-value>)',
          amber: 'rgb(var(--color-mcp-amber) / <alpha-value>)',
        }
      }
    },
  },
  plugins: [],
};
