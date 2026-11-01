import type { NextRequest } from 'next/server';
import { apiRequest } from '@/lib/server/api/request';
import { describeMe } from '@/lib/server/api/me';

export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return apiRequest(request, 'documents:read', principal => describeMe(request, principal));
}
