export const btnBase =
  'inline-flex items-center justify-center rounded-md text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast ease-standard disabled:opacity-50 disabled:cursor-not-allowed';
export const btnPrimary = `${btnBase} bg-accent text-background hover:bg-secondary-accent`;
export const btnSecondary = `${btnBase} bg-base text-foreground border border-offbase hover:bg-offbase`;
export const btnOutline = `${btnBase} bg-background border border-offbase text-foreground hover:bg-base hover:text-accent`;
export const btnDanger = `${btnBase} bg-danger text-background border border-danger hover:bg-danger`;
export const btnGhost = `${btnBase} bg-transparent text-foreground hover:bg-base hover:text-accent`;

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: btnPrimary,
  secondary: btnSecondary,
  outline: btnOutline,
  danger: btnDanger,
  ghost: btnGhost,
};

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs rounded-md',
  sm: 'h-7 px-2.5 text-xs rounded-md',
  md: 'h-8 px-3 text-sm rounded-md',
  lg: 'h-10 px-4 text-base rounded-lg',
  icon: 'h-8 w-8 rounded-md p-0',
};

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return [BUTTON_VARIANT_CLASS[variant], BUTTON_SIZE_CLASS[size], className].filter(Boolean).join(' ');
}
