/**
 * Human-readable status page for a data deletion request.
 * Instamcp deletes synchronously, so any valid code is already complete.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code') ?? '(none)';
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Data deletion status</title>
<body style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">
<h1>Data deletion complete</h1>
<p>Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, '')}</code></p>
<p>All Instagram access tokens and cached data associated with this request have been deleted. Instamcp stores no other personal data.</p>
</body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
