/** Outbound links and app facts, safe to import from client components. */
export const LINKS = {
  docs: 'https://docs.openreader.richardr.dev/',
  deploy: 'https://docs.openreader.richardr.dev/deploy/docker-compose',
  desktopDocs: 'https://docs.openreader.richardr.dev/desktop-app',
  repo: 'https://github.com/richardr1126/openreader',
  readme: 'https://github.com/richardr1126/openreader#readme',
  discussions: 'https://github.com/richardr1126/openreader/discussions',
  issues: 'https://github.com/richardr1126/openreader/issues',
  license: 'https://github.com/richardr1126/openreader/blob/main/LICENSE',
  releases: 'https://github.com/richardr1126/openreader/releases',
  releaseFeed: 'https://docs.openreader.richardr.dev/changelog/manifest.json',
  testflight: 'https://testflight.apple.com/join/eJTYjDwV',
} as const;

/** The native Swift app for iPhone, iPad, and Mac, before any voice downloads. */
export const NATIVE_APP_BYTES = 38_200_000;
