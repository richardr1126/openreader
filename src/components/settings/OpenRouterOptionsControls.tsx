'use client';
import { useId, useState } from 'react';
import { Button, RowIcon, Textarea, cn } from '@/components/ui';
import { DisclosureIcon, WrenchIcon } from '@/components/icons/Icons';
import { openRouterCapabilities } from '@openreader/tts/openrouter';
import { AnimatedCollapse } from './ExpandableSettingsCard';

/** Request options bound to one OpenRouter model, behind their own disclosure beside the model picker. */
export function OpenRouterOptionsControls({ model, modelName, value, error, onChange }: {
  model: string; modelName: string; value: string; error?: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const errorId = useId();
  const template = JSON.stringify({ provider: { options: { [openRouterCapabilities(model).providerSlug]: {} } } }, null, 2);
  const set = !!value.trim();
  return <div>
    <button type="button" aria-label="Advanced model options" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}
      className="flex w-full items-center gap-3 rounded-md text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <RowIcon><WrenchIcon /></RowIcon>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block font-medium">Advanced model options</span>
        <span className="block text-xs leading-4 text-soft">{error ? 'Invalid JSON' : set ? `Custom for ${modelName}` : 'None'}</span>
      </span>
      <DisclosureIcon className={`h-4 w-4 shrink-0 text-faint transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
    </button>
    <AnimatedCollapse open={open} id={id}>
      <div className="space-y-2 pt-3">
        <p className="text-xs text-soft">
          JSON sent with each {modelName} request: <code>provider.options</code> keyed by provider, data policy, or public HTTPS <code>input_references</code>. Changing the model clears it. See the <a href="https://openrouter.ai/docs/guides/overview/multimodal/tts#provider-specific-options" target="_blank" rel="noreferrer" className="text-accent underline">OpenRouter speech guide</a>.
        </p>
        <Textarea aria-label="Model options" value={value} onChange={event => onChange(event.target.value)}
          placeholder={template} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          className={cn('min-h-28 font-mono text-xs', error && '!border-danger focus:!ring-danger')} maxLength={16000} spellCheck={false} />
        <div className="flex items-center gap-2">
          {error ? <p id={errorId} role="alert" className="flex-1 text-xs text-danger">{error}</p> : <span className="flex-1" />}
          {set
            ? <Button size="xs" variant="ghost" onClick={() => onChange('')}>Clear</Button>
            : <Button size="xs" variant="ghost" onClick={() => onChange(template)}>Insert template</Button>}
        </div>
      </div>
    </AnimatedCollapse>
  </div>;
}
