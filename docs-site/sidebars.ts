import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    'intro',
    {
      type: 'doc',
      id: 'docker-quick-start',
      label: '🐳 Docker Quick Start',
    },
    {
      type: 'category',
      label: '⚙️ Configure',
      items: [
        {
          type: 'category',
          label: '🔊 TTS Providers',
          link: {
            type: 'doc',
            id: 'configure/tts-providers',
          },
          items: [
            'configure/tts-provider-guides/kokoro-fastapi',
            'configure/tts-provider-guides/orpheus-fastapi',
            'configure/tts-provider-guides/deepinfra',
            'configure/tts-provider-guides/openai',
            'configure/tts-provider-guides/custom-openai',
          ],
        },
        {
          type: 'doc',
          id: 'configure/auth',
          label: '🔐 Auth',
        },
        {
          type: 'doc',
          id: 'configure/server-library-import',
          label: '📥 Server Library Import',
        },
        'configure/tts-rate-limiting',
        'configure/database',
        'configure/object-blob-storage',
        'configure/migrations',
      ],
    },
    {
      type: 'category',
      label: '🚀 Deploy',
      items: ['deploy/local-development', 'deploy/vercel-deployment'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/environment-variables',
        'reference/stack',
      ],
    },
    {
      type: 'category',
      label: 'About',
      items: ['about/support-and-contributing', 'about/acknowledgements', 'about/license'],
    },
  ],
};

export default sidebars;
