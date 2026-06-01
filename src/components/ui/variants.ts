import { cn, type ClassValue } from './cn';

type VariantGroups = Record<string, Record<string, string>>;
type VariantSelection<T extends VariantGroups> = {
  [K in keyof T]?: keyof T[K] | null | undefined;
};

export function variants<T extends VariantGroups>({
  base,
  variants: groups,
  defaults,
}: {
  base?: string;
  variants: T;
  defaults?: VariantSelection<T>;
}) {
  return (selection: VariantSelection<T> & { className?: ClassValue } = {}) => {
    const resolved = Object.keys(groups).map((key) => {
      const groupKey = key as keyof T;
      const value = selection[groupKey] ?? defaults?.[groupKey];
      return value ? groups[groupKey][value as keyof T[typeof groupKey]] : '';
    });
    return cn(base, ...resolved, selection.className);
  };
}
