import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Predictive Maintenance Lab — Prove the prediction works',
  description:
    'An isolated predictive-maintenance laboratory on NASA C-MAPSS FD001: RUL assessments, controlled pipeline faults, bounded agent recovery, and correlated evidence.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
