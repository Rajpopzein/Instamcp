/**
 * Centralised, lazily-validated environment access.
 *
 * Next.js evaluates route modules at build time, so we must not throw on
 * import — only when a value is actually needed at request time.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export const env = {
  get appId() {
    return required('INSTAGRAM_APP_ID');
  },
  get appSecret() {
    return required('INSTAGRAM_APP_SECRET');
  },
  get redirectUri() {
    return required('INSTAGRAM_REDIRECT_URI');
  },
  get bearerSecret() {
    return required('MCP_BEARER_SECRET');
  },
  get stateSecret() {
    return required('OAUTH_STATE_SECRET');
  },
  get graphVersion() {
    return process.env.INSTAGRAM_GRAPH_VERSION || 'v25.0';
  },
};

export const GRAPH_BASE = 'https://graph.instagram.com';
export const OAUTH_BASE = 'https://www.instagram.com';
