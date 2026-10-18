import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Commonplace — a shared space for ideas', template: '%s · Commonplace' },
  description:
    'A collaborative writing workspace with live editing, shared cursors, and offline document copies.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
