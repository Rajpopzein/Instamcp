import { createHash } from 'node:crypto';
import { parseSignedRequest } from '@/lib/auth';
import { deleteToken, findAccountByUserId } from '@/lib/tokens';

/**
 * Meta data deletion request callback.
 * Must verify the `signed_request` HMAC, delete the user's data, and respond
 * with a status URL plus a confirmation code Meta can surface to the user.
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

  const userId = payload.user_id ? String(payload.user_id) : '';
  if (userId) {
    const account = await findAccountByUserId(userId);
    if (account) await deleteToken(account);
  }

  // Deterministic, non-reversible receipt so a repeat request returns the same code.
  const confirmationCode = createHash('sha256')
    .update(`instamcp:deletion:${userId}`)
    .digest('hex')
    .slice(0, 16);

  const origin = new URL(request.url).origin;

  return Response.json({
    url: `${origin}/api/meta/data-deletion/status?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}
