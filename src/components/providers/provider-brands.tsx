import type { ReactNode } from 'react';
import { CpuChipIcon, ServerStackIcon } from '@/components/icons/Icons';
import { cn } from '@/components/ui';
import type { TtsProviderId } from '@openreader/tts/provider-catalog';

/**
 * How each provider type presents itself in the admin and voice settings:
 * its logo tile, name, and where to get a key. Marks are the companies' own
 * artwork (OpenAI and Replicate via Simple Icons, DeepInfra from its site),
 * drawn on the tile colour each brand uses.
 */
export interface ProviderBrand {
  name: string;
  /** What the provider offers, for the add-provider picker. */
  summary: string;
  apiKeyUrl?: string;
}

export const PROVIDER_BRANDS: Record<TtsProviderId, ProviderBrand> = {
  openai: {
    name: 'OpenAI',
    summary: 'gpt-4o-mini-tts, tts-1 and tts-1-hd',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  deepinfra: {
    name: 'DeepInfra',
    summary: 'Kokoro, Orpheus, Chatterbox, Zonos and more',
    apiKeyUrl: 'https://deepinfra.com/dash/api_keys',
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
export const EXTERNAL_PROVIDER_ORDER: readonly TtsProviderId[] = ['openai', 'deepinfra', 'replicate', 'custom-openai'];

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
    case 'deepinfra':
      return (
        <Tile size={size} className="bg-[#0a0e1a]">
          <svg viewBox="-0.4 10.45 28 28" className="h-full w-full">
            <path fill="#fff" d="M2.833 19.29A2.837 2.837 0 0 1 0 16.458a2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.554a1.723 1.723 0 0 0 0 3.445c.95 0 1.723-.772 1.723-1.722s-.772-1.723-1.723-1.723M2.833 27.283A2.837 2.837 0 0 1 0 24.449a2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.555c-.948 0-1.72.772-1.72 1.721s.772 1.723 1.72 1.723a1.722 1.722 0 1 0 0-3.443M2.833 35.267A2.837 2.837 0 0 1 0 32.434 2.837 2.837 0 0 1 2.833 29.6a2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.554a1.723 1.723 0 0 0 0 3.445 1.724 1.724 0 0 0 0-3.445M24.38 19.29a2.837 2.837 0 0 1-2.833-2.833 2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.554a1.724 1.724 0 1 0 1.723 1.723c0-.95-.772-1.723-1.723-1.723M24.38 27.283a2.837 2.837 0 0 1-2.833-2.834 2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.555c-.948 0-1.722.772-1.722 1.721s.772 1.723 1.722 1.723 1.723-.772 1.723-1.723c0-.95-.772-1.72-1.723-1.72M24.38 35.267a2.837 2.837 0 0 1-2.833-2.833A2.837 2.837 0 0 1 24.38 29.6a2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.554c-.948 0-1.722.772-1.722 1.722a1.724 1.724 0 0 0 3.445 0c0-.95-.772-1.722-1.723-1.722M13.607 23.283a2.837 2.837 0 0 1-2.834-2.834 2.837 2.837 0 0 1 2.834-2.833 2.837 2.837 0 0 1 2.833 2.833 2.837 2.837 0 0 1-2.833 2.834m0-4.555a1.724 1.724 0 1 0 1.723 1.723c0-.95-.773-1.723-1.723-1.723M13.607 15.298a2.837 2.837 0 0 1-2.834-2.833 2.837 2.837 0 0 1 2.834-2.834 2.837 2.837 0 0 1 2.833 2.834 2.837 2.837 0 0 1-2.833 2.833m0-4.554a1.724 1.724 0 0 0 0 3.445 1.724 1.724 0 0 0 0-3.445M13.607 31.283a2.837 2.837 0 0 1-2.834-2.834 2.837 2.837 0 0 1 2.834-2.833 2.837 2.837 0 0 1 2.833 2.833 2.837 2.837 0 0 1-2.833 2.834m0-4.555a1.724 1.724 0 1 0 1.723 1.723c0-.95-.773-1.723-1.723-1.723M13.607 39.267a2.837 2.837 0 0 1-2.834-2.833 2.837 2.837 0 0 1 2.834-2.834 2.837 2.837 0 0 1 2.833 2.834 2.837 2.837 0 0 1-2.833 2.833m0-4.554c-.949 0-1.723.772-1.723 1.722s.772 1.723 1.723 1.723a1.724 1.724 0 0 0 0-3.445" />
            <path fill="#5699db" d="M9.098 19.781a.9.9 0 0 1-.342-.066L6.91 18.98a.925.925 0 1 1 .687-1.72l1.845.736a.926.926 0 0 1-.344 1.785zM9.098 27.617a.9.9 0 0 1-.342-.066l-1.845-.736a.925.925 0 1 1 .687-1.719l1.845.735a.926.926 0 0 1-.344 1.785zM19.918 23.702a.9.9 0 0 1-.342-.065l-1.844-.736a.925.925 0 0 1 .685-1.719l1.845.735a.926.926 0 0 1-.344 1.785M19.918 15.867a.9.9 0 0 1-.342-.066l-1.844-.735a.926.926 0 0 1 .685-1.72l1.845.736a.926.926 0 0 1-.344 1.785M19.918 31.531a.9.9 0 0 1-.342-.066l-1.844-.735a.925.925 0 0 1 .685-1.72l1.845.736a.926.926 0 0 1-.344 1.785M7.302 31.812a.926.926 0 0 1-.344-1.785l1.845-.736a.925.925 0 1 1 .687 1.72l-1.845.735a.9.9 0 0 1-.342.066zM7.302 24.023a.926.926 0 0 1-.344-1.785l1.845-.736a.925.925 0 1 1 .687 1.72l-1.845.735a.9.9 0 0 1-.342.066zM7.302 15.843a.926.926 0 0 1-.344-1.785l1.845-.735a.925.925 0 1 1 .687 1.72l-1.845.734a.9.9 0 0 1-.342.066zM9.098 36.015a.9.9 0 0 1-.342-.066l-1.845-.735a.925.925 0 0 1 .686-1.719l1.844.735a.925.925 0 0 1-.343 1.785M18.075 19.782a.926.926 0 0 1-.343-1.787l1.844-.735a.927.927 0 0 1 .687 1.721l-1.844.735a.9.9 0 0 1-.342.066zM18.075 27.618a.926.926 0 0 1-.343-1.787l1.844-.735a.927.927 0 0 1 .687 1.721l-1.844.735a.9.9 0 0 1-.342.066zM18.075 36.015a.925.925 0 0 1-.344-1.785l1.845-.736a.925.925 0 1 1 .686 1.72l-1.845.735a.9.9 0 0 1-.342.066" />
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
