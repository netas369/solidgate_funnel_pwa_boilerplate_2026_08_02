import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME } from '../payment-cookie';
import { createClient } from '../supabase/server';

export async function handleLogout(): Promise<Response> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return NextResponse.json({ error: 'Failed to log out' }, { status: 500 });
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
