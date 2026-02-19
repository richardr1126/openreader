import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';

export const metadata: Metadata = {
  title: 'Privacy & Data Usage | OpenReader',
  description:
    'Learn how OpenReader handles your data, what is stored in your browser, and what is sent to the server.',
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

  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'this server';
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const origin = `${proto}://${host}`;

  return (
    <>
      <style>{`
        /* ── Privacy body ───────────────── */
        .privacy-body {
          max-width: 42rem;
          margin: 0 auto;
          padding: 3rem 1.5rem 4rem;
          animation: landing-fade-up 0.7s ease-out 0.15s both;
        }
        .privacy-body h1 {
          font-family: var(--g-display);
          font-weight: 800;
          font-size: clamp(1.5rem, 4vw, 2.25rem);
          letter-spacing: -0.03em;
          margin: 0 0 0.5rem;
        }
        .privacy-body h1 span {
          background: linear-gradient(135deg, var(--g-accent), var(--g-accent2));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .privacy-subtitle {
          font-size: 0.95rem;
          color: var(--g-muted);
          margin: 0 0 2.5rem;
          line-height: 1.6;
        }
        .privacy-card {
          padding: 2rem;
          margin-bottom: 1.25rem;
        }
        .privacy-card-label {
          font-family: var(--g-display);
          font-size: 0.68rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: var(--g-accent);
          margin: 0 0 0.75rem;
        }
        .privacy-card p,
        .privacy-card li {
          font-size: 0.92rem;
          line-height: 1.65;
          color: var(--g-fg);
        }
        .privacy-card ul {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .privacy-card li {
          position: relative;
          padding-left: 1.1rem;
          margin-bottom: 0.4rem;
        }
        .privacy-card li::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0.55em;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--g-accent);
          opacity: 0.5;
        }
        .privacy-highlight {
          background: color-mix(in srgb, var(--g-accent), transparent 88%);
          border: 1px solid color-mix(in srgb, var(--g-accent), transparent 70%);
          border-radius: 0.75rem;
          padding: 1rem 1.25rem;
          margin-bottom: 1.25rem;
          font-size: 0.88rem;
          line-height: 1.6;
          color: var(--g-fg);
        }
        .privacy-highlight strong {
          color: var(--g-accent);
          font-weight: 600;
        }
        .privacy-note {
          font-size: 0.8rem;
          color: var(--g-muted);
          line-height: 1.6;
          margin-top: 2rem;
        }
        .privacy-note a {
          color: var(--g-accent);
          text-decoration: underline;
          text-decoration-style: dotted;
          text-underline-offset: 3px;
        }
        .privacy-back {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-family: var(--g-system);
          font-size: 0.875rem;
          font-weight: 500;
          color: var(--g-accent);
          text-decoration: none;
          margin-top: 2rem;
          transition: opacity 0.2s;
        }
        .privacy-back:hover {
          opacity: 0.75;
        }
      `}</style>

      <div className="privacy-body">
        <h1>Privacy &amp; <span>Data Usage</span></h1>
        <p className="privacy-subtitle">
          Effective Date: {effectiveDate}
        </p>

        <div className="privacy-highlight">
          This OpenReader instance is hosted at <strong>{origin}</strong>.
          The operator of this service is responsible for handling your information.
        </div>

        <div className="privacy-highlight">
          <strong>OpenReader does not sell your personal information.</strong> We do not sell data to data brokers or third parties.
          We use data solely to provide and improve the reading experience.
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              1. Information We Collect (CCPA Categories)
            </h2>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              We collect information that identifies, relates to, describes, references, or is reasonably capable of being associated with you (&quot;<strong>Personal Information</strong>&quot;).
            </p>
            <div className="privacy-card landing-panel">
              <div className="privacy-card-label">Categories Collected</div>
              <ul className="space-y-3">
                <li>
                  <strong className="text-foreground">Identifiers:</strong> Email address, IP address, unique personal identifier (session token), and account name.
                  <div className="text-xs text-muted-foreground mt-1">Source: Directly from you. Purpose: Authentication, security, providing service.</div>
                </li>
                <li>
                  <strong className="text-foreground">Customer Records:</strong> Uploaded documents (PDF, EPUB), reading progress, bookmarks, and preferences.
                  <div className="text-xs text-muted-foreground mt-1">Source: Directly from you. Purpose: Providing core reading functionality.</div>
                </li>
                <li>
                  <strong className="text-foreground">Internet Activity:</strong> Browsing history within the app, interaction with features (Analytics).
                  <div className="text-xs text-muted-foreground mt-1">Source: Automatic collection. Purpose: Debugging, performance optimization.</div>
                </li>
              </ul>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              2. How We Use Your Information
            </h2>
            <ul className="list-disc pl-5 space-y-2 text-sm text-foreground/90">
              <li>To provide, support, and personalize the OpenReader application.</li>
              <li>To process your uploaded documents for display and text-to-speech conversion.</li>
              <li>To maintain the safety, security, and integrity of our service.</li>
              <li>To debug and repair errors that impair existing intended functionality.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              3. Sharing &amp; Selling
            </h2>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              <strong>We do not sell your personal information.</strong>
            </p>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              We may &quot;share&quot; (as defined by CPRA for cross-context behavioral advertising) anonymous usage data with analytics providers solely to improve our app. You can opt-out of this sharing via the Cookie Banner, and Global Privacy Control (GPC) signals are automatically honored.
            </p>
            <div className="privacy-card landing-panel">
              <div className="privacy-card-label">Service Providers (Sub-processors)</div>
              {process.env.RICHARDRDEV_PRODUCTION === 'true' ? (
                <ul className="grid gap-2 sm:grid-cols-2 mt-2">
                  <li className="text-sm"><strong>Vercel:</strong> Hosting, Edge Functions &amp; Analytics</li>
                  <li className="text-sm"><strong>Neon (PostgreSQL):</strong> Database Storage</li>
                  <li className="text-sm"><strong>Railway (S3):</strong> Encrypted Object Storage (Documents)</li>
                  <li className="text-sm"><strong>DeepInfra:</strong> Text-to-Speech Processing (User-Initiated)</li>
                </ul>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 mt-2">
                  <li className="text-sm"><strong>Hosting Provider:</strong> Application Hosting &amp; Logs</li>
                  <li className="text-sm"><strong>Database Service:</strong> Relational Database Storage</li>
                  <li className="text-sm"><strong>Object Storage:</strong> Encrypted File Storage (Documents)</li>
                  <li className="text-sm"><strong>TTS Provider:</strong> Text-to-Speech Processing (Optional)</li>
                </ul>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              4. Your Rights (CCPA/CPRA)
            </h2>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              You have the following rights regarding your personal information:
            </p>
            <div className="privacy-card landing-panel">
              <ul className="space-y-2">
                <li><strong>Right to Know:</strong> You may request details about the categories and specific pieces of personal information we have collected.</li>
                <li><strong>Right to Delete:</strong> You may request deletion of your personal information (via &quot;Delete Account&quot; in Settings).</li>
                <li><strong>Right to Correct:</strong> You may update your account information in Settings.</li>
                <li><strong>Right to Opt-Out:</strong> We do not sell data. You may opt-out of analytics &quot;sharing&quot; via our Cookie Banner.</li>
                <li><strong>Right to Non-Discrimination:</strong> We will not discriminate against you for exercising your privacy rights.</li>
              </ul>
            </div>
            <div className="mt-4">
              <p className="text-sm text-foreground/90 mb-2">
                <strong>How to Exercise Your Rights:</strong>
              </p>
              <ul className="list-disc pl-5 text-sm text-foreground/90">
                <li><strong>Export Data:</strong> Use the &quot;Export My Data&quot; button in Settings to download your account metadata plus object-storage-backed document and audiobook files.</li>
                <li><strong>Delete Data:</strong> Use the &quot;Delete Account&quot; button in Settings.</li>
              </ul>
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              5. Data Retention
            </h2>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              We retain your account data and uploaded files only for as long as you maintain an account.
              Uploaded documents are stored <strong>encrypted at rest (AES-256)</strong>.
              Upon account deletion, all data is permanently removed from our active databases and storage buckets immediately.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              6. Contact Us
            </h2>
            <p className="mb-4 text-sm leading-relaxed text-foreground/90">
              If you have questions or concerns about this Privacy Policy, please contact the instance administrator via the repository:
            </p>
            <a
              href="https://github.com/richardr1126/openreader/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline font-medium"
            >
              OpenReader Issues
            </a>
          </section>
        </div>

        <p className="privacy-note mt-12 pt-8 border-t border-border">
          For maximum privacy, you can self-host OpenReader using the{' '}
          <a
            href="https://github.com/richardr1126/openreader#readme"
            target="_blank"
            rel="noopener noreferrer"
          >
            open-source repository
          </a>.
        </p>

        <Link href="/?redirect=false" className="privacy-back">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8H3M7 4l-4 4 4 4" /></svg>
          Back to home
        </Link>
      </div>
    </>
  );
}
