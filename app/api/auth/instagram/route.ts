import { signState } from '@/lib/auth';
import { env, OAUTH_BASE } from '@/lib/env';

/**
 * Step 1 of Business Login for Instagram.
 * Redirects the browser to Instagram's authorization screen with an
 * HMAC-signed `state` value, so the callback can verify it without a session.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
].join(',');

export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get('account') ?? 'default';

  const authorize = new URL(`${OAUTH_BASE}/oauth/authorize`);
  authorize.searchParams.set('client_id', env.appId);
  authorize.searchParams.set('redirect_uri', env.redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('state', signState({ account }));

  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), 'cache-control': 'no-store' },
  });
}
