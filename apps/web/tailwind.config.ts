import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: { DEFAULT: '#F4EEE3', 50: '#FBF8F2', 100: '#F7F2E9', 200: '#EFE7D9', 300: '#E3D8C5' },
        ink: { DEFAULT: '#1C1B19', 800: '#26241F', 700: '#34312B', 600: '#4A463E' },
        sand: '#F1E9DA',
        accent: { DEFAULT: '#E4572E', hover: '#CF4A24', soft: '#FBE3D9' },
        muted: { DEFAULT: '#8B8478', dark: '#A39B8C' },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'ui-serif', 'Georgia', 'serif'],
      },
      borderRadius: { xl: '1rem', '2xl': '1.25rem', '3xl': '1.75rem' },
      boxShadow: {
        soft: '0 1px 2px rgba(28,27,25,0.04), 0 8px 24px -12px rgba(28,27,25,0.10)',
        lift: '0 2px 4px rgba(28,27,25,0.05), 0 24px 48px -20px rgba(28,27,25,0.25)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in': { from: { opacity: '0', transform: 'translateX(14px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
      },
      animation: {
        'fade-up': 'fade-up 0.45s ease-out both',
        'slide-in': 'slide-in 0.35s ease-out both',
      },
    },
  },
  plugins: [animate],
};
export default config;
