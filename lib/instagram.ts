import { env, GRAPH_BASE } from './env';
import { getValidToken } from './tokens';

/**
 * Thin, typed wrapper over the Instagram Graph API (Instagram Login flavour,
 * i.e. `graph.instagram.com` with a long-lived Instagram user token).
 */

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly type?: string,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

type GraphError = {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
  };
};

/* -------------------------------------------------------------------------- */
/*                            Response sanitising                             */
/* -------------------------------------------------------------------------- */

const TOKEN_PARAMS = ['access_token', 'client_secret', 'appsecret_proof'];

/**
 * The API version Graph last reported serving, read off a paging URL.
 * Null until a paginated call has run.
 */
let observedVersion: string | null = null;

export function getObservedVersion(): string | null {
  return observedVersion;
}

/** Replaces credential query parameters in a URL string with `[redacted]`. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let touched = false;
    for (const name of TOKEN_PARAMS) {
      if (url.searchParams.has(name)) {
        // No brackets: `searchParams` percent-encodes them, which turns a
        // readable marker into `%5Bredacted%5D`.
        url.searchParams.set(name, 'redacted');
        touched = true;
      }
    }
    return touched ? url.toString() : value;
  } catch {
    return value;
  }
}

/** Pulls a cursor value out of a Graph-generated paging URL. */
function cursorFrom(url: string | undefined, name: 'after' | 'before'): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

type RawPaging = {
  cursors?: { before?: string; after?: string };
  next?: string;
  previous?: string;
};

/**
 * Rewrites a Graph `paging` object into cursors plus booleans.
 *
 * Graph returns `paging.next` and `paging.previous` as fully-formed URLs with
 * the live access token in the query string. Returning those verbatim would put
 * a working credential into model context and into any log that captures the
 * tool result — so the URLs are dropped entirely and only the cursors survive.
 * Callers paginate with the `after` argument, which is equivalent.
 */
function sanitisePaging(paging: RawPaging): Record<string, unknown> {
  const after = paging.cursors?.after ?? cursorFrom(paging.next, 'after');
  const before = paging.cursors?.before ?? cursorFrom(paging.previous, 'before');

  return {
    cursors: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
    has_next: Boolean(paging.next),
    has_previous: Boolean(paging.previous),
  };
}

/**
 * Walks a Graph response and removes credentials before it reaches the client.
 *
 * Two passes matter: `paging` objects are rebuilt as cursors only, and any other
 * string that happens to be a URL carrying a token parameter is redacted. The
 * second pass is a backstop for fields we have not enumerated — Graph adds URLs
 * to responses over time, and the default should be to strip rather than leak.
 */
export function sanitise(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('access_token=') ||
      value.includes('client_secret=') ||
      value.includes('appsecret_proof=')
      ? redactUrl(value)
      : value;
  }

  if (Array.isArray(value)) return value.map(sanitise);

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'paging' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = sanitisePaging(v as RawPaging);
        continue;
      }
      // Never echo a raw token even if Graph returns one in a body.
      if (k === 'access_token' || k === 'client_secret' || k === 'appsecret_proof') {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitise(v);
    }
    return out;
  }

  return value;
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  account?: string,
): Promise<T> {
  const token = await getValidToken(account);
  const url = new URL(`${GRAPH_BASE}/${env.graphVersion}/${path.replace(/^\//, '')}`);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  // Bearer header rather than an `access_token` query parameter: keeps the
  // credential out of the request URL, so it cannot surface in an error
  // message, a stack trace, or an intermediary's access log.
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const text = await response.text();

  // Graph stamps its own version into the paging URLs it generates. Capturing
  // it before sanitising is the only way to observe which version actually
  // served the call: Meta silently upgrades requests aimed at a version that is
  // no longer available to the app, so the configured value can differ from the
  // effective one with no error to signal it.
  const stamped = /graph\.instagram\.com\/(v\d+\.\d+)\//.exec(text);
  if (stamped) observedVersion = stamped[1];

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new InstagramApiError(
      `Non-JSON response from Instagram (${response.status}): ${redactUrl(text.slice(0, 200))}`,
      response.status,
    );
  }

  if (!response.ok) {
    const err = (body as GraphError).error;
    throw new InstagramApiError(
      redactUrl(err?.message ?? `Instagram request failed with ${response.status}`),
      response.status,
      err?.code,
      err?.error_subcode,
      err?.type,
    );
  }

  return sanitise(body) as T;
}

/* -------------------------------------------------------------------------- */
/*                                  Profile                                   */
/* -------------------------------------------------------------------------- */

const PROFILE_FIELDS = [
  'id',
  'user_id',
  'username',
  'name',
  'account_type',
  'biography',
  'website',
  'profile_picture_url',
  'followers_count',
  'follows_count',
  'media_count',
].join(',');

export function getProfile(account?: string) {
  return request<Record<string, unknown>>('GET', 'me', { fields: PROFILE_FIELDS }, account);
}

/* -------------------------------------------------------------------------- */
/*                                   Media                                    */
/* -------------------------------------------------------------------------- */

const MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_product_type',
  'media_url',
  'permalink',
  'thumbnail_url',
  'timestamp',
  'username',
  'like_count',
  'comments_count',
  'is_shared_to_feed',
].join(',');

export function listMedia(
  opts: { limit?: number; after?: string; since?: string; until?: string },
  account?: string,
) {
  return request<{ data: unknown[]; paging?: Record<string, unknown> }>(
    'GET',
    'me/media',
    {
      fields: MEDIA_FIELDS,
      limit: opts.limit ?? 25,
      after: opts.after,
      since: opts.since,
      until: opts.until,
    },
    account,
  );
}

export function getMedia(mediaId: string, account?: string) {
  return request<Record<string, unknown>>('GET', mediaId, { fields: MEDIA_FIELDS }, account);
}

/* -------------------------------------------------------------------------- */
/*                                  Insights                                  */
/* -------------------------------------------------------------------------- */

/** Metrics valid for an individual media object. */
export const MEDIA_METRICS = [
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
  'views',
] as const;

/** Account-level metrics that require `metric_type=total_value`. */
export const ACCOUNT_METRICS = [
  'reach',
  'views',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
  'replies',
  'follows_and_unfollows',
  'profile_links_taps',
  'website_clicks',
  'profile_views',
  'accounts_engaged',
] as const;

export function getMediaInsights(
  mediaId: string,
  metrics: string[] | undefined,
  account?: string,
) {
  return request<{ data: unknown[] }>(
    'GET',
    `${mediaId}/insights`,
    { metric: (metrics?.length ? metrics : [...MEDIA_METRICS]).join(',') },
    account,
  );
}

export function getAccountInsights(
  opts: { metrics?: string[]; period?: string; since?: string; until?: string },
  account?: string,
) {
  return request<{ data: unknown[] }>(
    'GET',
    'me/insights',
    {
      metric: (opts.metrics?.length ? opts.metrics : ['reach', 'views', 'total_interactions']).join(','),
      metric_type: 'total_value',
      period: opts.period ?? 'day',
      since: opts.since,
      until: opts.until,
    },
    account,
  );
}

/**
 * Follower demographics. Lifetime metric; requires at least 100 followers or
 * Instagram returns an empty data array rather than an error.
 */
export function getAudienceDemographics(
  breakdown: 'city' | 'country' | 'age' | 'gender',
  timeframe: 'last_14_days' | 'last_30_days' | 'last_90_days' | 'this_month' | 'this_week' | 'prev_month',
  account?: string,
) {
  return request<{ data: unknown[] }>(
    'GET',
    'me/insights',
    {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      timeframe,
      breakdown,
    },
    account,
  );
}

/* -------------------------------------------------------------------------- */
/*                          Comments & moderation                             */
/* -------------------------------------------------------------------------- */

const COMMENT_FIELDS = [
  'id',
  'text',
  'timestamp',
  'username',
  'like_count',
  'hidden',
  'replies{id,text,timestamp,username,like_count,hidden}',
].join(',');

export function listComments(
  mediaId: string,
  opts: { limit?: number; after?: string },
  account?: string,
) {
  return request<{ data: unknown[]; paging?: Record<string, unknown> }>(
    'GET',
    `${mediaId}/comments`,
    { fields: COMMENT_FIELDS, limit: opts.limit ?? 25, after: opts.after },
    account,
  );
}

export function replyToComment(commentId: string, message: string, account?: string) {
  return request<{ id: string }>('POST', `${commentId}/replies`, { message }, account);
}

export function setCommentHidden(commentId: string, hide: boolean, account?: string) {
  return request<{ success?: boolean }>('POST', commentId, { hide }, account);
}

export function deleteComment(commentId: string, account?: string) {
  return request<{ success?: boolean }>('DELETE', commentId, {}, account);
}

/* -------------------------------------------------------------------------- */
/*                                 Publishing                                 */
/* -------------------------------------------------------------------------- */

export type ContainerInput = {
  imageUrl?: string;
  videoUrl?: string;
  caption?: string;
  mediaType?: 'IMAGE' | 'REELS' | 'STORIES';
  coverUrl?: string;
  thumbOffset?: number;
  locationId?: string;
  shareToFeed?: boolean;
};

export function createContainer(input: ContainerInput, account?: string) {
  return request<{ id: string }>(
    'POST',
    'me/media',
    {
      image_url: input.imageUrl,
      video_url: input.videoUrl,
      caption: input.caption,
      media_type: input.mediaType,
      cover_url: input.coverUrl,
      thumb_offset: input.thumbOffset,
      location_id: input.locationId,
      share_to_feed: input.shareToFeed,
    },
    account,
  );
}

export function getContainerStatus(containerId: string, account?: string) {
  return request<{ id: string; status_code?: string; status?: string }>(
    'GET',
    containerId,
    { fields: 'id,status_code,status' },
    account,
  );
}

export function publishContainer(containerId: string, account?: string) {
  return request<{ id: string }>('POST', 'me/media_publish', { creation_id: containerId }, account);
}

/**
 * Polls a container until it leaves the IN_PROGRESS state.
 * Video and Reels containers are asynchronously transcoded, so publishing
 * immediately after creation fails with "Media ID is not available".
 */
export async function waitForContainer(
  containerId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
  account?: string,
): Promise<{ status_code: string; status?: string }> {
  const timeout = opts.timeoutMs ?? 90_000;
  const interval = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const state = await getContainerStatus(containerId, account);
    const code = state.status_code ?? 'UNKNOWN';
    if (code !== 'IN_PROGRESS') return { status_code: code, status: state.status };

    if (Date.now() + interval > deadline) {
      return { status_code: 'IN_PROGRESS', status: state.status };
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function getPublishingLimit(account?: string) {
  return request<{ data: unknown[] }>(
    'GET',
    'me/content_publishing_limit',
    { fields: 'config,quota_usage' },
    account,
  );
}

/* -------------------------------------------------------------------------- */
/*                              Token exchange                                */
/* -------------------------------------------------------------------------- */

export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  userId: string;
  expiresAt: number;
}> {
  // 1. Short-lived token via the OAuth endpoint (form-encoded POST).
  const form = new URLSearchParams({
    client_id: env.appId,
    client_secret: env.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: env.redirectUri,
    code,
  });

  const shortRes = await fetch(`https://api.instagram.com/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    cache: 'no-store',
  });
  const shortBody = (await shortRes.json()) as {
    access_token?: string;
    user_id?: number | string;
    error_message?: string;
    error?: { message?: string };
  };

  if (!shortRes.ok || !shortBody.access_token) {
    throw new InstagramApiError(
      shortBody.error_message ?? shortBody.error?.message ?? 'Code exchange failed',
      shortRes.status,
    );
  }

  // 2. Upgrade to a 60-day long-lived token.
  const longUrl = new URL(`${GRAPH_BASE}/access_token`);
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', env.appSecret);
  longUrl.searchParams.set('access_token', shortBody.access_token);

  const longRes = await fetch(longUrl, { cache: 'no-store' });
  const longBody = (await longRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };

  if (!longRes.ok || !longBody.access_token) {
    throw new InstagramApiError(
      longBody.error?.message ?? 'Long-lived token exchange failed',
      longRes.status,
    );
  }

  return {
    accessToken: longBody.access_token,
    userId: String(shortBody.user_id ?? ''),
    expiresAt: Date.now() + (longBody.expires_in ?? 60 * 24 * 60 * 60) * 1000,
  };
}
