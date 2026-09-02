'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRightIcon } from '@/components/icons/Icons';
import { IconButton } from '@/components/ui';
import { useChangelogManifest, useChangelogReleaseBodies } from '@/hooks/useChangelog';
import { findCurrentVersionIndex, normalizeVersion } from '@/lib/shared/changelog';

export function SettingsChangelogPanel({
  appVersion,
  manifestUrl,
  onClose,
}: {
  appVersion: string;
  manifestUrl: string;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const normalizedAppVersion = normalizeVersion(appVersion || '');
  const { data: manifest = [], isLoading: loading, error: manifestError } = useChangelogManifest(manifestUrl);
  const error = manifestError
    ? (manifestError instanceof Error ? manifestError.message : 'Failed to load changelog')
    : null;
  const bodies = useChangelogReleaseBodies(manifestUrl, manifest, expanded);
  const didInitExpandRef = useRef(false);

  useEffect(() => {
    if (didInitExpandRef.current || manifest.length === 0) return;
    const initialIndex = findCurrentVersionIndex(manifest, normalizedAppVersion);
    if (initialIndex >= 0) {
      didInitExpandRef.current = true;
      const entry = manifest[initialIndex];
      setExpanded((previous) => ({ ...previous, [entry.tag_name]: true }));
    }
  }, [manifest, normalizedAppVersion]);

  return (
    <div className="h-[490px] flex flex-col bg-surface">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-line-soft bg-background">
        <IconButton onClick={onClose} aria-label="Back to settings" title="Back">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </IconButton>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">Changelog</h4>
          <p className="text-xs text-soft truncate">
            {normalizedAppVersion
              ? `Current version: v${normalizedAppVersion}`
              : 'Release history from GitHub'}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && <div className="py-3 text-sm text-soft">Loading changelog…</div>}

        {!loading && error && (
          <div className="py-3 space-y-2 border-b border-line-soft">
            <p className="text-sm text-foreground">Could not load changelog right now.</p>
            <p className="text-xs text-soft break-words">{error}</p>
            <a
              href="https://github.com/richardr1126/openreader/releases"
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs font-medium text-accent hover:underline transition duration-base ease-standard transform"
            >
              Open GitHub Releases
            </a>
          </div>
        )}

        {!loading && !error && manifest.length === 0 && (
          <div className="py-3 text-sm text-soft">No releases found.</div>
        )}

        {!loading && !error && manifest.map((entry) => {
          const isCurrent = Boolean(
            normalizedAppVersion && normalizeVersion(entry.tag_name) === normalizedAppVersion,
          );
          const body = bodies[entry.tag_name];
          const isExpanded = Boolean(expanded[entry.tag_name]);
          const normalizedTag = normalizeVersion(entry.tag_name);
          const normalizedName = normalizeVersion(entry.name || '');
          const showName = Boolean(entry.name) && normalizedName !== normalizedTag;

          return (
            <div key={entry.tag_name} className="border-b border-line-soft">
              <button
                type="button"
                onClick={() => setExpanded((previous) => ({
                  ...previous,
                  [entry.tag_name]: !isExpanded,
                }))}
                className="w-full rounded-md border border-transparent px-2 py-2 text-left flex items-center gap-2 transition duration-base ease-standard hover:border-accent-line hover:bg-accent-wash"
              >
                <ChevronRightIcon
                  className={`w-3.5 h-3.5 shrink-0 text-soft transition-transform ${
                    isExpanded ? 'rotate-90 text-foreground' : ''
                  }`}
                />
                <div className="min-w-0 flex items-center gap-2 text-sm w-full">
                  <span className="font-semibold text-foreground shrink-0">{entry.tag_name}</span>
                  {entry.prerelease && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-surface-sunken text-soft shrink-0">
                      prerelease
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 bg-surface-sunken text-accent shrink-0">
                      current
                    </span>
                  )}
                  {showName && <span className="text-xs text-soft truncate">{entry.name}</span>}
                  <span className="text-[11px] text-soft shrink-0">
                    {new Date(entry.published_at).toLocaleDateString()}
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="pl-6 pr-1 pb-3 pt-1 space-y-2">
                  {body ? (
                    <div className="text-sm text-foreground leading-6 space-y-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:bg-surface-sunken [&_code]:rounded [&_code]:px-1 [&_pre]:bg-surface-sunken [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_a]:text-accent [&_a]:hover:underline [&_a]:transition-colors">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {body.body || '_No release notes provided._'}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-xs text-soft">Loading release notes…</p>
                  )}
                  <a
                    href={entry.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex text-xs font-medium text-accent hover:underline transition duration-base ease-standard transform"
                  >
                    View on GitHub
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
