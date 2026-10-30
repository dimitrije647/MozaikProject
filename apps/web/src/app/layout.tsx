import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const serif = Fraunces({ subsets: ['latin'], variable: '--font-serif', display: 'swap', axes: ['opsz'] });

export const metadata: Metadata = {
  title: { default: 'LaunchPilot: AI Marketing Factory', template: '%s | LaunchPilot' },
  description: 'One product. One brief. An entire AI marketing team.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
