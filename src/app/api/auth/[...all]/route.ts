import { getAuth } from '@/lib/server/auth/auth';

async function handler(request: Request): Promise<Response> {
  return (await getAuth()).handler(request);
}

export const GET = handler;
export const POST = handler;
