import { parseSignedRequest } from '@/lib/auth';
import { deleteToken, findAccountByUserId } from '@/lib/tokens';

/**
 * Meta deauthorize callback.
 * Fired when a user removes the app from their Instagram/Facebook settings.
 * Verifies the `signed_request` HMAC before deleting any stored token.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const signed = form?.get('signed_request');

  if (typeof signed !== 'string') {
    return Response.json({ error: 'missing signed_request' }, { status: 400 });
  }

  const payload = parseSignedRequest(signed);
  if (!payload) {
    return Response.json({ error: 'invalid signed_request signature' }, { status: 401 });
  }

  if (payload.user_id) {
    const account = await findAccountByUserId(String(payload.user_id));
    if (account) await deleteToken(account);
  }

  return Response.json({ ok: true });
}
