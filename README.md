# Instamcp

A remote **MCP (Model Context Protocol) server for Instagram**, built on Next.js and the Instagram Graph API v25.0. Point any MCP client — Claude, an agent framework, your own tooling — at a single HTTPS endpoint and give it read/write access to an Instagram Business or Creator account.

## What it does

13 tools across six areas:

| Area | Tools |
| --- | --- |
| Profile | `get_profile` |
| Media | `list_media`, `get_media` |
| Insights | `get_media_insights`, `get_account_insights` |
| Audience | `get_audience_demographics` |
| Comments | `list_comments`, `reply_to_comment` |
| Moderation | `moderate_comment`, `delete_comment` |
| Publishing | `publish_media`, `get_publishing_status`, `get_publishing_limit` |

## Design notes

- **Stateless streamable HTTP transport** via `mcp-handler` v2 — no session affinity, so it runs on serverless functions without sticky routing.
- **Shared-secret auth** on every method, compared in constant time over HMACs so neither the value nor its length leaks. Unauthenticated clients cannot even enumerate the tool list. Accepted as an `Authorization: Bearer` header or a `?key=` query parameter.
- **No OAuth advertised.** The 401 deliberately omits `WWW-Authenticate`, because under the MCP auth spec that header sends clients into OAuth discovery and dynamic client registration — which this server does not implement.
- **HMAC-signed OAuth `state`** with a 10-minute TTL — CSRF protection with no server-side session store.
- **Automatic token refresh.** Long-lived tokens (60 days) are persisted in Redis and refreshed once fewer than 7 days remain, so a client that calls weekly never sees an expiry. A refresh that fails degrades to the existing token rather than failing the call, since the token is typically still valid.
- **Two ways in.** Either run the OAuth flow, or paste a generated token into `INSTAGRAM_ACCESS_TOKEN` and skip it. Stored tokens win, so the upgrade path needs no config change.
- **Provider-agnostic storage.** The token store accepts either an Upstash-style REST pair or a standard `REDIS_URL`, detected at runtime — so whatever the Vercel Marketplace injects just works, with no variable renaming.
- **Meta compliance endpoints** for deauthorize and data deletion, both verifying the `signed_request` HMAC against the app secret before touching stored data.
- **Publishing handles async transcoding.** `publish_media` creates the container, polls until it leaves `IN_PROGRESS`, then publishes — avoiding the "Media ID is not available" race. If transcoding outruns the polling window it returns the container ID for `get_publishing_status` to finish.

## Setup

### 1. Meta app

Create a Meta app with the **Instagram** product and configure Business Login:

- **Valid OAuth redirect URI**: `https://<your-deployment>/api/auth/instagram/callback`
- **Deauthorize callback URL**: `https://<your-deployment>/api/meta/deauthorize`
- **Data deletion request URL**: `https://<your-deployment>/api/meta/data-deletion`

Required scopes: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`.

### 2. Environment

Copy `.env.example` to `.env.local` and fill it in. Generate the two secrets with:

```bash
openssl rand -hex 32   # MCP_BEARER_SECRET
openssl rand -hex 32   # OAUTH_STATE_SECRET
```

Provision Redis and let it inject its own variables — Vercel dashboard → **Storage** → add a Redis product, or:

```bash
vercel install upstash
```

Any of these shapes is recognised, so you should not need to rename anything:

| Style | Variables |
| --- | --- |
| REST | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` |
| REST | `KV_REST_API_URL` + `KV_REST_API_TOKEN` |
| TCP | `REDIS_URL` |
| TCP | `KV_URL` |

### 3. Run

```bash
npm install
npm run dev
```

### 4. Connect an account

Visit `/api/auth/instagram` in a browser, approve the Instagram prompt, and the long-lived token is stored automatically.

**Or skip OAuth entirely.** Meta's Instagram API setup page has a **Generate token** button that hands you a 60-day long-lived token directly. Set it as `INSTAGRAM_ACCESS_TOKEN` and the server uses it — no OAuth round trip, no Meta redirect URI to register, and no Redis strictly required:

```
INSTAGRAM_ACCESS_TOKEN=IGAA...
```

A token in Redis always takes precedence, so completing OAuth later upgrades the deployment with no config change. With Redis configured the env token is persisted on first use and refreshes normally; without it, regenerate roughly every 60 days.

### 5. Point a client at it

For clients that support custom headers — the preferred path:

```json
{
  "mcpServers": {
    "instagram": {
      "type": "http",
      "url": "https://<your-deployment>/api/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_SECRET>" }
    }
  }
}
```

### Clients that only accept a URL

Some clients — including Claude's **custom connector** UI — offer no field for a static bearer token or custom header. Their only authentication path is OAuth 2.1 with dynamic client registration, so pointing one at a header-authenticated server fails with *"Couldn't register with … sign-in service."*

For those, put the secret in the URL:

```
https://<your-deployment>/api/mcp?key=<MCP_BEARER_SECRET>
```

Leave the connector's OAuth client ID and secret blank. Because the 401 carries no `WWW-Authenticate` header, the client will not attempt OAuth discovery.

A URL-embedded secret is more exposed than a header — it reaches proxy logs, browser history and shell history. Treat it as rotatable: changing `MCP_BEARER_SECRET` and re-pointing the client is the whole revocation story.

### If the custom connector still refuses to register

Claude's *custom connector* flow attempts OAuth dynamic client registration against every remote server and fails with *"Couldn't register with … sign-in service"* regardless of what the server advertises — including servers that implement the full OAuth 2.1 spec correctly. See [claude-ai-mcp#457](https://github.com/anthropics/claude-ai-mcp/issues/457) and [#697](https://github.com/anthropics/claude-ai-mcp/issues/697). Implementing OAuth here would not help.

Bypass the connector with a stdio bridge instead. In `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-deployment>/api/mcp?key=<MCP_BEARER_SECRET>"]
    }
  }
}
```

Or for Claude Code:

```bash
claude mcp add --transport http instagram "https://<your-deployment>/api/mcp" \
  --header "Authorization: Bearer <MCP_BEARER_SECRET>"
```

## Deploy

```bash
npx vercel deploy --prod
```

Set the same environment variables in the Vercel project, then update the Meta app URLs to the production domain.

## Multiple accounts

Every tool takes an optional `account` key, and `/api/auth/instagram?account=<key>` stores a token under that key. Omit it to use `default`.

## Notes and limits

- Requires an Instagram **Business** or **Creator** account. Personal accounts cannot use these endpoints.
- Publishing is capped at 25 posts per rolling 24 hours — check `get_publishing_limit` before bulk operations.
- Media to publish must be reachable at a public HTTPS URL; Instagram fetches it server-side.
- `get_audience_demographics` returns an empty result for accounts under 100 followers.
- Account insights accept a maximum 30-day range per call.
- `delete_comment` is irreversible and requires `confirm: true`.

## License

MIT
