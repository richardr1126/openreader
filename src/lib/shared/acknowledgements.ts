/**
 * Shape of `public/acknowledgements.json`, which
 * `scripts/collect-acknowledgements.mjs` generates from the production
 * dependency tree and `scripts/acknowledgements/manifest.json`. It is a static
 * asset fetched by Settings → About, so the licence texts never enter the
 * server bundle or other pages' JavaScript.
 */
export const ACKNOWLEDGEMENTS_URL = '/acknowledgements.json';

export type AcknowledgementKind = 'binary' | 'model' | 'npm';

export interface Acknowledgement {
  name: string;
  versions: string[];
  kind: AcknowledgementKind;
  /** SPDX expression as the component declares it. */
  license: string;
  /** What it does here, or the package's own description. */
  role?: string;
  /** Attribution that is not a copyright line in the licence file. */
  notice?: string;
  url: string;
  /** Copyright lines taken out of the shared licence text. */
  copyright: string[];
  /** Keys into {@link AcknowledgementsData.texts}; empty when the package ships no licence file. */
  textIds: string[];
}

export interface AcknowledgementsData {
  components: Acknowledgement[];
  texts: Record<string, string>;
}

export function filterAcknowledgements(components: Acknowledgement[], query: string): Acknowledgement[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return components;
  return components.filter((component) => (
    component.name.toLowerCase().includes(needle) || component.license.toLowerCase().includes(needle)
  ));
}
