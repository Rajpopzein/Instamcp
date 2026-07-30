/**
 * Provider-agnostic key/value store for token persistence.
 *
 * Vercel's Marketplace Redis integrations inject different variable names
 * depending on which provider you provision, and the dashboard lets you add a
 * prefix on top of that. Rather than pin one name, detect whichever pair is
 * present:
 *
 *   REST (Upstash-compatible, HTTP):
 *     UPSTASH_REDIS_REST_URL   + UPSTASH_REDIS_REST_TOKEN
 *     KV_REST_API_URL          + KV_REST_API_TOKEN
 *
 *   TCP (standard Redis wire protocol):
 *     REDIS_URL
 *     KV_URL
 *
 * REST is preferred when both are available: it needs no connection setup,
 * which suits short-lived serverless invocations better than a TCP handshake.
 */

export type Store = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
};

const ACCEPTED = [
  'UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL + KV_REST_API_TOKEN',
  'REDIS_URL',
  'KV_URL',
].join(', ');

function restCredentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function tcpUrl(): string | null {
  return process.env.REDIS_URL || process.env.KV_URL || null;
}

function restStore(url: string, token: string): Store {
  // Imported lazily so a TCP-only deployment never loads this dependency.
  const load = async () => {
    const { Redis } = await import('@upstash/redis');
    // Without this the client JSON-parses stored values on the way out, so a
    // serialised token comes back as an object and breaks the string contract
    // below. Keep the raw text and let callers do their own parsing.
    return new Redis({ url, token, automaticDeserialization: false });
  };

  let client: Awaited<ReturnType<typeof load>> | null = null;
  const redis = async () => (client ??= await load());

  return {
    async get(key) {
      const value = await (await redis()).get<unknown>(key);
      if (value === null || value === undefined) return null;
      // Belt and braces: tolerate a client that deserialises anyway.
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    async set(key, value) {
      await (await redis()).set(key, value);
    },
    async del(key) {
      await (await redis()).del(key);
    },
    async keys(pattern) {
      return (await redis()).keys(pattern);
    },
  };
}

function tcpStore(url: string): Store {
  const load = async () => {
    const { createClient } = await import('redis');
    const client = createClient({ url });
    client.on('error', () => {
      // Swallow background socket errors; per-command failures still reject
      // and surface through the tool's error result.
    });
    await client.connect();
    return client;
  };

  // Reused across invocations that land on a warm container.
  let connecting: Promise<Awaited<ReturnType<typeof load>>> | null = null;
  const redis = async () => {
    connecting ??= load();
    try {
      return await connecting;
    } catch (error) {
      connecting = null; // Let the next call retry rather than cache a failure.
      throw error;
    }
  };

  return {
    async get(key) {
      return (await redis()).get(key);
    },
    async set(key, value) {
      await (await redis()).set(key, value);
    },
    async del(key) {
      await (await redis()).del(key);
    },
    async keys(pattern) {
      return (await redis()).keys(pattern);
    },
  };
}

let store: Store | null = null;

/**
 * Resolves the configured store. Throws only when called, not at import time,
 * so a build with no Redis configured still succeeds.
 */
export function getStore(): Store {
  if (store) return store;

  const rest = restCredentials();
  if (rest) {
    store = restStore(rest.url, rest.token);
    return store;
  }

  const tcp = tcpUrl();
  if (tcp) {
    store = tcpStore(tcp);
    return store;
  }

  throw new Error(
    `No Redis configured for token storage. Set one of: ${ACCEPTED}. ` +
      'Provision Redis from the Vercel Marketplace (Storage tab) and it will inject one of these automatically.',
  );
}

/** Which provider style is active, for diagnostics. */
export function storeKind(): 'rest' | 'tcp' | 'none' {
  if (restCredentials()) return 'rest';
  if (tcpUrl()) return 'tcp';
  return 'none';
}
