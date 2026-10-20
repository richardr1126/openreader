import type { Metadata } from 'next';
import { PolicyView } from '../PolicyView';
import { IOS_POLICY } from '../policies';

export const metadata: Metadata = {
  title: 'iPhone, iPad, and Mac App Privacy Policy',
  description:
    'The OpenReader app for iPhone, iPad, and Mac collects no data. Documents, speech, and reading history stay on your device.',
  alternates: { canonical: '/ios-privacy' },
  robots: { index: true, follow: true },
};

export default function IosPrivacyPage() {
  return <PolicyView doc={IOS_POLICY} eyebrow="iPhone, iPad, and Mac app privacy" sibling={{ href: '/privacy', label: 'Web app privacy' }} />;
}
