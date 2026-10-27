'use client';
import { useId, useState } from 'react';
import { Button, RowIcon, Textarea, cn } from '@/components/ui';
import { DisclosureIcon, WrenchIcon } from '@/components/icons/Icons';
import { normalizeOpenRouterOptions, openRouterCapabilities } from '@openreader/tts/openrouter';
import { AnimatedCollapse } from './ExpandableSettingsCard';

/** Normalized options carry their model; show only what the admin or user wrote. */
export function readableOpenRouterOptions(normalized: string | null | undefined): string {
  if (!normalized) return '';
  const options = JSON.parse(normalized) as Record<string, unknown>;
  delete options.model;
  return JSON.stringify(options, null, 2);
}

function sameOptions(a: string, b: string, model: string): boolean {
  try {
    return normalizeOpenRouterOptions(a, model) === normalizeOpenRouterOptions(b, model);
  } catch {
    return false;
  }
}

/**
 * JSON request options bound to one OpenRouter model. `providerDefault` is the
 * admin's readable JSON for this model; the box starts from it and a user's
 * edits replace it.
 */
export function OpenRouterOptionsEditor({ model, modelName, value, providerDefault = '', error, onChange }: {
  model: string; modelName: string; value: string; providerDefault?: string; error?: string; onChange: (value: string) => void;
}) {
  const errorId = useId();
  const template = JSON.stringify({ provider: { options: { [openRouterCapabilities(model).providerSlug]: {} } } }, null, 2);
  const followsDefault = !!providerDefault && sameOptions(value, providerDefault, model);
  return <div className="space-y-2">
    <p className="text-xs text-soft">
      JSON sent with each {modelName} request: <code>provider.options</code> keyed by provider, data policy, or public HTTPS <code>input_references</code>. Changing the model {providerDefault ? 'restores the provider default' : 'clears it'}. See the <a href="https://openrouter.ai/docs/guides/overview/multimodal/tts#provider-specific-options" target="_blank" rel="noreferrer" className="text-accent underline">OpenRouter speech guide</a>.
    </p>
    <Textarea aria-label="Model options" value={value} onChange={event => onChange(event.target.value)}
      placeholder={template} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
      className={cn('min-h-28 font-mono text-xs', error && '!border-danger focus:!ring-danger')} maxLength={16000} spellCheck={false} />
    <div className="flex items-center gap-2">
      {error ? <p id={errorId} role="alert" className="flex-1 text-xs text-danger">{error}</p> : <span className="flex-1" />}
      {providerDefault
        ? !followsDefault && <Button size="xs" variant="ghost" onClick={() => onChange(providerDefault)}>Use provider default</Button>
        : value.trim()
          ? <Button size="xs" variant="ghost" onClick={() => onChange('')}>Clear</Button>
          : <Button size="xs" variant="ghost" onClick={() => onChange(template)}>Insert template</Button>}
    </div>
  </div>;
}

/** The editor behind its own disclosure beside the model picker. */
export function OpenRouterOptionsControls(props: Parameters<typeof OpenRouterOptionsEditor>[0]) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const status = props.error ? 'Invalid JSON'
    : props.providerDefault && sameOptions(props.value, props.providerDefault, props.model) ? 'Provider default'
    : props.value.trim() ? `Custom for ${props.modelName}`
    : 'None';
  return <div>
    <button type="button" aria-label="Advanced model options" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}
      className="flex w-full items-center gap-3 rounded-md text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <RowIcon><WrenchIcon /></RowIcon>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block font-medium">Advanced model options</span>
        <span className="block text-xs leading-4 text-soft">{status}</span>
      </span>
      <DisclosureIcon className={`h-4 w-4 shrink-0 text-faint transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
    </button>
    <AnimatedCollapse open={open} id={id}>
      <div className="pt-3"><OpenRouterOptionsEditor {...props} /></div>
    </AnimatedCollapse>
  </div>;
}
