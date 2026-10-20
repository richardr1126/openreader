import type { ReactNode } from 'react';
import { Button } from './button';

/**
 * The floating bar a settings panel shows while it has unsaved edits. It sticks
 * to the bottom of the scrolling settings pane, so Save stays in reach however
 * long the panel is. Panels render it last and only while `dirty || saving`.
 */
export function SaveBar({
  count,
  saving,
  saveDisabled,
  onDiscard,
  onSave,
  children,
}: {
  /** Number of edited fields; omitted when a panel saves as one form. */
  count?: number;
  saving: boolean;
  saveDisabled?: boolean;
  onDiscard: () => void;
  onSave: () => void;
  /** Extra actions placed before Discard. */
  children?: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-solid px-3 py-2 shadow-elev-3"
    >
      <p className="text-xs text-soft">
        {count === undefined ? 'Unsaved changes' : `${count} unsaved change${count === 1 ? '' : 's'}`}
      </p>
      <div className="flex gap-2">
        {children}
        <Button onClick={onDiscard} disabled={saving} variant="secondary" size="sm">
          Discard
        </Button>
        <Button
          onClick={onSave}
          disabled={saving || saveDisabled}
          aria-busy={saving}
          variant="primary"
          size="sm"
        >
          {saving ? 'Saving…' : count === undefined ? 'Save' : `Save (${count})`}
        </Button>
      </div>
    </div>
  );
}
