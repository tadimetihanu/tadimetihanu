// tailwind.config.js
module.exports = {
  darkMode: 'class', // Enable class-based dark mode
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        gray: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
        },
        accent: '#0ea5e9', // teal-500 as subtle accent
      },
      fontFamily: {
        sans: ['system-ui', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
