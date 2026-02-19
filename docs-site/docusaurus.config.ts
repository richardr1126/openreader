import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'OpenReader Docs',
  tagline: 'Docs for OpenReader',
  favicon: 'favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://docs.openreader.richardr.dev',
  baseUrl: '/',

  organizationName: 'richardr1126',
  projectName: 'OpenReader',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/richardr1126/openreader/tree/main/docs-site/',
          // lastVersion: 'current',
          // versions: {
          //   current: {
          //     label: 'Current',
          //   },
          // },
        },
        blog: false,
        theme: {
          customCss: './custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        indexDocs: true,
        indexBlog: false,
        docsRouteBasePath: '/',
        language: ['en'],
        hashed: true,
        explicitSearchResultPath: true,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'OpenReader',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docsVersionDropdown',
          position: 'left',
        },
        {
          href: 'https://github.com/richardr1126/openreader',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      links: [
        {
          title: 'Community',
          items: [
            { label: 'Support', to: '/about/support-and-contributing' },
            { label: 'GitHub Discussions', href: 'https://github.com/richardr1126/openreader/discussions' },
            { label: 'Issues', href: 'https://github.com/richardr1126/openreader/issues' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/richardr1126/openreader' },
            { label: 'Releases', href: 'https://github.com/richardr1126/openreader/releases' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} OpenReader contributors.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
