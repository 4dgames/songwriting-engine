import type { Metadata } from 'next';
import { Geist, Geist_Mono, Merriweather, Lora } from 'next/font/google';
import { Providers } from '@/components/Providers';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const merriweather = Merriweather({ weight: '700', subsets: ['latin'], variable: '--font-merriweather' });
const lora = Lora({ weight: '400', subsets: ['latin'], variable: '--font-lora' });

export const metadata: Metadata = {
  title: 'Song Maker',
  description: 'AI-powered songwriting with audio generation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${merriweather.variable} ${lora.variable} h-full`}>
      <body className="min-h-full bg-[#f6f6f6] text-[#3b3b3b] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
