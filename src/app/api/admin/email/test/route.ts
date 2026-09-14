import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { enqueueAccountEmail } from '@/lib/server/email/delivery';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  try {
    const operation = await enqueueAccountEmail({
      purpose: 'admin_test',
      recipient: context.user.email,
      allowWhenDisabled: true,
    });
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Unable to queue test email',
    }, { status: 400 });
  }
}
