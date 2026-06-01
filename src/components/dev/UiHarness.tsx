'use client';

import { useState } from 'react';
import { THEMES, useTheme } from '@/contexts/ThemeContext';
import {
  Badge,
  Button,
  Card,
  CheckItem,
  Divider,
  Field,
  IconButton,
  Input,
  Panel,
  Section,
  Select,
  Sidebar,
  Surface,
  Switch,
  Textarea,
  ToggleRow,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSegment,
  buttonClass,
  dropzoneSurfaceClass,
  popoverPanelClass,
  rangeInputClass,
} from '@/components/ui';

const THEME_OPTIONS = THEMES.filter((theme) => theme !== 'custom');

export function UiHarness() {
  const { theme, setTheme } = useTheme();
  const [enabled, setEnabled] = useState(true);
  const [checked, setChecked] = useState(false);
  const [selectValue, setSelectValue] = useState('library');

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-elev-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Badge tone="accent">Authenticated dev surface</Badge>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">UI system harness</h1>
            <p className="mt-1 max-w-2xl text-sm text-soft">
              Review shared primitives, state tokens, and theme behavior from the authenticated app shell.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary">Primary action</Button>
            <Button variant="secondary">Secondary</Button>
          </div>
        </header>

        <Section
          title="Theme Matrix"
          subtitle="Switches the real document theme so token regressions are visible in context."
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                className={buttonClass({
                  variant: theme === option ? 'primary' : 'outline',
                  size: 'sm',
                  className: 'capitalize',
                })}
              >
                {option}
              </button>
            ))}
          </div>
        </Section>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel className="space-y-4 p-4" elevation="2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="secondary" disabled>Disabled</Button>
              <IconButton aria-label="Refresh sample">↻</IconButton>
              <IconButton aria-label="Danger sample" tone="danger">×</IconButton>
            </div>

            <Divider />

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Reader name" hint="Field, input, and hint tokens.">
                <Input placeholder="OpenReader" />
              </Field>
              <Field label="Mode">
                <Select
                  value={selectValue}
                  onChange={setSelectValue}
                  options={[
                    { value: 'library', label: 'Library' },
                    { value: 'reader', label: 'Reader' },
                    { value: 'player', label: 'Player' },
                  ]}
                />
              </Field>
              <Field label="Notes" className="md:col-span-2">
                <Textarea rows={3} placeholder="Textarea state preview" />
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ToggleRow
                label="Calm motion"
                description="Feedback-only transitions, no ambient movement."
                checked={enabled}
                onChange={setEnabled}
              />
              <Card>
                <CheckItem label="Parsed text available" checked={checked} onChange={setChecked} />
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm text-soft">Direct switch sample</span>
                  <Switch checked={enabled} onChange={setEnabled} ariaLabel="Toggle direct switch sample" />
                </div>
              </Card>
            </div>

            <Surface tone="sunken" className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Range control</span>
                <Badge tone="foreground">1.2x</Badge>
              </div>
              <input className={rangeInputClass} type="range" min="0.5" max="3" step="0.1" defaultValue="1.2" />
            </Surface>
          </Panel>

          <Sidebar className="min-h-full p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Sidebar</span>
              <Badge>Nav</Badge>
            </div>
            <div className="space-y-1">
              {['Library', 'Reader', 'Audio', 'Settings'].map((item, index) => (
                <button
                  key={item}
                  type="button"
                  className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast ease-standard ${
                    index === 0 ? 'bg-accent-wash text-accent' : 'text-soft hover:bg-accent-wash hover:text-accent'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </Sidebar>
        </div>

        <Panel elevation="1">
          <Toolbar className="static">
            <ToolbarGroup>
              <ToolbarSegment active>List</ToolbarSegment>
              <ToolbarSegment>Grid</ToolbarSegment>
              <ToolbarSegment>Gallery</ToolbarSegment>
            </ToolbarGroup>
            <ToolbarButton active>Sort by name</ToolbarButton>
            <ToolbarButton>Recently opened</ToolbarButton>
          </Toolbar>
          <div className="grid gap-4 p-4 md:grid-cols-3">
            <div className={dropzoneSurfaceClass({ active: false })}>
              <p className="text-sm font-medium text-foreground">Dropzone idle</p>
              <p className="mt-1 text-xs text-soft">Border and wash states live in `dropzoneStyles`.</p>
            </div>
            <div className={dropzoneSurfaceClass({ active: true })}>
              <p className="text-sm font-medium">Dropzone active</p>
              <p className="mt-1 text-xs">Drag feedback uses tokenized state colors.</p>
            </div>
            <div className={popoverPanelClass}>
              <p className="text-sm font-medium text-foreground">Popover panel</p>
              <p className="mt-1 text-xs text-soft">Shared shell for player and reader controls.</p>
            </div>
          </div>
        </Panel>
      </div>
    </main>
  );
}
