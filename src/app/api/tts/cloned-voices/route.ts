import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { errorResponse } from '@/lib/server/errors/next-response';
import { clonedVoiceSummary, listClonedVoices, readClonedVoice, writeClonedVoice, deleteClonedVoice } from '@/lib/server/tts/cloned-voices';
import { validateReferenceWav, validateVoiceName, clonedVoiceId, CLONED_VOICE_MAX_JSON_BYTES, type StoredClonedVoice } from '@openreader/tts/cloned-voices';
import { validateOpenRouterReferences } from '@openreader/tts/openrouter';
import { FISH_AUDIO_MODELS } from '@openreader/tts/provider-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function body(request: NextRequest) {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > CLONED_VOICE_MAX_JSON_BYTES) throw new Error('Voice sample is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireAuthContext(request); if (ctx instanceof Response) return ctx;
    const providerRef = request.nextUrl.searchParams.get('providerRef');
    const model = request.nextUrl.searchParams.get('model');
    let supportsCloning = false;
    if (providerRef && model) {
      const runtime = await getResolvedRuntimeConfig();
      const provider = await resolveTtsCredentials({ providerHeader: providerRef, fallbackProvider: runtime.defaultTtsProvider });
      if (!('error' in provider)) {
        if (provider.provider === 'fish-audio') supportsCloning = FISH_AUDIO_MODELS.some(v => v.id === model);
        if (provider.provider === 'openrouter') {
          try { await validateOpenRouterReferences(model, { input_references: [{ type: 'input_audio', input_audio: { data: '' } }] }, request.signal); supportsCloning = true; }
          // Discovery failures only hide cloning; saved voices still load.
          catch { /* supportsCloning stays false */ }
        }
      }
    }
    return NextResponse.json({ voices: await listClonedVoices(ctx.userId!), supportsCloning }, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) { return errorResponse(error, { apiErrorMessage: 'Could not load your voices.' }); }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireAuthContext(request); if (ctx instanceof Response) return ctx;
    let input;
    try {
      input = await body(request);
      input.name = validateVoiceName(input.name);
      if (input.permitted !== true || typeof input.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio)
        || typeof input.transcript !== 'string' || input.transcript.length > 4000
        || typeof input.providerRef !== 'string' || input.providerRef.length > 256
        || typeof input.model !== 'string' || input.model.length > 256) throw new Error('Invalid voice sample or permission');
      validateReferenceWav(Buffer.from(input.audio, 'base64'));
    } catch { return NextResponse.json({ error: 'Use a named 1–16 second sample and confirm permission to use the voice.' }, { status: 400 }); }
    if ((await listClonedVoices(ctx.userId!)).length >= 32) return NextResponse.json({ error: 'Delete a voice before creating another (32 voice limit).' }, { status: 400 });
    const runtime = await getResolvedRuntimeConfig();
    const provider = await resolveTtsCredentials({ providerHeader: input.providerRef, fallbackProvider: runtime.defaultTtsProvider });
    if ('error' in provider || !['fish-audio', 'openrouter'].includes(provider.provider)) return NextResponse.json({ error: 'Choose Fish Audio or OpenRouter.' }, { status: 400 });
    if (provider.provider === 'fish-audio' && !FISH_AUDIO_MODELS.some(v => v.id === input.model)) return NextResponse.json({ error: 'Choose a supported Fish Audio model.' }, { status: 400 });
    if (!provider.apiKey) return NextResponse.json({ error: 'Configure this provider’s API key before cloning a voice.' }, { status: 400 });
    // Fish Audio conditions on the reference text; a missing transcript degrades the clone.
    if (provider.provider === 'fish-audio' && !input.transcript.trim()) return NextResponse.json({ error: 'Enter the words spoken in the sample.' }, { status: 400 });
    const providerRef = provider.adminRecord?.slug ?? input.providerRef;
    const voice: StoredClonedVoice = { id: `clone:${randomUUID()}`, name: input.name, providerRef,
      providerType: provider.provider as StoredClonedVoice['providerType'], model: input.model,
      transcript: input.transcript.trim(), audio: input.audio };
    if (provider.provider === 'openrouter') {
      await validateOpenRouterReferences(input.model, { input_references: [{ type: 'input_audio', input_audio: { data: input.audio } }] }, request.signal);
    }
    await writeClonedVoice(ctx.userId!, voice);
    return NextResponse.json({ voice: clonedVoiceSummary(voice) }, { status: 201 });
  } catch (error) { return errorResponse(error, { apiErrorMessage: 'Could not create this voice. Check provider access and try again.' }); }
}

export async function PATCH(request: NextRequest) {
  try {
    const ctx = await requireAuthContext(request); if (ctx instanceof Response) return ctx;
    const input = await body(request);
    if (typeof input.id !== 'string' || !clonedVoiceId(input.id)) return NextResponse.json({ error: 'Invalid voice ID' }, { status: 400 });
    const voice = await readClonedVoice(ctx.userId!, input.id);
    voice.name = validateVoiceName(input.name);
    await writeClonedVoice(ctx.userId!, voice);
    return NextResponse.json({ voice: clonedVoiceSummary(voice) });
  } catch (error) { return errorResponse(error, { apiErrorMessage: 'Could not rename this voice.' }); }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requireAuthContext(request); if (ctx instanceof Response) return ctx;
    const input = await body(request);
    if (typeof input.id !== 'string' || !clonedVoiceId(input.id)) return NextResponse.json({ error: 'Invalid voice ID' }, { status: 400 });
    // Removing the saved choice leaves already generated narration reusable.
    await deleteClonedVoice(ctx.userId!, input.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error, { apiErrorMessage: 'Could not delete this voice.' }); }
}
