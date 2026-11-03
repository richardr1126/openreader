import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/server/api/request';
import { listSpeechProviders } from '@/lib/server/tts/voices';

export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return apiRequest(request, 'documents:read', async principal => NextResponse.json({ data: await listSpeechProviders(principal), nextCursor: null }, { headers: { 'Cache-Control': 'private, no-store' } }));
}
