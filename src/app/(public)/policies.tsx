import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { PRIVACY_POLICY_EFFECTIVE_DATE } from '@/lib/shared/privacy-policy';

/**
 * Policy text for the web, desktop, and iOS privacy pages. Bodies use plain semantic
 * markup (p, ul, strong, code, a) plus `[data-callout]` for highlighted notes.
 * `summary` is a one-line plain-language digest shown in the at-a-glance
 * index and above each section. It never adds a claim the body does not make.
 */
export interface PolicySection {
  id: string;
  title: string;
  summary: string;
  body: ReactNode;
}

export interface PolicyDocument {
  title: string;
  intro: ReactNode;
  effectiveDate: string;
  facts: string[];
  operatorNote: { label: string; body: ReactNode };
  sections: PolicySection[];
}

const ext = (href: string, label: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
);

/* Claim audit
   Code-verified: Better Auth cookie durations, anonymous-device cookie, local-storage consent/GPC,
   server-stored privacy acceptance, v5 worker/object-storage data flow, export/delete controls,
   Resend delivery, US geo-gate, and AES256 object writes.
   Deployment-dependent: exact provider regions, logs, backups, and operator-configured providers.
   Operator-statement: OpenReader and the official production service do not sell personal information.
*/
export async function getWebPolicy(): Promise<PolicyDocument> {
  const isProd = process.env.RICHARDRDEV_PRODUCTION?.trim().toLowerCase() === 'true';
  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'this server';
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const origin = `${proto}://${host}`;

  return {
    title: 'Privacy, data flow, and account controls.',
    effectiveDate: PRIVACY_POLICY_EFFECTIVE_DATE,
    intro: (
      <>
        This policy explains what the OpenReader instance at <strong>{origin}</strong> processes, why it is
        processed, and the controls available to you.
      </>
    ),
    facts: [
      'No personal data sales',
      'Opt-in, cookieless analytics',
      'Account export + deletion tools',
      'Encrypted object storage',
    ],
    operatorNote: isProd
      ? {
          label: 'Official hosted service',
          body: (
            <>
              This is the production instance operated by Richard Roberson at openreader.richardr.dev. It is
              available only to users located in the United States, and requests outside the US may be blocked.
            </>
          ),
        }
      : {
          label: 'Independent deployment',
          body: (
            <>
              This is not the Richard Roberson-operated production service. The person or organization running this
              instance is its operator and chooses its infrastructure, retention settings, analytics deployment, and
              speech providers. Using this instance does not by itself send your data to the OpenReader project
              maintainer.
            </>
          ),
        },
    sections: [
      {
        id: 'scope',
        title: 'Scope and operator',
        summary: isProd
          ? 'Covers openreader.richardr.dev only, not self-hosted copies.'
          : 'This deployment’s operator is responsible for it.',
        body: isProd ? (
          <p>
            This policy describes the official OpenReader service at openreader.richardr.dev. It does not govern
            copies of the open-source software run by somebody else; those deployments have their own operators and
            may use different service providers or policies.
          </p>
        ) : (
          <p>
            This policy describes the software&apos;s default v5 data flows, but the operator of this deployment is
            responsible for the service and its privacy practices. Ask the operator about any deployment-specific
            changes, including infrastructure regions, backups, log retention, and configured TTS providers.
          </p>
        ),
      },
      {
        id: 'info-collected',
        title: 'Information processed',
        summary: 'Your account, your documents and the audio made from them, reading state, and service logs.',
        body: (
          <ul>
            <li>
              <strong>Account and authentication data:</strong> name, email address, email-verification status,
              password verification data, linked sign-in provider details, sessions, IP address, user agent, and
              security or recovery tokens. OpenReader also records the time you accept this policy.
            </li>
            <li>
              <strong>Documents and derived content:</strong> uploaded EPUB, PDF, TXT, Markdown, and DOCX files;
              extracted text and layout data; previews; generated speech, timing/alignment data, playback caches, and
              account or audiobook exports.
            </li>
            <li>
              <strong>Reading and configuration data:</strong> document and folder metadata, recently opened state,
              reading position, document settings, voice and playback preferences, appearance preferences, and
              selected TTS provider/model settings.
            </li>
            <li>
              <strong>Security and operations data:</strong> request metadata, error and service logs, durable job and
              operation state, pseudonymous compute-limit counters, and an anonymous-device identifier when anonymous
              compute controls apply. IP and device values used for compute-limit buckets are stored as keyed hashes
              rather than raw values in those buckets; authentication sessions can retain IP address and user-agent
              data.
            </li>
            <li>
              <strong>Optional analytics:</strong> only after you opt in, Vercel Web Analytics receives page-view data
              such as the path, referrer, browser, device type, and approximate location. OpenReader does not send
              document contents, account names, or email addresses as analytics events.
            </li>
          </ul>
        ),
      },
      {
        id: 'usage-purpose',
        title: 'How data is used',
        summary: 'To run your account, read and voice your documents, and keep the service secure.',
        body: (
          <>
            <ul>
              <li>Authenticate accounts, verify email addresses, recover passwords, and protect sessions.</li>
              <li>Store, display, organize, search, and export documents and reading state.</li>
              <li>Parse files, create previews, generate and align speech, stream audio, and assemble exports.</li>
              <li>Enforce operator-configured usage limits, prevent abuse, diagnose failures, and secure the service.</li>
              <li>Measure aggregate product usage and improve the service when optional analytics is accepted.</li>
            </ul>
            <p>
              In v5, the authenticated web application controls accounts, authorization, and database records. A
              separate compute worker processes long-running document, preview, speech, alignment, cleanup, email, and
              export jobs. NATS JetStream carries durable job and operation state, while SQL and object storage hold
              the application records and files needed for those features.
            </p>
          </>
        ),
      },
      {
        id: 'cookies',
        title: 'Cookies, local storage, and similar technologies',
        summary: 'Only the cookies needed to sign you in and rate-limit anonymous use. Analytics is opt-in.',
        body: (
          <>
            <ul>
              <li>
                <strong>Authentication cookies:</strong> Better Auth uses an HTTP-only, SameSite=Lax session-token
                cookie (normally <code>better-auth.session_token</code>, with a secure-prefixed name on HTTPS) for up to
                seven days. A signed session cache and supporting authentication cookies may be used for up to five
                minutes during session checks or account linking, and an OAuth state cookie may be used for up to ten
                minutes during a social sign-in. These cookies are necessary to provide authenticated or optional
                anonymous sessions.
              </li>
              <li>
                <strong>Anonymous compute cookie:</strong> when anonymous sessions and the relevant compute controls
                apply, <code>or_device_id</code> stores a random HTTP-only, SameSite=Lax identifier for up to two years.
                It helps prevent clearing browser storage from immediately resetting anonymous usage limits. It is not
                sent to TTS providers or placed in compute jobs.
              </li>
              <li>
                <strong>Consent preference:</strong> your accepted or declined analytics choice is stored in your
                browser&apos;s local storage under <code>cookie-consent</code>. It is not itself a cookie. A Global
                Privacy Control signal always overrides a prior choice and keeps analytics disabled.
              </li>
              <li>
                <strong>Appearance preferences:</strong> theme and custom color choices are stored locally in your
                browser so the interface can render consistently. These values are not used for advertising.
              </li>
            </ul>
            <div data-callout>
              Vercel Web Analytics is cookieless and is not loaded by OpenReader until you select{' '}
              <em>Accept Analytics</em>. Selecting <em>Decline Non-Essential</em> keeps it disabled. Clearing local
              storage resets the displayed choice; clearing cookies signs you out and can remove the anonymous-device
              identifier.
            </div>
          </>
        ),
      },
      {
        id: 'sharing',
        title: 'Service providers and disclosures',
        summary: 'Never sold. Shared only with the hosts and speech providers needed to do what you ask.',
        body: (
          <>
            <p>
              OpenReader does not sell personal information or use document contents for advertising. Data is
              disclosed to service providers only as needed to run the deployment or complete a feature you request.
              An operator may also disclose information when required by law or necessary to protect users, the
              service, or others.
            </p>
            <ul>
              {isProd ? (
                <>
                  <li>
                    <strong>Vercel:</strong> application hosting, edge routing and security, request metadata, the
                    US-region access check, and optional cookieless Web Analytics after consent. See the{' '}
                    {ext('https://vercel.com/legal/privacy-notice', 'Vercel privacy notice')}.
                  </li>
                  <li>
                    <strong>Neon (a Databricks service):</strong> PostgreSQL storage for account, authentication,
                    document metadata, reading state, settings, and compute-limit records. See the{' '}
                    {ext('https://neon.com/privacy-policy', 'Databricks privacy notice')}.
                  </li>
                  <li>
                    <strong>Railway:</strong> the external compute worker and S3-compatible object storage for uploaded
                    documents and derived artifacts. Browser uploads or downloads may connect directly to object storage
                    through short-lived signed URLs. See the{' '}
                    {ext('https://railway.com/legal/privacy', 'Railway privacy policy')}.
                  </li>
                  <li>
                    <strong>Speech providers:</strong> speech you request is processed by Kitten TTS FastAPI on a
                    self-hosted local Pi cluster or by Replicate. The selected provider receives the document text
                    segments and speech settings needed to generate audio. See the{' '}
                    {ext('https://replicate.com/privacy/', 'Replicate privacy policy')}.
                  </li>
                  <li>
                    <strong>Resend:</strong> account verification and password-recovery messages are delivered through
                    the Resend API. Resend receives the recipient email address, sender and reply-to details, message
                    content, and the time-limited verification or recovery link. See the{' '}
                    {ext('https://resend.com/legal/privacy-policy', 'Resend privacy policy')}.
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
          </>
        ),
      },
      {
        id: 'retention',
        title: 'Retention and security',
        summary: 'Kept while your account is active, encrypted at rest, and cleaned up when you delete it.',
        body: (
          <>
            <p>
              Account records, reading state, source documents, and reusable derived artifacts are generally retained
              while the account or document remains active. Incomplete temporary uploads are eligible for cleanup after
              24 hours. Durable compute operation state expires after 24 hours, and completed account-export ZIPs are
              cleaned up after seven days by the shipped scheduled task. Finished audiobook files remain until the
              relevant audio, document, or account is deleted. An operator can change task scheduling and may retain
              infrastructure logs or backups on a different schedule.
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
              reclaimed by the cleanup process. Residual copies may remain temporarily in provider backups or logs under
              the applicable provider&apos;s retention practices.
            </p>
          </>
        ),
      },
      {
        id: 'rights',
        title: 'Your choices and privacy rights',
        summary: 'Export everything, correct it, delete it, or decline analytics at any time.',
        body: (
          <>
            <p>
              Depending on your jurisdiction, you may have rights to know, access, correct, delete, or obtain a copy of
              personal information, and to appeal or opt out of certain processing. Exercising a privacy right does not
              reduce access except where the data is necessary to provide the requested service.
            </p>
            <ul>
              <li><strong>Export:</strong> use <em>Export My Data</em> in Settings to create a downloadable archive of account metadata and uploaded files.</li>
              <li><strong>Correction:</strong> update available profile, document, and preference fields in the application.</li>
              <li><strong>Deletion:</strong> use <em>Delete Account</em> in Settings to permanently remove the account and begin associated storage cleanup.</li>
              <li><strong>Analytics:</strong> decline non-essential processing in the consent notice, or send a Global Privacy Control signal.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'processing-location',
        title: 'Processing location',
        summary: isProd
          ? 'Access is US-only; providers may process data elsewhere.'
          : 'Depends on where this instance’s operator runs it.',
        body: isProd ? (
          <p>
            The official service is limited to requests identified as originating in the United States. That access
            restriction does not guarantee that every service provider stores or processes data only in the United
            States; provider infrastructure and subprocessors may process data in other locations under their terms and
            data-protection arrangements.
          </p>
        ) : (
          <p>
            Processing and storage locations depend on the infrastructure, TTS providers, email configuration, and
            regions selected by this instance&apos;s operator. Contact the operator for deployment-specific residency
            and international-transfer information.
          </p>
        ),
      },
      {
        id: 'contact',
        title: 'Contact, changes, and open source',
        summary: 'Ask the operator. Never post private details in a public issue.',
        body: (
          <>
            <p>
              For an account-specific privacy request, contact the operator of this instance. Do not include private
              account information, document contents, passwords, or recovery links in a public GitHub issue. The
              effective date above will change when this policy is materially revised.
            </p>
            <p>
              OpenReader is open source. You can review the software or self-host it when you want control over the
              infrastructure and provider choices.
            </p>
          </>
        ),
      },
    ],
  };
}

// The iOS app is a separate product with its own data flow, so its policy has
// its own date rather than sharing PRIVACY_POLICY_EFFECTIVE_DATE.
const IOS_PRIVACY_POLICY_EFFECTIVE_DATE = 'October 20, 2026';

/* Claim audit (openreader-ios)
   Code-verified: PrivacyInfo.xcprivacy declares no collected data types and no tracking;
   network endpoints are Hugging Face model downloads, Gutendex catalog search, Project
   Gutenberg book files, and CloudKit's private database; speech and word timing run on device.
   Update this page when the app gains a network endpoint or SDK.
*/
export const IOS_POLICY: PolicyDocument = {
  title: 'OpenReader for iPhone, iPad, and Mac collects no data.',
  effectiveDate: IOS_PRIVACY_POLICY_EFFECTIVE_DATE,
  intro: (
    <>
      This policy covers the OpenReader app for iOS, iPadOS, and macOS, published by Richard Roberson through the App
      Store and TestFlight. The Mac version is the same app, so everything below applies to it too.
    </>
  ),
  facts: ['No data collection', 'No accounts', 'No analytics or tracking', 'On-device speech'],
  operatorNote: {
    label: 'A separate product',
    body: (
      <>
        This app does not connect to this website or to any OpenReader server, and it does not use the web
        app&apos;s accounts. The web app&apos;s privacy policy does not apply to it, and neither does the policy for
        OpenReader Desktop, a different app.
      </>
    ),
  },
  sections: [
    {
      id: 'collection',
      title: 'What we collect',
      summary: 'Nothing.',
      body: (
        <p>
          Nothing. The app has no accounts, no analytics, no advertising, no crash-reporting service, and no
          third-party tracking SDKs. The developer does not receive your documents, your reading history, your voice
          settings, or any information that identifies you or your device. Nothing is sold or shared, and nothing is
          used for advertising.
        </p>
      ),
    },
    {
      id: 'on-device',
      title: 'What stays on your device',
      summary: 'Documents, speech, highlighting, and reading data all live on the device.',
      body: (
        <>
          <ul>
            <li>
              <strong>Documents:</strong> the EPUB, PDF, Markdown, and text files you import or write are stored in the
              app&apos;s own storage on your device.
            </li>
            <li>
              <strong>Speech:</strong> text is turned into speech on your device by Kokoro, Supertonic, or your
              installed system voices. No text is ever sent to a remote speech service.
            </li>
            <li>
              <strong>Text recognition and highlighting:</strong> reading scanned PDF pages and timing word highlights
              both use Apple&apos;s on-device frameworks.
            </li>
            <li>
              <strong>Reading data:</strong> positions, bookmarks, folders, themes, and voice preferences are kept on
              your device, and generated audio and exported audiobooks stay there too.
            </li>
          </ul>
          <p>
            Deleting a book removes it and its generated audio. Deleting the app removes everything it stored on the
            device.
          </p>
        </>
      ),
    },
    {
      id: 'network',
      title: 'When the app uses the network',
      summary: 'Only for voice downloads and the free-book catalog, never with your documents.',
      body: (
        <>
          <p>
            The app connects to the internet only when you use one of the features below. Like any web request, these
            connections reveal your IP address and basic request details to the server. None of them includes your
            documents or any account, name, or identifier, and the developer does not use them to identify or track
            you.
          </p>
          <ul>
            <li>
              <strong>Voice downloads (Hugging Face):</strong> the optional Kokoro and Supertonic voice models are
              downloaded from Hugging Face when you choose one, and are checked against a pinned checksum before use.
              See the {ext('https://huggingface.co/privacy', 'Hugging Face privacy policy')}.
            </li>
            <li>
              <strong>Book catalog (Gutendex):</strong> browsing or searching the Project Gutenberg catalog sends your
              search terms and language filter to a Gutendex catalog server run by the developer. These requests carry
              no account or device identifier.
            </li>
            <li>
              <strong>Book downloads (Project Gutenberg):</strong> adding a book from the catalog downloads its file
              from Project Gutenberg. See the{' '}
              {ext('https://www.gutenberg.org/policy/privacy_policy.html', 'Project Gutenberg privacy policy')}.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'icloud',
      title: 'Optional iCloud sync',
      summary: 'Off by default. When on, it uses your private iCloud, which the developer can’t read.',
      body: (
        <p>
          iCloud sync is off until you turn it on in Settings. When it is on, your documents, reading positions,
          bookmarks, folders, theme, and speech preferences are stored in your own private iCloud database through
          Apple&apos;s CloudKit, so they can sync between your devices. The developer cannot access your private
          iCloud database. Generated audio is never synced. Apple handles this data under the{' '}
          {ext('https://www.apple.com/legal/privacy/', 'Apple Privacy Policy')}. Turning sync off stops syncing, and
          you can manage or delete iCloud data in your device&apos;s iCloud settings.
        </p>
      ),
    },
    {
      id: 'children',
      title: 'Children',
      summary: 'No personal information from anyone, including children.',
      body: <p>The app collects no personal information from anyone, including children under 13.</p>,
    },
    {
      id: 'contact',
      title: 'Changes and contact',
      summary: 'Updates change the date above. Questions go to GitHub issues.',
      body: (
        <p>
          If the app&apos;s handling of data changes, this page will be updated and its effective date changed. For
          privacy questions, open an issue on the OpenReader GitHub project. Please do not include document contents
          or other private information in a public issue.
        </p>
      ),
    },
  ],
};

// OpenReader Desktop runs the whole stack on the owner's computer, so its policy
// is about the network rather than an operator.
const DESKTOP_PRIVACY_POLICY_EFFECTIVE_DATE = 'October 20, 2026';

/* Claim audit (desktop/)
   Code-verified: runtime binds 127.0.0.1 only; Vercel Analytics, cookie banner and Resend
   email are off for the desktop profile; NEXT_TELEMETRY_DISABLED; data under <appData>/OpenReader;
   updates via electron-updater from GitHub Releases, toggle in Settings → Instance; model
   downloads from Hugging Face (Kokoro, Whisper alignment, PP-DocLayoutV3) and Kokoro's
   pronunciation data from raw.githubusercontent.com; Gutendex default gutendex.com; external
   links open in the system browser. Update this page when the shell or runtime gains an endpoint.
*/
export const DESKTOP_POLICY: PolicyDocument = {
  title: 'OpenReader Desktop keeps your library on your computer.',
  effectiveDate: DESKTOP_PRIVACY_POLICY_EFFECTIVE_DATE,
  intro: (
    <>
      This policy covers OpenReader Desktop for macOS, Windows, and Linux, published by Richard Roberson on the
      OpenReader GitHub project.
    </>
  ),
  facts: ['No data collection', 'No account with us', 'No analytics or telemetry', 'Runs on your computer'],
  operatorNote: {
    label: 'You are the operator',
    body: (
      <>
        The desktop app runs its own copy of OpenReader on your computer and signs you in as its only owner. It does
        not connect to the hosted service at openreader.richardr.dev or use its accounts, so the web app&apos;s
        privacy policy does not apply to it.
      </>
    ),
  },
  sections: [
    {
      id: 'collection',
      title: 'What we collect',
      summary: 'Nothing.',
      body: (
        <p>
          Nothing. The app has no analytics, no advertising, no crash-reporting service, and no tracking. The web
          app&apos;s optional analytics are not included, and framework telemetry is turned off. The developer does
          not receive your documents, your reading history, your settings, or any information that identifies you or
          your computer.
        </p>
      ),
    },
    {
      id: 'on-device',
      title: 'What stays on your computer',
      summary: 'Documents, audio, settings, and the database all live in the app’s data folder.',
      body: (
        <>
          <ul>
            <li>
              <strong>Your library:</strong> documents, generated audio, word timings, previews, and exported
              audiobooks are stored in the app&apos;s data folder (an <code>OpenReader</code> folder in your
              system&apos;s application data). Settings → Library and storage → Show data folder opens it.
            </li>
            <li>
              <strong>Reading data:</strong> positions, preferences, and voice settings are kept in a local database
              in the same folder.
            </li>
            <li>
              <strong>Local services:</strong> the app&apos;s server and its helper services listen only on your
              computer (<code>127.0.0.1</code>), so other devices on your network cannot reach them.
            </li>
            <li>
              <strong>Local speech:</strong> the built-in Kokoro voices, word alignment, and PDF layout analysis run
              on your computer.
            </li>
          </ul>
          <p data-callout>
            Uninstalling the app may leave its data folder in place. Delete that folder to remove everything the app
            stored.
          </p>
        </>
      ),
    },
    {
      id: 'network',
      title: 'When the app uses the network',
      summary: 'Updates, model downloads, the book catalog, and speech services you add. Text goes only to a speech service you choose.',
      body: (
        <>
          <p>
            Like any web request, each connection below reveals your IP address and basic request details to the
            server it reaches. None of them carries an account, name, or identifier from the developer, and the
            developer does not use them to identify or track you.
          </p>
          <ul>
            <li>
              <strong>Updates (GitHub):</strong> shortly after launch and every few hours, the app checks the
              OpenReader GitHub releases for a newer version and downloads it. A check sends nothing about your
              library. Turn this off under Settings → Instance → Automatic updates. See the{' '}
              {ext('https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement', 'GitHub privacy statement')}.
            </li>
            <li>
              <strong>Model downloads (Hugging Face and GitHub):</strong> the Kokoro voices, the word-alignment
              model, and the PDF layout model are downloaded from Hugging Face when you choose to download them or
              first need them, and Kokoro&apos;s pronunciation data from GitHub. See the{' '}
              {ext('https://huggingface.co/privacy', 'Hugging Face privacy policy')}.
            </li>
            <li>
              <strong>Release notes:</strong> after an update, the app fetches the release notes it shows you from
              the OpenReader documentation site.
            </li>
            <li>
              <strong>Book catalog (Gutendex and Project Gutenberg):</strong> browsing the free-book catalog sends
              your search terms and language filter to the Gutendex server set in Settings → Instance (gutendex.com
              unless you change it), and adding a book downloads it from Project Gutenberg. See the{' '}
              {ext('https://www.gutenberg.org/policy/privacy_policy.html', 'Project Gutenberg privacy policy')}.
            </li>
            <li>
              <strong>Speech services you add:</strong> if you connect a hosted provider such as OpenAI, Replicate,
              or DeepInfra, or a speech server of your own, the text being read aloud is sent to it, and that
              provider&apos;s own policy applies. The built-in voices send nothing.
            </li>
          </ul>
          <p>Links to other websites open in your default browser, under that browser&apos;s settings.</p>
        </>
      ),
    },
    {
      id: 'deletion',
      title: 'Deleting your data',
      summary: 'Delete documents in the app, or the data folder to remove everything.',
      body: (
        <p>
          Deleting a document in the library removes it with its generated audio and timings. To remove everything,
          quit the app and delete its data folder. Your files are never stored anywhere the developer can reach.
        </p>
      ),
    },
    {
      id: 'children',
      title: 'Children',
      summary: 'No personal information from anyone, including children.',
      body: <p>The app collects no personal information from anyone, including children under 13.</p>,
    },
    {
      id: 'contact',
      title: 'Changes and contact',
      summary: 'Updates change the date above. Questions go to GitHub issues.',
      body: (
        <p>
          If the app&apos;s handling of data changes, this page will be updated and its effective date changed. For
          privacy questions, open an issue on the OpenReader GitHub project. Please do not include document contents
          or other private information in a public issue.
        </p>
      ),
    },
  ],
};
