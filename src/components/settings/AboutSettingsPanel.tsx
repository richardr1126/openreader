'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, SearchIcon } from '@/components/icons/Icons';
import { Badge, ButtonAnchor, SearchField, Section } from '@/components/ui';
import { QueryError } from '@/components/ui/query-states';
import { requestJson } from '@/lib/client/api/http';
import { queryKeys } from '@/lib/client/query-keys';
import {
  ACKNOWLEDGEMENTS_URL,
  filterAcknowledgements,
  type Acknowledgement,
  type AcknowledgementKind,
  type AcknowledgementsData,
} from '@/lib/shared/acknowledgements';

const TIP_URL = 'https://buymeacoffee.com/rich2556';

const GROUPS: { kind: AcknowledgementKind; title: string; subtitle: string }[] = [
  { kind: 'binary', title: 'Programs', subtitle: 'Bundled with the Docker image.' },
  { kind: 'model', title: 'Models', subtitle: 'Downloaded by the compute worker when first needed.' },
  { kind: 'npm', title: 'Packages', subtitle: 'npm production dependencies of the app, compute worker and startup.' },
];

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex text-xs font-medium text-accent transition-colors duration-base hover:underline"
    >
      {children}
      <span aria-hidden="true">&nbsp;↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function SupportSection() {
  return (
    <Section variant="group" title="Support">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-foreground">Support OpenReader</div>
          <div className="mt-0.5 text-xs text-faint">
            OpenReader is free and open source. If it is useful to you, you can leave a tip.
          </div>
        </div>
        <ButtonAnchor href={TIP_URL} target="_blank" rel="noopener noreferrer" size="sm">
          Buy Me a Coffee<span aria-hidden="true">&nbsp;↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </ButtonAnchor>
      </div>
    </Section>
  );
}

function AcknowledgementRow({ component, texts }: { component: Acknowledgement; texts: Record<string, string> }) {
  // Licence texts render only while open: hundreds of closed rows stay light.
  const [open, setOpen] = useState(false);
  const versions = component.versions.join(', ');
  return (
    <details className="group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-soft transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {component.name}
          {versions ? <span className="ml-1.5 text-xs text-faint">{versions}</span> : null}
        </span>
        <Badge className="shrink-0">{component.license}</Badge>
      </summary>
      {open ? (
        <div className="space-y-2 pb-1 pl-5 pt-2">
          {component.role ? <p className="text-xs text-soft">{component.role}</p> : null}
          {component.notice ? <p className="text-xs text-soft">{component.notice}</p> : null}
          {component.copyright.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-soft">
              {component.copyright.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
          <ExternalLink href={component.url}>Project page</ExternalLink>
          {component.textIds.length === 0 ? (
            <p className="text-xs text-faint">
              The published package includes no licence file; it declares {component.license}.
            </p>
          ) : component.textIds.map((id) => (
            <pre
              key={id}
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-soft bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-foreground"
            >
              {texts[id] ?? 'Licence text missing from this build.'}
            </pre>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function AcknowledgementsSections({ data }: { data: AcknowledgementsData }) {
  const [query, setQuery] = useState('');
  const packages = useMemo(() => data.components.filter((component) => component.kind === 'npm'), [data]);
  const filteredPackages = useMemo(() => filterAcknowledgements(packages, query), [packages, query]);

  return (
    <>
      {GROUPS.map((group) => {
        const components = group.kind === 'npm'
          ? filteredPackages
          : data.components.filter((component) => component.kind === group.kind);
        return (
          <div key={group.kind} className="space-y-2">
            {group.kind === 'npm' ? (
              <SearchField
                aria-label="Filter packages"
                placeholder={`Filter ${packages.length} packages by name or licence`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                icon={<SearchIcon className="h-3.5 w-3.5" />}
                className="max-w-sm"
              />
            ) : null}
            <Section
              variant="group"
              title={group.title}
              subtitle={group.subtitle}
              action={`${components.length}`}
            >
              {components.length > 0
                ? components.map((component) => (
                  <AcknowledgementRow key={`${component.name}|${component.license}`} component={component} texts={data.texts} />
                ))
                : <p className="text-xs text-faint">No packages match.</p>}
            </Section>
          </div>
        );
      })}
    </>
  );
}

function AcknowledgementsList() {
  const { data, error, isPending, refetch, isRefetching } = useQuery({
    queryKey: queryKeys.acknowledgements(),
    queryFn: ({ signal }) => requestJson<AcknowledgementsData>(ACKNOWLEDGEMENTS_URL, { signal }, 'Could not load acknowledgements'),
    staleTime: Infinity,
  });

  return (
    <section aria-labelledby="acknowledgements-heading" className="space-y-3">
      <div className="px-1">
        <h3 id="acknowledgements-heading" className="text-sm font-semibold text-foreground">Acknowledgements</h3>
        <p className="mt-0.5 text-xs text-soft">
          OpenReader is built on these open-source projects and models. Thank you to everyone who writes and maintains them.
        </p>
      </div>
      {isPending ? <p className="px-1 text-sm text-soft">Loading acknowledgements…</p> : null}
      {error && !data ? <QueryError error={error} onRetry={() => void refetch()} retrying={isRefetching} /> : null}
      {data ? <AcknowledgementsSections data={data} /> : null}
    </section>
  );
}

/** Tip link and the open-source licences of what OpenReader ships; open to every user. */
export function AboutSettingsPanel() {
  return (
    <div className="space-y-5">
      <SupportSection />
      <AcknowledgementsList />
    </div>
  );
}
