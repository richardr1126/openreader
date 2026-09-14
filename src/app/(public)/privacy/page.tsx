import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ButtonAnchor, ButtonLink } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Privacy & Data Usage',
  description:
    'How an OpenReader instance processes account, document, playback, email, cookie, and analytics data.',
  alternates: {
    canonical: '/privacy',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function PrivacyPage() {
  const effectiveDate = 'September 14, 2026';
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
            This policy explains what the OpenReader instance at <strong>{origin}</strong> processes, why it is
            processed, and the controls available to you. Effective date: {effectiveDate}.
          </p>
          <div className="policy-badges" aria-label="Key policy facts">
            <span className="policy-badge">No personal data sales</span>
            <span className="policy-badge">Opt-in, cookieless analytics</span>
            <span className="policy-badge">Account export + deletion tools</span>
            <span className="policy-badge">Encrypted object storage</span>
          </div>
          {isRichardrDevProductionInstance ? (
            <div className="policy-highlight">
              <strong>Official hosted service:</strong> this is the production instance operated by Richard Roberson
              at openreader.richardr.dev. It is available only to users located in the United States, and requests
              outside the US may be blocked.
            </div>
          ) : (
            <div className="policy-highlight">
              <strong>Independent deployment:</strong> this is not the Richard Roberson-operated production service.
              The person or organization running this instance is its operator and chooses its infrastructure,
              retention settings, analytics deployment, and speech providers. Using this instance does not by itself
              send your data to the OpenReader project maintainer.
            </div>
          )}
        </section>

        {/* Claim audit
            Code-verified: Better Auth cookie durations, anonymous-device cookie, local-storage consent/GPC,
            server-stored privacy acceptance, v5 worker/object-storage data flow, export/delete controls,
            Resend delivery, US geo-gate, and AES256 object writes.
            Deployment-dependent: exact provider regions, logs, backups, and operator-configured providers.
            Operator-statement: OpenReader and the official production service do not sell personal information.
        */}
        <div className="policy-grid public-reveal-2">
          <aside className="policy-nav" aria-label="Privacy sections">
            <p className="policy-nav-title">On this page</p>
            <ul className="policy-nav-list">
              <li><a href="#scope">1. Scope and operator</a></li>
              <li><a href="#info-collected">2. Information processed</a></li>
              <li><a href="#usage-purpose">3. How data is used</a></li>
              <li><a href="#cookies">4. Cookies and local storage</a></li>
              <li><a href="#sharing">5. Service providers</a></li>
              <li><a href="#retention">6. Retention and security</a></li>
              <li><a href="#rights">7. Your choices and rights</a></li>
              <li><a href="#processing-location">8. Processing location</a></li>
              <li><a href="#contact">9. Contact and open source</a></li>
            </ul>
          </aside>

          <div className="policy-sections public-panel">
            <section id="scope" className="policy-section">
              <h2>1. Scope and operator</h2>
              {isRichardrDevProductionInstance ? (
                <p>
                  This policy describes the official OpenReader service at openreader.richardr.dev. It does not govern
                  copies of the open-source software run by somebody else; those deployments have their own operators
                  and may use different service providers or policies.
                </p>
              ) : (
                <p>
                  This policy describes the software&apos;s default v5 data flows, but the operator of this deployment is
                  responsible for the service and its privacy practices. Ask the operator about any deployment-specific
                  changes, including infrastructure regions, backups, log retention, and configured TTS providers.
                </p>
              )}
            </section>

            <section id="info-collected" className="policy-section">
              <h2>2. Information processed</h2>
              <ul className="policy-fact-list">
                <li>
                  <strong>Account and authentication data:</strong> name, email address, email-verification status,
                  password verification data, linked sign-in provider details, sessions, IP address, user agent, and
                  security or recovery tokens. OpenReader also records the time you accept this policy.
                </li>
                <li>
                  <strong>Documents and derived content:</strong> uploaded EPUB, PDF, TXT, Markdown, and DOCX files;
                  extracted text and layout data; previews; generated speech, timing/alignment data, playback caches,
                  and account or audiobook exports.
                </li>
                <li>
                  <strong>Reading and configuration data:</strong> document and folder metadata, recently opened state,
                  reading position, document settings, voice and playback preferences, appearance preferences, and
                  selected TTS provider/model settings.
                </li>
                <li>
                  <strong>Security and operations data:</strong> request metadata, error and service logs, durable job
                  and operation state, pseudonymous compute-limit counters, and an anonymous-device identifier when
                  anonymous compute controls apply. IP and device values used for compute-limit buckets are stored as
                  keyed hashes rather than raw values in those buckets; authentication sessions can retain IP address
                  and user-agent data.
                </li>
                <li>
                  <strong>Optional analytics:</strong> only after you opt in, Vercel Web Analytics receives page-view
                  data such as the path, referrer, browser, device type, and approximate location. OpenReader does not
                  send document contents, account names, or email addresses as analytics events.
                </li>
              </ul>
            </section>

            <section id="usage-purpose" className="policy-section">
              <h2>3. How data is used</h2>
              <ul className="policy-list">
                <li>Authenticate accounts, verify email addresses, recover passwords, and protect sessions.</li>
                <li>Store, display, organize, search, and export documents and reading state.</li>
                <li>Parse files, create previews, generate and align speech, stream audio, and assemble exports.</li>
                <li>Enforce operator-configured usage limits, prevent abuse, diagnose failures, and secure the service.</li>
                <li>Measure aggregate product usage and improve the service when optional analytics is accepted.</li>
              </ul>
              <p>
                In v5, the authenticated web application controls accounts, authorization, and database records. A
                separate compute worker processes long-running document, preview, speech, alignment, cleanup, email,
                and export jobs. NATS JetStream carries durable job and operation state, while SQL and object storage
                hold the application records and files needed for those features.
              </p>
            </section>

            <section id="cookies" className="policy-section">
              <h2>4. Cookies, local storage, and similar technologies</h2>
              <ul className="policy-fact-list">
                <li>
                  <strong>Authentication cookies:</strong> Better Auth uses an HTTP-only, SameSite=Lax session-token
                  cookie (normally <code>better-auth.session_token</code>, with a secure-prefixed name on HTTPS) for up
                  to seven days. A signed session cache and supporting authentication cookies may be used for up to
                  five minutes during session checks or account linking, and an OAuth state cookie may be used for up
                  to ten minutes during a social sign-in. These cookies are necessary to provide authenticated or
                  optional anonymous sessions.
                </li>
                <li>
                  <strong>Anonymous compute cookie:</strong> when anonymous sessions and the relevant compute controls
                  apply, <code>or_device_id</code> stores a random HTTP-only, SameSite=Lax identifier for up to two years.
                  It helps prevent clearing browser storage from immediately resetting anonymous usage limits. It is
                  not sent to TTS providers or placed in compute jobs.
                </li>
                <li>
                  <strong>Consent preference:</strong> your accepted or declined analytics choice is stored in your
                  browser&apos;s local storage under <code>cookie-consent</code>. It is not itself a cookie. A Global Privacy
                  Control signal always overrides a prior choice and keeps analytics disabled.
                </li>
                <li>
                  <strong>Appearance preferences:</strong> theme and custom color choices are stored locally in your
                  browser so the interface can render consistently. These values are not used for advertising.
                </li>
              </ul>
              <div className="policy-highlight">
                Vercel Web Analytics is cookieless and is not loaded by OpenReader until you select <em>Accept Analytics</em>.
                Selecting <em>Decline Non-Essential</em> keeps it disabled. Clearing local storage resets the displayed
                choice; clearing cookies signs you out and can remove the anonymous-device identifier.
              </div>
            </section>

            <section id="sharing" className="policy-section">
              <h2>5. Service providers and disclosures</h2>
              <p>
                OpenReader does not sell personal information or use document contents for advertising. Data is
                disclosed to service providers only as needed to run the deployment or complete a feature you request.
                An operator may also disclose information when required by law or necessary to protect users, the
                service, or others.
              </p>
              <ul className="policy-fact-list">
                {isRichardrDevProductionInstance ? (
                  <>
                    <li>
                      <strong>Vercel:</strong> application hosting, edge routing and security, request metadata, the
                      US-region access check, and optional cookieless Web Analytics after consent. See the{' '}
                      <a href="https://vercel.com/legal/privacy-notice" target="_blank" rel="noopener noreferrer">Vercel privacy notice</a>.
                    </li>
                    <li>
                      <strong>Neon (a Databricks service):</strong> PostgreSQL storage for account, authentication,
                      document metadata, reading state, settings, and compute-limit records. See the{' '}
                      <a href="https://neon.com/privacy-policy" target="_blank" rel="noopener noreferrer">Databricks privacy notice</a>.
                    </li>
                    <li>
                      <strong>Railway:</strong> the external compute worker and S3-compatible object storage for uploaded
                      documents and derived artifacts. Browser uploads or downloads may connect directly to object
                      storage through short-lived signed URLs. See the{' '}
                      <a href="https://railway.com/legal/privacy" target="_blank" rel="noopener noreferrer">Railway privacy policy</a>.
                    </li>
                    <li>
                      <strong>Speech providers:</strong> speech you request is processed by Kitten TTS FastAPI on a
                      self-hosted local Pi cluster or by Replicate. The selected provider receives the document text
                      segments and speech settings needed to generate audio. See the{' '}
                      <a href="https://replicate.com/privacy/" target="_blank" rel="noopener noreferrer">Replicate privacy policy</a>.
                    </li>
                    <li>
                      <strong>Resend:</strong> account verification and password-recovery messages are delivered through
                      the Resend API. Resend receives the recipient email address, sender and reply-to details, message
                      content, and the time-limited verification or recovery link. See the{' '}
                      <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Resend privacy policy</a>.
                    </li>
                    <li>
                      <strong>GitHub:</strong> if you choose GitHub sign-in, GitHub processes the OAuth request and shares
                      the authorized account details needed to create or link your OpenReader account.
                    </li>
                  </>
                ) : (
                  <>
                    <li><strong>Application, database, queue, compute, and storage hosts:</strong> services selected by this instance&apos;s operator, which may be self-hosted or third-party.</li>
                    <li><strong>TTS providers:</strong> the cloud or self-hosted provider selected by the operator receives the text segments and speech settings needed for user-requested generation.</li>
                    <li><strong>Resend:</strong> if the operator enables account email, the Resend API receives the recipient address, sender and reply-to details, message content, and time-limited verification or recovery link needed to deliver the message.</li>
                    <li><strong>Vercel:</strong> if the instance uses Vercel hosting or enables Vercel Web Analytics, Vercel processes the related hosting data and, only after consent, cookieless analytics events.</li>
                    <li><strong>GitHub:</strong> if GitHub sign-in is configured and you choose it, GitHub processes the OAuth request and shares the authorized account details needed to create or link the account.</li>
                  </>
                )}
              </ul>
            </section>

            <section id="retention" className="policy-section">
              <h2>6. Retention and security</h2>
              <p>
                Account records, reading state, source documents, and reusable derived artifacts are generally retained
                while the account or document remains active. Incomplete temporary uploads are eligible for cleanup
                after 24 hours. Durable compute operation state expires after 24 hours, and completed account-export and
                audiobook-export artifacts are cleaned up after seven days by the shipped scheduled task. An operator
                can change task scheduling and may retain infrastructure logs or backups on a different schedule.
              </p>
              <p>
                OpenReader requests AES-256 server-side encryption for uploaded documents and generated object-storage
                artifacts. Saved TTS and Resend API keys are encrypted with AES-256-GCM. Passwords are stored as
                non-plaintext verification data. These safeguards do not provide end-to-end encryption: the instance
                operator and authorized infrastructure can access content when needed to operate the service, and
                requested text must be readable by the selected TTS provider.
              </p>
              <p>
                Account deletion first removes per-user storage and then deletes account records and associated database
                rows. Shared content-addressed source objects and derived artifacts that no longer have an owner are
                reclaimed by the cleanup process. Residual copies may remain temporarily in provider backups or logs
                under the applicable provider&apos;s retention practices.
              </p>
            </section>

            <section id="rights" className="policy-section">
              <h2>7. Your choices and privacy rights</h2>
              <p>
                Depending on your jurisdiction, you may have rights to know, access, correct, delete, or obtain a copy
                of personal information, and to appeal or opt out of certain processing. Exercising a privacy right does
                not reduce access except where the data is necessary to provide the requested service.
              </p>
              <ul className="policy-list">
                <li><strong>Export:</strong> use <em>Export My Data</em> in Settings to create a downloadable archive of account metadata and uploaded files.</li>
                <li><strong>Correction:</strong> update available profile, document, and preference fields in the application.</li>
                <li><strong>Deletion:</strong> use <em>Delete Account</em> in Settings to permanently remove the account and begin associated storage cleanup.</li>
                <li><strong>Analytics:</strong> decline non-essential processing in the consent notice, or send a Global Privacy Control signal.</li>
              </ul>
            </section>

            <section id="processing-location" className="policy-section">
              <h2>8. Processing location</h2>
              {isRichardrDevProductionInstance ? (
                <p>
                  The official service is limited to requests identified as originating in the United States. That
                  access restriction does not guarantee that every service provider stores or processes data only in
                  the United States; provider infrastructure and subprocessors may process data in other locations
                  under their terms and data-protection arrangements.
                </p>
              ) : (
                <p>
                  Processing and storage locations depend on the infrastructure, TTS providers, email configuration,
                  and regions selected by this instance&apos;s operator. Contact the operator for deployment-specific
                  residency and international-transfer information.
                </p>
              )}
            </section>

            <section id="contact" className="policy-section">
              <h2>9. Contact, changes, and open source</h2>
              <p>
                For an account-specific privacy request, contact the operator of this instance. Do not include private
                account information, document contents, passwords, or recovery links in a public GitHub issue. The
                effective date above will change when this policy is materially revised.
              </p>
              <p>
                OpenReader is open source. You can review the software or self-host it when you want control over the
                infrastructure and provider choices.
              </p>
              <div className="policy-actions">
                <ButtonAnchor href="https://github.com/richardr1126/openreader/issues" target="_blank" rel="noopener noreferrer" variant="primary" size="md">
                  Project Issues
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
