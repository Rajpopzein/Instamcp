import { GRAPH_BASE } from './env';
import { getStore, storeKind, type Store } from './store';

/**
 * Token persistence + automatic refresh, over whichever Redis provider is
 * configured (see ./store).
 *
 * Instagram long-lived tokens last 60 days and can be refreshed any time after
 * they are 24 hours old. We refresh proactively once fewer than 7 days remain,
 * so a client that calls the server at least weekly never sees an expiry.
 *
 * Two ways a token gets here:
 *
 *   1. The OAuth flow (/api/auth/instagram) writes one to Redis. Preferred —
 *      refreshes persist, so the account stays connected indefinitely.
 *   2. `INSTAGRAM_ACCESS_TOKEN` supplies one directly, as produced by the
 *      "Generate token" button on Meta's Instagram API setup page. Lets you
 *      run with no Redis and no OAuth round trip; see `adoptEnvToken` for the
 *      trade-offs.
 *
 * A stored token always wins over the environment one, so completing OAuth
 * later transparently upgrades a deployment that started out env-seeded.
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

function key(account: string): string {
  return `${KEY_PREFIX}${account}`;
}

export async function saveToken(
  token: StoredToken,
  account: string = DEFAULT_ACCOUNT,
): Promise<void> {
  await getStore().set(key(account), JSON.stringify(token));
}

export async function readToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<StoredToken | null> {
  const raw = await getStore().get(key(account));
  if (!raw) return null;
  return JSON.parse(raw) as StoredToken;
}

/** The store, or null when no Redis is configured at all. */
function optionalStore(): Store | null {
  return storeKind() === 'none' ? null : getStore();
}

/** Like `readToken`, but tolerates having no store configured. */
async function readTokenIfPossible(account: string): Promise<StoredToken | null> {
  const store = optionalStore();
  if (!store) return null;
  const raw = await store.get(key(account));
  return raw ? (JSON.parse(raw) as StoredToken) : null;
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

/** Cached across invocations on a warm container, so we adopt at most once. */
let adoptedEnvToken: StoredToken | null = null;

/**
 * Adopts a token supplied via `INSTAGRAM_ACCESS_TOKEN`.
 *
 * The environment gives us the token but not its expiry, so we ask Instagram to
 * refresh it: that returns an authoritative `expires_in` and rolls the clock
 * forward another 60 days in one step. Refresh is rejected for tokens under 24
 * hours old, which is the common case right after generating one — so on
 * failure we fall back to the documented 60-day lifetime and use the token as
 * supplied.
 *
 * When a store is configured the result is persisted, after which the normal
 * stored-token path takes over and refreshes keep working. With no store, the
 * token lives only in this container's memory and you will need to regenerate
 * it when it lapses.
 */
async function adoptEnvToken(account: string): Promise<StoredToken | null> {
  const raw = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!raw) return null;
  if (adoptedEnvToken?.accessToken === raw) return adoptedEnvToken;

  const seed: StoredToken = {
    accessToken: raw,
    userId: '',
    expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
    refreshedAt: Date.now(),
  };

  let token = seed;
  try {
    token = await refresh(seed);
  } catch {
    // Under 24 hours old, so not yet refreshable. Keep the seed's assumed
    // 60-day expiry; if that guess is wrong, Instagram's own auth error
    // surfaces on the next tool call, which is clearer than failing here.
  }

  const store = optionalStore();
  if (store) await store.set(key(account), JSON.stringify(token));

  adoptedEnvToken = token;
  return token;
}

/**
 * Returns a usable token, refreshing and persisting it first if it is close to
 * expiry. Throws when no token is available by either route.
 */
export async function getValidToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<StoredToken> {
  const stored = (await readTokenIfPossible(account)) ?? (await adoptEnvToken(account));
  if (!stored) {
    throw new Error(
      'No Instagram token available. Either visit /api/auth/instagram to connect an ' +
        'account, or set INSTAGRAM_ACCESS_TOKEN to a long-lived token from the ' +
        '"Generate token" button on Meta\'s Instagram API setup page.',
    );
  }

  const remaining = stored.expiresAt - Date.now();
  if (remaining > REFRESH_THRESHOLD_MS) return stored;

  if (remaining <= 0) {
    throw new Error(
      'The Instagram token has expired and can no longer be refreshed. Re-run /api/auth/instagram, or replace INSTAGRAM_ACCESS_TOKEN with a freshly generated one.',
    );
  }

  // A failed refresh must not break every tool call while the token is still
  // valid — Instagram may reject the refresh for a token under 24 hours old, or
  // simply be unreachable. Fall back to the token we have and retry next time.
  try {
    const refreshed = await refresh(stored);
    const store = optionalStore();
    if (store) await store.set(key(account), JSON.stringify(refreshed));
    adoptedEnvToken = refreshed;
    return refreshed;
  } catch {
    return stored;
  }
}

export async function deleteToken(
  account: string = DEFAULT_ACCOUNT,
): Promise<void> {
  await getStore().del(key(account));
}

/** Finds the storage account whose stored token belongs to `userId`. */
export async function findAccountByUserId(userId: string): Promise<string | null> {
  const store = getStore();
  const keys = await store.keys(`${KEY_PREFIX}*`);
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const token = JSON.parse(raw) as StoredToken;
    if (token.userId === userId) return k.slice(KEY_PREFIX.length);
  }
  return null;
}
