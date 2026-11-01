import { NextResponse } from 'next/server';
import { publicApiSpec } from '@/lib/server/api/openapi';

export function GET() {
  return NextResponse.json(publicApiSpec);
}
