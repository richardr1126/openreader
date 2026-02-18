import type {
  TTSRequestPayload,
  TTSRequestHeaders,
  TTSRetryOptions,
  TTSRequestError,
  AudiobookStatusResponse,
  CreateChapterPayload,
  VoicesResponse,
  AlignmentPayload,
  AlignmentResponse
} from '@/types/client';
import type { TTSAudiobookChapter, TTSAudioBuffer } from '@/types/tts';

/**
 * Executes a function with exponential backoff retry logic
 * @param operation Function to retry
 * @param options Retry configuration options
 * @returns Promise resolving to the operation result
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: TTSRetryOptions = {}
): Promise<T> => {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffFactor = 2
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Do not retry on explicit cancellation/abort errors - surface them
      // immediately so callers can stop work quickly when the user cancels.
      if (lastError.name === 'AbortError' || lastError.message.includes('cancelled')) {
        break;
      }

      // Do not retry on payment required / rate limit exceeded (user quota)
      const status = (() => {
        if (typeof error === 'object' && error !== null && 'status' in error) {
          const maybe = (error as { status?: unknown }).status;
          return typeof maybe === 'number' ? maybe : undefined;
        }
        return undefined;
      })();
      const code = (() => {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          const maybe = (error as { code?: unknown }).code;
          return typeof maybe === 'string' ? maybe : undefined;
        }
        return undefined;
      })();
      // Do not retry on user quota exceeded (server tells us when to retry via resetTime/Retry-After)
      if (status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED') {
        break;
      }

      if (attempt === maxRetries - 1) {
        break;
      }

      const delay = Math.min(
        initialDelay * Math.pow(backoffFactor, attempt),
        maxDelay
      );

      console.log(`Retry attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Operation failed after retries');
};

// --- Audiobook API ---



export const getAudiobookStatus = async (bookId: string): Promise<AudiobookStatusResponse> => {
  const response = await fetch(`/api/audiobook/status?bookId=${bookId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch audiobook status');
  }
  return await response.json();
};



export const createAudiobookChapter = async (
  payload: CreateChapterPayload,
  signal?: AbortSignal
): Promise<TTSAudiobookChapter> => {
  const response = await fetch(`/api/audiobook/chapter`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal
  });

  if (response.status === 499) {
    throw new Error('cancelled');
  }

  if (response.status === 409) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || 'Audiobook settings mismatch');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to convert audio chapter');
  }

  return await response.json();
};

export const deleteAudiobook = async (bookId: string): Promise<void> => {
  const response = await fetch(`/api/audiobook?bookId=${bookId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Reset failed');
  }
};

export const downloadAudiobook = async (bookId: string, format: string): Promise<Response> => {
  const response = await fetch(`/api/audiobook?bookId=${bookId}&format=${format}`);
  if (!response.ok) throw new Error('Download failed');
  return response;
};

export const deleteAudiobookChapter = async (bookId: string, chapterIndex: number): Promise<void> => {
  const response = await fetch(`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${chapterIndex}`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error('Delete failed');
  }
};

export const downloadAudiobookChapter = async (bookId: string, chapterIndex: number): Promise<Blob> => {
  const response = await fetch(`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${chapterIndex}`);
  if (!response.ok) throw new Error('Download failed');
  return await response.blob();
};

// --- TTS API ---



export const getVoices = async (headers: HeadersInit): Promise<VoicesResponse> => {
  const response = await fetch('/api/tts/voices', {
    headers,
  });

  if (!response.ok) throw new Error('Failed to fetch voices');
  return await response.json();
};

export const generateTTS = async (
  payload: TTSRequestPayload,
  headers: TTSRequestHeaders,
  signal?: AbortSignal
): Promise<TTSAudioBuffer> => {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    let problem: unknown = undefined;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/problem+json') || contentType.includes('application/json')) {
      try {
        problem = await response.json();
      } catch {
        // ignore JSON parse errors
      }
    }

    const err = new Error(`TTS processing failed with status ${response.status}`) as TTSRequestError;
    err.status = response.status;

    if (typeof problem === 'object' && problem !== null) {
      const rec = problem as Record<string, unknown>;
      if (typeof rec.code === 'string') err.code = rec.code;
      if (typeof rec.type === 'string') err.type = rec.type;
      if (typeof rec.title === 'string') err.title = rec.title;
      if (typeof rec.detail === 'string') err.detail = rec.detail;
    }

    // Avoid noisy logs for expected user quota failures
    if (!(err.status === 429 && err.code === 'USER_DAILY_QUOTA_EXCEEDED')) {
      console.error(`TTS request failed: ${response.status}`, err.code ? { code: err.code } : undefined);
    }

    throw err;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('Received empty audio buffer from TTS');
  }
  return buffer;
};

// --- Whisper API ---



export const alignAudio = async (payload: AlignmentPayload): Promise<AlignmentResponse | null> => {
  const response = await fetch('/api/whisper', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) return null;
  return await response.json();
};
