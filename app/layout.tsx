import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: 'Road Rules Trainer · 19 thematic tests',
  description: 'Bilingual Spanish and English driving-test trainer with 557 questions, images and explanations.',
  openGraph: {
    title: 'Road Rules Trainer · 19 thematic tests',
    description: 'Spanish · English · 557 questions',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Road Rules Trainer · 19 thematic tests',
    description: 'Spanish · English · 557 questions',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
