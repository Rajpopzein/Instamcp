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
- **Bearer-secret auth** on every method, compared in constant time over HMACs so neither the value nor its length leaks. Unauthenticated clients cannot even enumerate the tool list.
- **HMAC-signed OAuth `state`** with a 10-minute TTL — CSRF protection with no server-side session store.
- **Automatic token refresh.** Long-lived tokens (60 days) are persisted in Upstash Redis and refreshed once fewer than 7 days remain, so a client that calls weekly never sees an expiry.
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

Create an Upstash Redis database and copy its REST URL and token.

### 3. Run

```bash
npm install
npm run dev
```

### 4. Connect an account

Visit `/api/auth/instagram` in a browser, approve the Instagram prompt, and the long-lived token is stored automatically.

### 5. Point a client at it

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
