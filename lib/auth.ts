import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from './env';

/** Constant-time comparison of a presented secret against the configured one. */
function matchesSecret(presented: string): boolean {
  if (!presented) return false;

  // HMAC both sides first: `timingSafeEqual` throws on length mismatch, so
  // comparing digests keeps the secret's length from leaking too.
  const key = Buffer.from('instamcp-bearer');
  const a = createHmac('sha256', key).update(presented).digest();
  const b = createHmac('sha256', key).update(env.bearerSecret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Accepts the shared secret from either an `Authorization: Bearer` header or a
 * `?key=` query parameter.
 *
 * The query parameter exists because some MCP clients — Claude's custom
 * connector among them — expose only a URL field, with no way to set a static
 * bearer token or custom header. Their only auth path is OAuth 2.1 with dynamic
 * client registration, so a URL-embedded secret is the sole way to reach a
 * header-authenticated server from those clients.
 *
 * Trade-off: URLs land in proxy and browser-history logs more readily than
 * headers do. Prefer the header wherever the client supports it, and treat a
 * URL-embedded secret as rotatable.
 */
export function verifyBearer(request: Request): boolean {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    return matchesSecret(header.slice('Bearer '.length).trim());
  }

  const key = new URL(request.url).searchParams.get('key');
  if (key) return matchesSecret(key.trim());

  return false;
}

/**
 * Deliberately omits `WWW-Authenticate`.
 *
 * Under the MCP authorization spec a 401 carrying `WWW-Authenticate: Bearer`
 * tells the client to begin OAuth discovery — fetch protected-resource
 * metadata, then attempt dynamic client registration. This server uses a static
 * shared secret and publishes no OAuth metadata, so advertising the challenge
 * only sends clients down a path that dead-ends in a registration failure
 * ("Couldn't register with … sign-in service").
 */
export function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      message:
        'Invalid or missing shared secret. Send Authorization: Bearer <MCP_BEARER_SECRET>, or append ?key=<MCP_BEARER_SECRET> to the URL. This server does not use OAuth.',
    }),
    {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
