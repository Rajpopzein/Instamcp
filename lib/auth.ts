import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from './env';

/**
 * Constant-time bearer token check.
 *
 * Compares HMACs rather than the raw strings so that differing lengths do not
 * leak through `timingSafeEqual`'s length precondition.
 */
export function verifyBearer(request: Request): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;

  const presented = header.slice('Bearer '.length).trim();
  if (!presented) return false;

  const key = Buffer.from('instamcp-bearer');
  const a = createHmac('sha256', key).update(presented).digest();
  const b = createHmac('sha256', key).update(env.bearerSecret).digest();
  return timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'Invalid or missing bearer token.' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="instamcp"',
      },
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                          HMAC-signed OAuth state                           */
/* -------------------------------------------------------------------------- */

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Builds a stateless, tamper-proof CSRF token: `payload.signature`.
 * No server-side session storage is needed to validate it on callback.
 */
export function signState(payload: Record<string, unknown> = {}): string {
  const body = b64url(
    JSON.stringify({ ...payload, n: randomBytes(8).toString('hex'), t: Date.now() }),
  );
  const sig = b64url(createHmac('sha256', env.stateSecret).update(body).digest());
  return `${body}.${sig}`;
}

export type StateResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyState(state: string | null): StateResult {
  if (!state || !state.includes('.')) return { ok: false, reason: 'malformed' };

  const [body, sig] = state.split('.', 2);
  const expected = createHmac('sha256', env.stateSecret).update(body).digest();
  const presented = fromB64url(sig);

  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const issued = typeof payload.t === 'number' ? payload.t : 0;
  if (Date.now() - issued > STATE_TTL_MS) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

/* -------------------------------------------------------------------------- */
/*                      Meta `signed_request` verification                    */
/* -------------------------------------------------------------------------- */

export type SignedRequest = {
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
  [key: string]: unknown;
};

/**
 * Verifies the `signed_request` Meta posts to the deauthorize and data-deletion
 * callbacks. Returns null when the signature does not match the app secret.
 */
export function parseSignedRequest(signed: string): SignedRequest | null {
  if (!signed.includes('.')) return null;
  const [encodedSig, payload] = signed.split('.', 2);

  const expected = createHmac('sha256', env.appSecret).update(payload).digest();
  const presented = fromB64url(encodedSig);

  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }

  try {
    const data = JSON.parse(fromB64url(payload).toString('utf8')) as SignedRequest;
    if (data.algorithm && data.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
    return data;
  } catch {
    return null;
  }
}
