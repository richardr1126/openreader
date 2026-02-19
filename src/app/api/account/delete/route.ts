import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { isAuthEnabled } from '@/lib/server/auth/config';

export async function DELETE() {
  if (!isAuthEnabled() || !auth) {
    return NextResponse.json({ error: 'Authentication disabled' }, { status: 403 });
  }

  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders
  });

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Use Better Auth's built-in deleteUser to handle cascading cleanup
    await auth.api.deleteUser({
      headers: reqHeaders,
      body: {},
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete account:', error);
    return NextResponse.json(
      { error: 'Failed to delete account' },
      { status: 500 }
    );
  }
}
