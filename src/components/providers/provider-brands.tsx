import type { ReactNode } from 'react';
import { CpuChipIcon, ServerStackIcon } from '@/components/icons/Icons';
import { cn } from '@/components/ui';
import type { TtsProviderId } from '@openreader/tts/provider-catalog';

/**
 * How each provider type presents itself in the admin and voice settings:
 * its logo tile, name, and where to get a key. Marks are the companies' own
 * artwork (OpenAI and Replicate via Simple Icons, Google and Fish Audio
 * from their sites), drawn on the tile colour each brand uses.
 */
export interface ProviderBrand {
  name: string;
  /** What the provider offers, for the add-provider picker. */
  summary: string;
  apiKeyUrl?: string;
}

export const PROVIDER_BRANDS: Record<TtsProviderId, ProviderBrand> = {
  openrouter: { name: 'OpenRouter', summary: 'Speech models from many providers with one API key', apiKeyUrl: 'https://openrouter.ai/settings/keys' },
  'fish-audio': {
    name: 'Fish Audio',
    summary: 'S2.1 Pro, S2 Pro and Drama 3 with custom voice IDs',
    apiKeyUrl: 'https://fish.audio/app/api-keys',
  },
  openai: {
    name: 'OpenAI',
    summary: 'gpt-4o-mini-tts, tts-1 and tts-1-hd',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  'google-ai-studio': {
    name: 'Google AI Studio',
    summary: 'Gemini 3.8 Flash and Flash-Lite speech with expressive voices',
    apiKeyUrl: 'https://aistudio.google.com/api-keys',
  },
  replicate: {
    name: 'Replicate',
    summary: 'Gemini, MiniMax, Qwen, Kokoro or any model ID',
    apiKeyUrl: 'https://replicate.com/account/api-tokens',
  },
  'custom-openai': {
    name: 'OpenAI-compatible server',
    summary: 'Kokoro-FastAPI, Supertonic, Orpheus-FastAPI or any /v1/audio/speech endpoint',
  },
  'kokoro-local': {
    name: 'Kokoro-82M',
    summary: 'English, Spanish, Hindi, Italian and Brazilian Portuguese voices',
  },
};

/** External provider types in the order the add-provider picker shows them. */
export const EXTERNAL_PROVIDER_ORDER: readonly TtsProviderId[] = ['openrouter', 'fish-audio', 'openai', 'google-ai-studio', 'replicate', 'custom-openai'];

type LogoSize = 'sm' | 'md' | 'lg';

const TILE_SIZE: Record<LogoSize, string> = {
  sm: 'h-5 w-5 rounded p-[3px]',
  md: 'h-8 w-8 rounded-md p-1.5',
  lg: 'h-10 w-10 rounded-lg p-2',
};

function Tile({ size, className, children }: { size: LogoSize; className: string; children: ReactNode }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center justify-center', TILE_SIZE[size], className)}>
      {children}
    </span>
  );
}

export function ProviderLogo({ providerType, size = 'md' }: { providerType: TtsProviderId; size?: LogoSize }) {
  switch (providerType) {
    case 'fish-audio':
      return (
        <Tile size={size} className="bg-white ring-1 ring-inset ring-black/10">
          <svg viewBox="28 28 457 457" className="h-full w-full">
            <path fill="#b1b3b4" d="M476.53 249.75c4.64 0 8.41 3.77 8.41 8.41v11.67c0 4.65-3.77 8.41-8.41 8.41-4.65 0-8.42-3.76-8.42-8.41v-11.67c0-4.64 3.77-8.41 8.42-8.41zM442.88 256.79c4.65 0 8.41 3.77 8.41 8.42v33.01c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-33.01c0-4.65 3.77-8.42 8.41-8.42zM409.45 264.89c4.64 0 8.41 3.77 8.41 8.41v37.96c0 4.64-3.77 8.41-8.41 8.41-4.65 0-8.41-3.77-8.41-8.41v-37.96c0-4.64 3.76-8.41 8.41-8.41zM375.8 271.62c4.65 0 8.41 3.76 8.41 8.41v37.43c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-37.43c0-4.65 3.77-8.41 8.41-8.41zM342.16 277.61c4.64 0 8.41 3.77 8.41 8.41v31.54c0 4.65-3.77 8.42-8.41 8.42-4.65 0-8.41-3.77-8.41-8.42v-31.54c0-4.64 3.76-8.41 8.41-8.41zM308.72 301.69c4.65 0 8.41 3.76 8.41 8.41v5.68c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-5.68c0-4.65 3.77-8.41 8.41-8.41z" />
            <path fill="#000" d="M36.41 197.28c4.65 0 8.41 3.77 8.41 8.42v3.57c0 4.65-3.76 8.41-8.41 8.41-4.64 0-8.41-3.76-8.41-8.41v-3.57c0-4.65 3.77-8.42 8.41-8.42zM71 200.12c4.65 0 8.41 3.77 8.41 8.41v15.46c0 4.65-3.76 8.41-8.41 8.41-4.64 0-8.41-3.76-8.41-8.41v-15.46c0-4.64 3.77-8.41 8.41-8.41zM105.59 195.6c4.65 0 8.41 3.77 8.41 8.41v64.56c0 4.65-3.76 8.41-8.41 8.41-4.64 0-8.41-3.76-8.41-8.41v-64.56c0-4.64 3.77-8.41 8.41-8.41zM140.29 188.87c4.64 0 8.41 3.77 8.41 8.41v4.21c0 4.65-3.77 8.41-8.41 8.41-4.65 0-8.41-3.76-8.41-8.41v-4.21c0-4.64 3.76-8.41 8.41-8.41zM140.29 245.02c4.64 0 8.41 3.76 8.41 8.41v44.47c0 4.65-3.77 8.41-8.41 8.41-4.65 0-8.41-3.76-8.41-8.41v-44.47c0-4.65 3.76-8.41 8.41-8.41zM442.88 181.72c4.65 0 8.41 3.77 8.41 8.42v46.47c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-46.47c0-4.65 3.77-8.42 8.41-8.42zM409.45 174.26c4.64 0 8.41 3.77 8.41 8.41v62.45c0 4.65-3.77 8.41-8.41 8.41-4.65 0-8.41-3.76-8.41-8.41v-62.45c0-4.64 3.76-8.41 8.41-8.41zM375.8 171c4.65 0 8.41 3.77 8.41 8.41v74.23c0 4.65-3.76 8.41-8.41 8.41-4.64 0-8.41-3.76-8.41-8.41v-74.23c0-4.64 3.77-8.41 8.41-8.41zM342.16 173.1c4.64 0 8.41 3.77 8.41 8.41v75.49c0 4.65-3.77 8.42-8.41 8.42-4.65 0-8.41-3.77-8.41-8.42v-75.49c0-4.64 3.76-8.41 8.41-8.41zM308.72 178.25c4.65 0 8.41 3.77 8.41 8.42v95.78c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-95.78c0-4.65 3.77-8.42 8.41-8.42zM274.45 186.98c4.64 0 8.41 3.77 8.41 8.41v109.45c0 4.65-3.77 8.41-8.41 8.41-4.65 0-8.41-3.76-8.41-8.41v-109.45c0-4.64 3.76-8.41 8.41-8.41zM240.91 201.6c4.64 0 8.41 3.76 8.41 8.41v104.93c0 4.64-3.77 8.41-8.41 8.41-4.65 0-8.41-3.77-8.41-8.41v-104.93c0-4.65 3.76-8.41 8.41-8.41zM207.26 220.84c4.65 0 8.41 3.76 8.41 8.41v90.63c0 4.64-3.76 8.41-8.41 8.41-4.64 0-8.41-3.77-8.41-8.41v-90.63c0-4.65 3.77-8.41 8.41-8.41zM476.53 201.6c4.64 0 8.41 3.76 8.41 8.41v23.13c0 4.64-3.77 8.41-8.41 8.41-4.65 0-8.42-3.77-8.42-8.41v-23.13c0-4.65 3.77-8.41 8.42-8.41zM173.62 234.19c4.64 0 8.41 3.76 8.41 8.41v89.16c0 4.64-3.77 8.41-8.41 8.41-4.65 0-8.41-3.77-8.41-8.41v-89.16c0-4.65 3.76-8.41 8.41-8.41z" />
          </svg>
        </Tile>
      );
    case 'openrouter':
      return <Tile size={size} className="bg-[#081011]"><svg viewBox="0 0 1024 730" className="h-full w-full" fill="#C8FF00"><path d="M795.893 0C915.776 0 1012.95 97.9963 1012.95 218.88C1012.95 339.764 915.776 437.76 795.893 437.76L1011.2 654.869C1038.55 682.447 1019.18 729.6 980.504 729.6H361.77C161.97 729.6 0 566.273 0 364.8C0 163.327 161.97 0 361.77 0L795.893 0ZM361.77 145.92C241.89 145.92 144.708 243.916 144.708 364.8C144.708 485.684 241.89 583.68 361.77 583.68C481.649 583.68 578.831 485.684 578.831 364.8C578.831 243.916 481.649 145.92 361.77 145.92Z" /></svg></Tile>;
    case 'openai':
      return (
        <Tile size={size} className="bg-white ring-1 ring-inset ring-black/10">
          <svg viewBox="0 0 24 24" className="h-full w-full" fill="#000"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" /></svg>
        </Tile>
      );
    case 'replicate':
      return (
        <Tile size={size} className="bg-black">
          <svg viewBox="0 0 24 24" className="h-full w-full p-[8%]" fill="#fff"><path d="M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z" /></svg>
        </Tile>
      );
    case 'google-ai-studio':
      return (
        <Tile size={size} className="bg-white ring-1 ring-inset ring-black/10">
          <svg viewBox="0 0 48 48" className="h-full w-full">
            <path fill="#4285F4" d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.42h11a9.4 9.4 0 0 1-4.08 6.18v5.14h6.6c3.86-3.56 6.09-8.8 6.09-14.82Z" />
            <path fill="#34A853" d="M24 44c5.5 0 10.11-1.82 13.48-4.72l-6.6-5.14c-1.82 1.22-4.15 1.95-6.88 1.95-5.3 0-9.79-3.58-11.4-8.4H5.78v5.3A20.36 20.36 0 0 0 24 44Z" />
            <path fill="#FBBC05" d="M12.6 27.69a12.2 12.2 0 0 1 0-7.38v-5.3H5.78a20 20 0 0 0 0 17.98l6.82-5.3Z" />
            <path fill="#EA4335" d="M24 11.91c3 0 5.69 1.03 7.81 3.05l5.86-5.86A19.64 19.64 0 0 0 24 4 20.36 20.36 0 0 0 5.78 15.01l6.82 5.3c1.61-4.82 6.1-8.4 11.4-8.4Z" />
          </svg>
        </Tile>
      );
    case 'kokoro-local':
      return (
        <Tile size={size} className="bg-accent-wash text-accent">
          <CpuChipIcon className="h-full w-full" />
        </Tile>
      );
    case 'custom-openai':
    default:
      return (
        <Tile size={size} className="bg-surface-sunken text-muted ring-1 ring-inset ring-line">
          <ServerStackIcon className="h-full w-full" />
        </Tile>
      );
  }
}
