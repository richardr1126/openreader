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
    <div className="flex h-[min(680px,calc(100dvh-3rem))] flex-col bg-surface sm:h-[490px]">
      <div className="flex items-center gap-3 border-b border-line-soft bg-background px-4 py-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">Changelog</h4>
          <p className="truncate text-xs text-soft">
            {normalizedAppVersion
              ? `Current version: v${normalizedAppVersion}`
              : 'Release history from GitHub'}
          </p>
        </div>
        <IconButton
          onClick={onClose}
          aria-label="Close changelog"
          title="Close changelog"
          className="ml-auto shrink-0"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </IconButton>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && <div className="py-3 text-sm text-soft">Loading changelog…</div>}

        {!loading && error && (
          <div className="space-y-2 border-b border-line-soft py-3">
            <p className="text-sm text-foreground">Could not load changelog right now.</p>
            <p className="break-words text-xs text-soft">{error}</p>
            <a
              href="https://github.com/richardr1126/openreader/releases"
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs font-medium text-accent transition duration-base ease-standard hover:underline"
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
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition duration-base ease-standard hover:border-accent-line hover:bg-accent-wash"
              >
                <ChevronRightIcon
                  className={`h-3.5 w-3.5 shrink-0 text-soft transition-transform ${
                    isExpanded ? 'rotate-90 text-foreground' : ''
                  }`}
                />
                <div className="flex min-w-0 w-full items-center gap-2 text-sm">
                  <span className="shrink-0 font-semibold text-foreground">{entry.tag_name}</span>
                  {entry.prerelease && (
                    <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-soft">
                      prerelease
                    </span>
                  )}
                  {isCurrent && (
                    <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      current
                    </span>
                  )}
                  {showName && <span className="truncate text-xs text-soft">{entry.name}</span>}
                  <span className="ml-auto hidden shrink-0 text-[11px] text-soft xs:inline">
                    {new Date(entry.published_at).toLocaleDateString()}
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="space-y-2 pb-3 pl-6 pr-1 pt-1">
                  {body ? (
                    <div className="space-y-2 text-sm leading-6 text-foreground [&_a]:text-accent [&_a]:transition-colors [&_a]:hover:underline [&_code]:rounded [&_code]:bg-surface-sunken [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface-sunken [&_pre]:p-2 [&_ul]:pl-5">
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
                    className="inline-flex text-xs font-medium text-accent transition duration-base ease-standard hover:underline"
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
