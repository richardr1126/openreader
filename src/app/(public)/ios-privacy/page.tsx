import type { Metadata } from 'next';
import { PolicyView } from '../PolicyView';
import { IOS_POLICY } from '../policies';

export const metadata: Metadata = {
  title: 'iOS App Privacy Policy',
  description:
    'The OpenReader iOS and iPadOS app collects no data. Documents, speech, and reading history stay on your device.',
  alternates: { canonical: '/ios-privacy' },
  robots: { index: true, follow: true },
};

export default function IosPrivacyPage() {
  return <PolicyView doc={IOS_POLICY} eyebrow="iOS app privacy" sibling={{ href: '/privacy', label: 'Web app privacy' }} />;
}
