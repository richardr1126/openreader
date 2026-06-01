import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ButtonAnchor, ButtonLink } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Privacy & Data Usage',
  description:
    'How OpenReader collects, stores, and processes data, including usage analytics controls and your account rights.',
  alternates: {
    canonical: '/privacy',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function PrivacyPage() {
  const effectiveDate = 'February 17, 2026';
  const isRichardrDevProductionInstance =
    process.env.RICHARDRDEV_PRODUCTION?.trim().toLowerCase() === 'true';

  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'this server';
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const origin = `${proto}://${host}`;

  return (
    <main className="public-main policy-main">
      <div className="public-wrap">
        <section className="public-panel policy-hero public-reveal-1">
          <h1>Privacy, data flow, and account controls.</h1>
          <p>
            This policy explains what data OpenReader processes, how it is used, and the controls available to you.
            It applies to the instance currently running at <strong>{origin}</strong>. Effective date: {effectiveDate}.
          </p>
          <div className="policy-badges" aria-label="Key policy facts">
            <span className="policy-badge">No personal data sales</span>
            <span className="policy-badge">Analytics consent controls</span>
            <span className="policy-badge">Account export + deletion tools</span>
            <span className="policy-badge">Encrypted document storage</span>
          </div>
          {isRichardrDevProductionInstance ? (
            <div className="policy-highlight">
              <strong>US-only availability:</strong> this official instance is intended for users located in the United States,
              and requests outside the US may be blocked.
            </div>
          ) : null}
        </section>

        {/* Claim audit
            Code-verified: consent/GPC analytics handling, analytics toggle, export/delete controls, US geo-gate, AES256 storage headers.
            Deployment-dependent: processing/storage region and exact provider infrastructure locations.
            Operator-statement: OpenReader does not sell personal information.
        */}
        <div className="policy-grid public-reveal-2">
          <aside className="policy-nav" aria-label="Privacy sections">
            <p className="policy-nav-title">On this page</p>
            <ul className="policy-nav-list">
              <li><a href="#info-collected">1. Information collected</a></li>
              <li><a href="#usage-purpose">2. How data is used</a></li>
              <li><a href="#sharing">3. Sharing and service providers</a></li>
              <li><a href="#rights">4. Your rights</a></li>
              <li><a href="#retention">5. Retention and security</a></li>
              <li><a href="#processing-location">6. Processing location</a></li>
              <li><a href="#contact">7. Contact and open source</a></li>
            </ul>
          </aside>

          <div className="policy-sections public-panel">
            <section id="info-collected" className="policy-section">
              <h2>1. Information we collect</h2>
              <p>
                OpenReader collects data needed to operate the service and maintain your reading state.
                Categories include account identifiers, uploaded content, and product usage telemetry.
              </p>
              <ul className="policy-fact-list">
                <li><strong>Identifiers:</strong> Email, session-related identifiers, account name, and IP metadata for authentication and security.</li>
                <li><strong>Reader content:</strong> Uploaded documents, reading progress, bookmarks, and playback settings required for core functionality.</li>
                <li><strong>Usage events:</strong> Feature interactions and performance analytics used to debug and improve product reliability.</li>
              </ul>
            </section>

            <section id="usage-purpose" className="policy-section">
              <h2>2. How we use your data</h2>
              <ul className="policy-list">
                <li>Deliver and personalize document reading and text-to-speech playback.</li>
                <li>Process uploaded files for parsing, synchronization, and optional audiobook export.</li>
                <li>Keep the platform secure and prevent abuse.</li>
                <li>Diagnose issues and improve performance of existing functionality.</li>
              </ul>
            </section>

            <section id="sharing" className="policy-section">
              <h2>3. Service providers and analytics</h2>
              <p>
                OpenReader does not sell personal information. We use service providers only to run product
                infrastructure and user-initiated features.
              </p>
              <div className="policy-highlight">
                Optional analytics is controlled by your consent choice, and Global Privacy Control (GPC) opt-out
                signals are honored.
              </div>
              <ul className="policy-fact-list">
                {isRichardrDevProductionInstance ? (
                  <>
                    <li><strong>Hosting:</strong> Vercel for application hosting, edge runtime, and performance analytics.</li>
                    <li><strong>Database:</strong> Neon PostgreSQL for account and document metadata storage.</li>
                    <li><strong>File storage:</strong> Railway S3-compatible object storage for encrypted uploaded documents and audio artifacts.</li>
                    <li><strong>TTS processing:</strong> User-initiated TTS is handled by shared providers: Kitten TTS FastAPI (self-hosted on a local Pi cluster) and Replicate.</li>
                  </>
                ) : (
                  <>
                    <li><strong>Hosting provider:</strong> The deployment host operating this OpenReader instance.</li>
                    <li><strong>Database + storage:</strong> Configured SQL and object storage services chosen by the instance operator.</li>
                    <li><strong>TTS provider:</strong> The configured cloud or self-hosted speech provider for generated audio.</li>
                  </>
                )}
              </ul>
            </section>

            <section id="rights" className="policy-section">
              <h2>4. Your privacy rights</h2>
              <p>
                Depending on your jurisdiction, rights may include access, correction, deletion, and opt-out controls.
                OpenReader includes in-product controls for exporting and deleting account data.
              </p>
              <ul className="policy-list">
                <li><strong>Right to know:</strong> request details about data categories and usage.</li>
                <li><strong>Right to delete:</strong> delete your account and associated records in Settings.</li>
                <li><strong>Right to correct:</strong> update account data where applicable.</li>
                <li><strong>Right to opt out:</strong> disable non-essential analytics through consent controls.</li>
                <li><strong>Right to non-discrimination:</strong> exercising privacy rights does not reduce service access.</li>
              </ul>
              <div className="policy-highlight">
                <strong>In-app controls:</strong> Use <em>Export My Data</em> in Settings to download account metadata plus
                object-storage-backed files, or use <em>Delete Account</em> for permanent account removal.
              </div>
            </section>

            <section id="retention" className="policy-section">
              <h2>5. Retention and security</h2>
              <p>
                Account data and uploaded files are retained while your account remains active. Data is encrypted at
                rest in storage. OpenReader does not currently provide end-to-end encryption.
              </p>
              <p>
                The owner of this instance may be able to access stored metadata and uploaded files needed to operate
                the service.
              </p>
              <p>
                Passwords are not stored as readable plaintext; the authentication system stores credential values as
                non-plaintext verification data.
              </p>
              <p>
                Account deletion triggers removal of active account records and associated storage artifacts as part
                of the deletion flow.
              </p>
            </section>

            <section id="processing-location" className="policy-section">
              <h2>6. Processing location</h2>
              {isRichardrDevProductionInstance ? (
                <p>
                  For the official instance, access is restricted to users in the United States. Processing location
                  depends on the configured infrastructure and providers used by this deployment.
                </p>
              ) : (
                <p>
                  Data processing location depends on the deployment environment and provider configuration selected by
                  the instance operator.
                </p>
              )}
            </section>

            <section id="contact" className="policy-section">
              <h2>7. Contact and open source</h2>
              <p>
                Questions or concerns can be raised through the project repository. Self-hosting is available if you
                want full infrastructure control.
              </p>
              <div className="policy-actions">
                <ButtonAnchor href="https://github.com/richardr1126/openreader/issues" target="_blank" rel="noopener noreferrer" variant="primary" size="md">
                  Open an Issue
                </ButtonAnchor>
                <ButtonAnchor href="https://github.com/richardr1126/openreader#readme" target="_blank" rel="noopener noreferrer" variant="outline" size="md">
                  Self-Hosting Guide
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
