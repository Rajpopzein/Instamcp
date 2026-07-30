import { Redis } from '@upstash/redis';
import { env, GRAPH_BASE } from './env';

/**
 * Token persistence + automatic refresh.
 *
 * Instagram long-lived tokens last 60 days and can be refreshed any time after
 * they are 24 hours old. We refresh proactively once fewer than 7 days remain,
 * so a client that calls the server at least weekly never sees an expiry.
 */

const KEY_PREFIX = 'instamcp:token:';
const DEFAULT_ACCOUNT = 'default';
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredToken = {
  accessToken: string;
  userId: string;
  /** Absolute epoch ms at which the token expires. */
  expiresAt: number;
  /** Epoch ms of the last successful refresh (or of initial exchange). */
  refreshedAt: number;
};

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis({ url: env.redisUrl, token: env.redisToken });
  }
  return client;
}

function key(account: string): string {
  return `${KEY_PREFIX}${account}`;
}

export async function saveToken(
  token: StoredToken,
  account: string = DEFAULT_ACCOUNT,
): Promise<void> {
  await redis().set(key(account), JSON.stringify(token));
}

export async function readToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<StoredToken | null> {
  const raw = await redis().get<string | StoredToken>(key(account));
  if (!raw) return null;
  // Upstash may deserialise JSON for us depending on how it was written.
  return typeof raw === 'string' ? (JSON.parse(raw) as StoredToken) : raw;
}

/**
 * Exchanges a long-lived token for a fresh one, extending expiry by 60 days.
 */
async function refresh(token: StoredToken): Promise<StoredToken> {
  const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token.accessToken);

  const response = await fetch(url, { cache: 'no-store' });
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      `Token refresh failed (${response.status}): ${body.error?.message ?? 'unknown error'}`,
    );
  }

  return {
    accessToken: body.access_token,
    userId: token.userId,
    expiresAt: Date.now() + (body.expires_in ?? 60 * 24 * 60 * 60) * 1000,
    refreshedAt: Date.now(),
  };
}

/**
 * Returns a usable token, refreshing and persisting it first if it is close to
 * expiry. Throws when no token has been stored yet (i.e. OAuth never ran).
 */
export async function getValidToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<StoredToken> {
  const stored = await readToken(account);
  if (!stored) {
    throw new Error(
      'No Instagram token on file. Visit /api/auth/instagram to connect an account first.',
    );
  }

  const remaining = stored.expiresAt - Date.now();
  if (remaining > REFRESH_THRESHOLD_MS) return stored;

  if (remaining <= 0) {
    throw new Error(
      'The stored Instagram token has expired and can no longer be refreshed. Re-run /api/auth/instagram.',
    );
  }

  const refreshed = await refresh(stored);
  await saveToken(refreshed, account);
  return refreshed;
}

export async function deleteToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<void> {
  await redis().del(key(account));
}

/** Finds the storage account whose stored token belongs to `userId`. */
export async function findAccountByUserId(userId: string): Promise<string | null> {
  const keys = await redis().keys(`${KEY_PREFIX}*`);
  for (const k of keys) {
    const raw = await redis().get<string | StoredToken>(k);
    if (!raw) continue;
    const token = typeof raw === 'string' ? (JSON.parse(raw) as StoredToken) : raw;
    if (token.userId === userId) return k.slice(KEY_PREFIX.length);
  }
  return null;
}
