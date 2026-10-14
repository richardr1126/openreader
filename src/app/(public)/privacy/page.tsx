import type { Metadata } from 'next';
import { PolicyView } from '../PolicyView';
import { getWebPolicy } from '../policies';

export const metadata: Metadata = {
  title: 'Privacy & Data Usage',
  description:
    'How an OpenReader instance processes account, document, playback, email, cookie, and analytics data.',
  alternates: { canonical: '/privacy' },
  robots: { index: true, follow: true },
};

export default async function PrivacyPage() {
  const doc = await getWebPolicy();
  return <PolicyView doc={doc} eyebrow="Privacy policy" sibling={{ href: '/ios-privacy', label: 'iOS app privacy' }} />;
}
