import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: '🚀 Get Started',
      collapsed: false,
      items: [
        { type: 'doc', id: 'desktop-app', label: '💻 Desktop App' },
        { type: 'doc', id: 'docker-quick-start', label: '🐳 Docker Quick Start' },
      ],
    },
    {
      type: 'category',
      label: '📖 Using OpenReader',
      items: [
        'guide/library',
        'guide/reading-and-listening',
        'guide/audiobook-export',
        'guide/keyboard-shortcuts',
      ],
    },
    {
      type: 'category',
      label: '🖥️ Self-Hosting',
      items: [
        'deploy/docker-compose',
        'deploy/vercel-deployment',
        'deploy/compute-worker',
        'deploy/upgrade-from-v4',
      ],
    },
    {
      type: 'category',
      label: '🛡️ Administration',
      link: { type: 'doc', id: 'configure/admin-panel' },
      items: [
        'configure/auth',
        {
          type: 'category',
          label: 'TTS Providers',
          link: { type: 'doc', id: 'configure/tts-providers' },
          items: [
            'configure/tts-provider-guides/kokoro-fastapi',
            'configure/tts-provider-guides/kitten-tts-fastapi',
            'configure/tts-provider-guides/orpheus-fastapi',
            'configure/tts-provider-guides/supertonic',
            'configure/tts-provider-guides/replicate',
            'configure/tts-provider-guides/google-ai-studio',
            'configure/tts-provider-guides/openai',
            'configure/tts-provider-guides/other',
          ],
        },
        'configure/instance-settings',
        'configure/compute-rate-limiting',
        'configure/maintenance',
      ],
    },
    {
      type: 'category',
      label: '🧰 Infrastructure Reference',
      items: [
        'reference/environment-variables',
        'configure/database',
        'configure/object-blob-storage',
        'configure/server-library-import',
      ],
    },
    {
      type: 'category',
      label: '🛠️ Contributing',
      items: ['deploy/local-development', 'reference/stack'],
    },
    {
      type: 'category',
      label: 'About',
      items: ['about/support-and-contributing', 'about/acknowledgements', 'about/license'],
    },
  ],
};

export default sidebars;
