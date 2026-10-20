import type { Metadata } from 'next';
import { PolicyView } from '../PolicyView';
import { DESKTOP_POLICY } from '../policies';

export const metadata: Metadata = {
  title: 'Desktop App Privacy Policy',
  description:
    'OpenReader Desktop collects no data. Your library, audio, and reading history stay on your computer.',
  alternates: { canonical: '/desktop-privacy' },
  robots: { index: true, follow: true },
};

export default function DesktopPrivacyPage() {
  return <PolicyView doc={DESKTOP_POLICY} eyebrow="Desktop app privacy" sibling={{ href: '/download', label: 'Download the app' }} />;
}
