import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME } from '@repo/shared/payment-cookie';
import { createClient } from '@repo/shared/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return NextResponse.json({ error: 'Failed to reset device state' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, redirectTo: '/' });
  response.cookies.set({
    name: PAYMENT_COOKIE_NAME,
    value: '',
    maxAge: 0,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}
