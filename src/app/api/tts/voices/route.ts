import { NextRequest, NextResponse } from 'next/server';
import { isKokoroModel } from '@/lib/shared/kokoro';
import { auth } from '@/lib/server/auth/auth';

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const GPT4O_MINI_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
const CUSTOM_OPENAI_VOICES = ['af_sarah', 'af_bella', 'af_nicole', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'];

const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex', 'em_santa', 'ff_siwis',
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune',
  'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni',
  'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'
];

const ORPHEUS_VOICES = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac'];

const SESAME_VOICES = ['conversational_a', 'conversational_b', 'read_speech_a', 'read_speech_b', 'read_speech_c', 'read_speech_d', 'none'];

function getDefaultVoices(provider: string, model: string): string[] {
  // For OpenAI provider
  if (provider === 'openai') {
    if (model === 'gpt-4o-mini-tts') {
      return GPT4O_MINI_VOICES;
    }
    return OPENAI_VOICES;
  }

  // For Custom OpenAI-Like provider
  if (provider === 'custom-openai') {
    // If using Kokoro-FastAPI (model string contains 'kokoro'), expose full Kokoro voices
    if (isKokoroModel(model)) {
      return KOKORO_VOICES;
    }
    return CUSTOM_OPENAI_VOICES;
  }

  // For Deepinfra provider - model-specific voices
  if (provider === 'deepinfra') {
    if (model === 'hexgrad/Kokoro-82M') {
      return KOKORO_VOICES;
    }
    if (model === 'canopylabs/orpheus-3b-0.1-ft') {
      return ORPHEUS_VOICES;
    }
    if (model === 'sesame/csm-1b') {
      return SESAME_VOICES;
    }
    // For ResembleAI/chatterbox and Zyphra models, return special values
    if (model === 'ResembleAI/chatterbox') {
      return ['None'];
    }
    if (model === 'Zyphra/Zonos-v0.1-hybrid' || model === 'Zyphra/Zonos-v0.1-transformer') {
      return ['random'];
    }
    // Default Deepinfra voices
    return CUSTOM_OPENAI_VOICES;
  }

  // Default fallback
  return OPENAI_VOICES;
}

async function fetchDeepinfraVoices(apiKey: string): Promise<string[]> {
  try {
    const response = await fetch('https://api.deepinfra.com/v1/voices', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch Deepinfra voices');
    }

    const data = await response.json();

    // Extract voice names from the response, excluding preset voices
    if (data.voices && Array.isArray(data.voices)) {
      return data.voices
        .filter((voice: { user_id?: string }) => voice.user_id !== 'preset')
        .map((voice: { name: string }) => voice.name);
    }
    return [];
  } catch (error) {
    console.error('Error fetching Deepinfra voices:', error);
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    // Auth check - require session
    const session = await auth?.api.getSession({ headers: req.headers });
    if (auth && !session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const openApiKey = req.headers.get('x-openai-key') || process.env.API_KEY || 'none';
    const openApiBaseUrl = req.headers.get('x-openai-base-url') || process.env.API_BASE;
    const provider = req.headers.get('x-tts-provider') || 'openai';
    const model = req.headers.get('x-tts-model') || 'tts-1';

    // For OpenAI provider, use default voices (no API call needed)
    if (provider === 'openai') {
      return NextResponse.json({ voices: getDefaultVoices(provider, model) });
    }

    // For Deepinfra provider with specific models that need API fetching
    if (provider === 'deepinfra') {
      const needsApiFetch = model === 'ResembleAI/chatterbox' ||
        model === 'Zyphra/Zonos-v0.1-hybrid' ||
        model === 'Zyphra/Zonos-v0.1-transformer';

      if (needsApiFetch) {
        const apiVoices = await fetchDeepinfraVoices(openApiKey);
        // Combine default voice with fetched voices
        const defaultVoice = getDefaultVoices(provider, model);
        if (apiVoices.length > 0) {
          return NextResponse.json({ voices: [...defaultVoice, ...apiVoices] });
        }
      }

      // For other Deepinfra models, return static defaults
      return NextResponse.json({ voices: getDefaultVoices(provider, model) });
    }

    // For Custom OpenAI-Like provider, try to fetch voices from custom endpoint
    if (provider === 'custom-openai') {
      try {
        const response = await fetch(`${openApiBaseUrl}/audio/voices`, {
          headers: {
            'Authorization': `Bearer ${openApiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.voices) {
            return NextResponse.json({ voices: data.voices });
          }
        }
      } catch {
        console.log('Custom endpoint does not support voices, using defaults');
      }

      // Fallback to default voices if API call fails
      return NextResponse.json({ voices: getDefaultVoices(provider, model) });
    }

    // Default fallback
    return NextResponse.json({ voices: getDefaultVoices(provider, model) });
  } catch (error) {
    console.error('Error in voices endpoint:', error);
    const provider = req.headers.get('x-tts-provider') || 'openai';
    const model = req.headers.get('x-tts-model') || 'tts-1';
    return NextResponse.json({ voices: getDefaultVoices(provider, model) });
  }
}
