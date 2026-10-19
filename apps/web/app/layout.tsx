import './globals.css';
import type { ReactNode } from 'react';
export const metadata = { title: 'CrimeLens', description: 'Source-linked reported incidents for Indian cities. Not an official police database.' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
