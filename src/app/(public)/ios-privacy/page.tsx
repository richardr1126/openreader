import type { Metadata } from 'next';
import { ButtonAnchor, ButtonLink } from '@/components/ui';

// The iOS app is a separate product with its own data flow, so its policy has
// its own date rather than sharing PRIVACY_POLICY_EFFECTIVE_DATE, which also
// drives the web app's server-stored acceptance.
const IOS_PRIVACY_POLICY_EFFECTIVE_DATE = 'October 7, 2026';

export const metadata: Metadata = {
  title: 'iOS App Privacy Policy',
  description:
    'The OpenReader iOS and iPadOS app collects no data. Documents, speech, and reading history stay on your device.',
  alternates: {
    canonical: '/ios-privacy',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function IosPrivacyPage() {
  return (
    <main className="public-main policy-main">
      <div className="public-wrap">
        <section className="public-panel policy-hero public-reveal-1">
          <h1>OpenReader for iPhone and iPad collects no data.</h1>
          <p>
            This policy covers the OpenReader app for iOS and iPadOS, published on the App Store by Richard
            Roberson. Effective date: {IOS_PRIVACY_POLICY_EFFECTIVE_DATE}.
          </p>
          <div className="policy-badges" aria-label="Key policy facts">
            <span className="policy-badge">No data collection</span>
            <span className="policy-badge">No accounts</span>
            <span className="policy-badge">No analytics or tracking</span>
            <span className="policy-badge">On-device speech</span>
          </div>
          <div className="policy-highlight">
            <strong>A separate product:</strong> the iOS app does not connect to this website or to any OpenReader
            server, and it does not use the web app&apos;s accounts. The{' '}
            <a href="/privacy">web app&apos;s privacy policy</a> does not apply to it.
          </div>
        </section>

        {/* Claim audit (openreader-ios)
            Code-verified: PrivacyInfo.xcprivacy declares no collected data types and no tracking;
            network endpoints are Hugging Face model downloads, Gutendex catalog search, Project
            Gutenberg book files, and CloudKit's private database; speech and word timing run on device.
            Update this page when the app gains a network endpoint or SDK.
        */}
        <div className="policy-grid public-reveal-2">
          <aside className="policy-nav" aria-label="Privacy sections">
            <p className="policy-nav-title">On this page</p>
            <ul className="policy-nav-list">
              <li><a href="#collection">1. What we collect</a></li>
              <li><a href="#on-device">2. What stays on your device</a></li>
              <li><a href="#network">3. When the app uses the network</a></li>
              <li><a href="#icloud">4. Optional iCloud sync</a></li>
              <li><a href="#children">5. Children</a></li>
              <li><a href="#contact">6. Changes and contact</a></li>
            </ul>
          </aside>

          <div className="policy-sections public-panel">
            <section id="collection" className="policy-section">
              <h2>1. What we collect</h2>
              <p>
                Nothing. The app has no accounts, no analytics, no advertising, no crash-reporting service, and no
                third-party tracking SDKs. The developer does not receive your documents, your reading history, your
                voice settings, or any information that identifies you or your device. Nothing is sold or shared, and
                nothing is used for advertising.
              </p>
            </section>

            <section id="on-device" className="policy-section">
              <h2>2. What stays on your device</h2>
              <ul className="policy-fact-list">
                <li>
                  <strong>Documents:</strong> the EPUB, PDF, Markdown, and text files you import or write are stored in
                  the app&apos;s own storage on your device.
                </li>
                <li>
                  <strong>Speech:</strong> text is turned into speech on your device by Kokoro, Supertonic, or your
                  installed system voices. No text is ever sent to a remote speech service.
                </li>
                <li>
                  <strong>Text recognition and highlighting:</strong> reading scanned PDF pages and timing word
                  highlights both use Apple&apos;s on-device frameworks.
                </li>
                <li>
                  <strong>Reading data:</strong> positions, bookmarks, folders, themes, and voice preferences are kept on
                  your device, and generated audio and exported audiobooks stay there too.
                </li>
              </ul>
              <p>
                Deleting a book removes it and its generated audio. Deleting the app removes everything it stored on
                the device.
              </p>
            </section>

            <section id="network" className="policy-section">
              <h2>3. When the app uses the network</h2>
              <p>
                The app connects to the internet only when you use one of the features below. Like any web request,
                these connections reveal your IP address and basic request details to the server. None of them
                includes your documents or any account, name, or identifier, and the developer does not use them to
                identify or track you.
              </p>
              <ul className="policy-fact-list">
                <li>
                  <strong>Voice downloads (Hugging Face):</strong> the optional Kokoro and Supertonic voice models are
                  downloaded from Hugging Face when you choose one, and are checked against a pinned checksum before
                  use. See the{' '}
                  <a href="https://huggingface.co/privacy" target="_blank" rel="noopener noreferrer">Hugging Face privacy policy</a>.
                </li>
                <li>
                  <strong>Book catalog (Gutendex):</strong> browsing or searching the Project Gutenberg catalog sends
                  your search terms and language filter to a Gutendex catalog server run by the developer. These
                  requests carry no account or device identifier.
                </li>
                <li>
                  <strong>Book downloads (Project Gutenberg):</strong> adding a book from the catalog downloads its file
                  from Project Gutenberg. See the{' '}
                  <a href="https://www.gutenberg.org/policy/privacy_policy.html" target="_blank" rel="noopener noreferrer">Project Gutenberg privacy policy</a>.
                </li>
              </ul>
            </section>

            <section id="icloud" className="policy-section">
              <h2>4. Optional iCloud sync</h2>
              <p>
                iCloud sync is off until you turn it on in Settings. When it is on, your documents, reading positions,
                bookmarks, folders, theme, and speech preferences are stored in your own private iCloud database
                through Apple&apos;s CloudKit, so they can sync between your devices. The developer cannot access your
                private iCloud database. Generated audio is never synced. Apple handles this data under the{' '}
                <a href="https://www.apple.com/legal/privacy/" target="_blank" rel="noopener noreferrer">Apple Privacy Policy</a>.
                Turning sync off stops syncing, and you can manage or delete iCloud data in your device&apos;s iCloud
                settings.
              </p>
            </section>

            <section id="children" className="policy-section">
              <h2>5. Children</h2>
              <p>
                The app collects no personal information from anyone, including children under 13.
              </p>
            </section>

            <section id="contact" className="policy-section">
              <h2>6. Changes and contact</h2>
              <p>
                If the app&apos;s handling of data changes, this page will be updated and its effective date changed.
                For privacy questions, open an issue on the OpenReader GitHub project. Please do not include document
                contents or other private information in a public issue.
              </p>
              <div className="policy-actions">
                <ButtonAnchor href="https://github.com/richardr1126/openreader/issues" target="_blank" rel="noopener noreferrer" variant="primary" size="md">
                  Project Issues
                </ButtonAnchor>
                <ButtonLink href="/?redirect=false" variant="ghost" size="md">Back to landing</ButtonLink>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
