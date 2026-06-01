import type { ReactNode } from 'react';

export function Section({
  title,
  subtitle,
  children,
  action,
  variant = 'panel',
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  variant?: 'panel' | 'flat';
}) {
  if (variant === 'flat') {
    return (
      <section className="space-y-2 pb-3 border-b border-line-soft last:border-b-0">
        <SectionHeading title={title} subtitle={subtitle} action={action} />
        {children}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-surface overflow-hidden">
      <div className="px-3 py-2 bg-surface-solid border-b border-line-soft">
        <SectionHeading title={title} subtitle={subtitle} action={action} />
      </div>
      <div className="px-3 py-2 space-y-2">{children}</div>
    </section>
  );
}

function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle ? <p className="text-xs text-soft mt-0.5">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
