import { verifyState } from '@/lib/auth';
import { exchangeCodeForToken, getProfile } from '@/lib/instagram';
import { saveToken } from '@/lib/tokens';

/**
 * Step 2 of Business Login for Instagram.
 * Verifies the signed `state`, exchanges the code for a 60-day long-lived
 * token and persists it to Redis.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0b0d0c;color:#e8ece9;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  main{max-width:34rem}
  h1{font-size:1.35rem;margin:0 0 .5rem}
  code{background:#1a1f1c;padding:.15em .4em;border-radius:4px;font-size:.9em}
  .ok{color:#7dffa8}.bad{color:#ff8a7d}
</style>
<main>${body}</main>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const error = params.get('error');
  if (error) {
    return page(
      'Authorization declined',
      `<h1 class="bad">Authorization declined</h1><p>${
        params.get('error_description') ?? error
      }</p>`,
      400,
    );
  }

  const state = verifyState(params.get('state'));
  if (!state.ok) {
    return page(
      'Invalid state',
      `<h1 class="bad">Invalid state</h1><p>The <code>state</code> parameter was rejected (${state.reason}). Start again from <code>/api/auth/instagram</code>.</p>`,
      400,
    );
  }

  const code = params.get('code');
  if (!code) {
    return page('Missing code', '<h1 class="bad">Missing authorization code</h1>', 400);
  }

  const account = typeof state.payload.account === 'string' ? state.payload.account : 'default';

  try {
    const token = await exchangeCodeForToken(code);
    await saveToken({ ...token, refreshedAt: Date.now() }, account);

    let username = '(unknown)';
    try {
      const profile = (await getProfile(account)) as { username?: string };
      if (profile.username) username = profile.username;
    } catch {
      // Profile lookup is cosmetic; the token is already stored.
    }

    const expires = new Date(token.expiresAt).toISOString().slice(0, 10);
    return page(
      'Connected',
      `<h1 class="ok">Instagram connected</h1>
       <p>Account <strong>@${username}</strong> is linked as <code>${account}</code>.</p>
       <p>The long-lived token is stored and expires on <strong>${expires}</strong>. Instamcp refreshes it automatically once fewer than 7 days remain.</p>
       <p>You can close this tab and point your MCP client at <code>/api/mcp</code>.</p>`,
      200,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return page('Token exchange failed', `<h1 class="bad">Token exchange failed</h1><p>${message}</p>`, 502);
  }
}
