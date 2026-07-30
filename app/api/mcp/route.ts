import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { unauthorized, verifyBearer } from '@/lib/auth';
import { env } from '@/lib/env';
import { InstagramApiError } from '@/lib/instagram';
import * as ig from '@/lib/instagram';
import { storeKind } from '@/lib/store';
import { readToken } from '@/lib/tokens';

/**
 * Instamcp — remote MCP server for Instagram.
 *
 * Stateless streamable HTTP transport: every request carries its own context,
 * so the handler works on serverless functions with no session affinity.
 *
 * Note: `registerTool` takes a Zod *raw shape* (a plain object of Zod fields),
 * not a wrapping `z.object(...)`. Passing a ZodObject silently falls through to
 * the untyped overload and the callback loses its argument types.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const payload =
    error instanceof InstagramApiError
      ? {
          error: 'instagram_api_error',
          message: error.message,
          status: error.status,
          code: error.code,
          subcode: error.subcode,
          type: error.type,
        }
      : {
          error: 'tool_error',
          message: error instanceof Error ? error.message : String(error),
        };

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** Wraps a tool body so a thrown error becomes a structured MCP error result. */
function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  };
}

const account = z
  .string()
  .optional()
  .describe('Stored account key to act as. Omit to use the default connected account.');

const handler = createMcpHandler((server) => {
  /* ----------------------------- 1. Profile ----------------------------- */
  server.registerTool(
    'get_profile',
    {
      title: 'Get Instagram profile',
      description:
        'Fetch the connected Instagram account profile: username, name, account type, bio, website, follower/following/media counts and profile picture.',
      inputSchema: { account },
    },
    guard(async (args) => ok(await ig.getProfile(args.account))),
  );

  /* ------------------------------ 2. Media ------------------------------ */
  server.registerTool(
    'list_media',
    {
      title: 'List recent media',
      description:
        "List the account's media (posts, reels, carousels) newest first, with captions, permalinks, timestamps and like/comment counts. Returns a paging cursor for older items.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many items to return (default 25).'),
        after: z.string().optional().describe('Paging cursor from a previous call.'),
        since: z.string().optional().describe('Unix timestamp or YYYY-MM-DD lower bound.'),
        until: z.string().optional().describe('Unix timestamp or YYYY-MM-DD upper bound.'),
        account,
      },
    },
    guard(async (args) =>
      ok(
        await ig.listMedia(
          { limit: args.limit, after: args.after, since: args.since, until: args.until },
          args.account,
        ),
      ),
    ),
  );

  server.registerTool(
    'get_media',
    {
      title: 'Get one media object',
      description: 'Fetch full details for a single media object by its Instagram media ID.',
      inputSchema: {
        media_id: z.string().describe('Instagram media ID.'),
        account,
      },
    },
    guard(async (args) => ok(await ig.getMedia(args.media_id, args.account))),
  );

  /* ---------------------------- 3. Insights ----------------------------- */
  server.registerTool(
    'get_media_insights',
    {
      title: 'Get insights for a media object',
      description:
        'Per-post performance metrics: reach, views, likes, comments, saved, shares and total interactions. Metric availability varies by media type.',
      inputSchema: {
        media_id: z.string().describe('Instagram media ID.'),
        metrics: z
          .array(z.string())
          .optional()
          .describe(`Subset of metrics to request. Defaults to: ${ig.MEDIA_METRICS.join(', ')}.`),
        account,
      },
    },
    guard(async (args) =>
      ok(await ig.getMediaInsights(args.media_id, args.metrics, args.account)),
    ),
  );

  server.registerTool(
    'get_account_insights',
    {
      title: 'Get account-level insights',
      description:
        'Account-wide metrics over a date range — reach, views, total interactions, profile views, follows and unfollows, link taps.',
      inputSchema: {
        metrics: z
          .array(z.string())
          .optional()
          .describe(`Metrics to request. Valid values: ${ig.ACCOUNT_METRICS.join(', ')}.`),
        period: z
          .enum(['day', 'week', 'days_28'])
          .optional()
          .describe('Aggregation period (default day).'),
        since: z
          .string()
          .optional()
          .describe('Range start as a Unix timestamp. Maximum 30 days per call.'),
        until: z.string().optional().describe('Range end as a Unix timestamp.'),
        account,
      },
    },
    guard(async (args) =>
      ok(
        await ig.getAccountInsights(
          { metrics: args.metrics, period: args.period, since: args.since, until: args.until },
          args.account,
        ),
      ),
    ),
  );

  /* ------------------------ 4. Audience demographics -------------------- */
  server.registerTool(
    'get_audience_demographics',
    {
      title: 'Get follower demographics',
      description:
        'Follower breakdown by city, country, age bracket or gender. Requires at least 100 followers; smaller accounts get an empty result rather than an error.',
      inputSchema: {
        breakdown: z
          .enum(['city', 'country', 'age', 'gender'])
          .describe('Dimension to break followers down by.'),
        timeframe: z
          .enum([
            'last_14_days',
            'last_30_days',
            'last_90_days',
            'this_week',
            'this_month',
            'prev_month',
          ])
          .optional()
          .describe('Reporting window (default last_30_days).'),
        account,
      },
    },
    guard(async (args) =>
      ok(
        await ig.getAudienceDemographics(
          args.breakdown,
          args.timeframe ?? 'last_30_days',
          args.account,
        ),
      ),
    ),
  );

  /* ---------------------------- 5. Comments ----------------------------- */
  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a media object',
      description:
        'List comments on a post, including nested replies, author usernames, like counts and hidden state.',
      inputSchema: {
        media_id: z.string().describe('Instagram media ID.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many comments to return (default 25).'),
        after: z.string().optional().describe('Paging cursor from a previous call.'),
        account,
      },
    },
    guard(async (args) =>
      ok(await ig.listComments(args.media_id, { limit: args.limit, after: args.after }, args.account)),
    ),
  );

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a comment',
      description:
        'Post a public reply to a comment. Instagram restricts replies on some surfaces to within 7 days of the original comment.',
      inputSchema: {
        comment_id: z.string().describe('ID of the comment to reply to.'),
        message: z.string().min(1).max(2200).describe('Reply text.'),
        account,
      },
    },
    guard(async (args) =>
      ok(await ig.replyToComment(args.comment_id, args.message, args.account)),
    ),
  );

  /* --------------------------- 6. Moderation ---------------------------- */
  server.registerTool(
    'moderate_comment',
    {
      title: 'Hide or unhide a comment',
      description:
        'Hide a comment so only its author can see it, or unhide a previously hidden comment. Non-destructive.',
      inputSchema: {
        comment_id: z.string().describe('ID of the comment to hide or unhide.'),
        hide: z.boolean().describe('true to hide, false to unhide.'),
        account,
      },
    },
    guard(async (args) =>
      ok(await ig.setCommentHidden(args.comment_id, args.hide, args.account)),
    ),
  );

  server.registerTool(
    'delete_comment',
    {
      title: 'Delete a comment',
      description:
        'Permanently delete a comment. This cannot be undone — prefer moderate_comment to hide it instead unless deletion is explicitly requested.',
      inputSchema: {
        comment_id: z.string().describe('ID of the comment to delete.'),
        confirm: z.literal(true).describe('Must be true. Guards against accidental deletion.'),
        account,
      },
    },
    guard(async (args) => ok(await ig.deleteComment(args.comment_id, args.account))),
  );

  /* --------------------------- 7. Publishing ---------------------------- */
  server.registerTool(
    'publish_media',
    {
      title: 'Publish a photo or reel',
      description:
        'Publish media to Instagram in one call: creates a media container from a public URL, waits for transcoding to finish, then publishes it. Supply exactly one of image_url or video_url; Instagram fetches the file server-side, so it must be a public HTTPS URL.',
      inputSchema: {
        image_url: z.string().url().optional().describe('Public HTTPS URL of a JPEG image.'),
        video_url: z.string().url().optional().describe('Public HTTPS URL of an MP4/MOV video.'),
        caption: z.string().max(2200).optional().describe('Caption text, including hashtags.'),
        media_type: z
          .enum(['IMAGE', 'REELS', 'STORIES'])
          .optional()
          .describe('Defaults to IMAGE for image_url and REELS for video_url.'),
        cover_url: z.string().url().optional().describe('Public HTTPS URL of a Reel cover image.'),
        thumb_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Reel thumbnail offset in milliseconds.'),
        location_id: z.string().optional().describe('Facebook Page ID to tag as the location.'),
        share_to_feed: z
          .boolean()
          .optional()
          .describe('For Reels, also show the reel in the main feed.'),
        publish: z
          .boolean()
          .optional()
          .describe('Set false to create and validate the container without publishing (default true).'),
        account,
      },
    },
    guard(async (args) => {
      if (!args.image_url && !args.video_url) {
        throw new Error('Provide either image_url or video_url.');
      }
      if (args.image_url && args.video_url) {
        throw new Error('Provide only one of image_url or video_url, not both.');
      }

      const mediaType = args.media_type ?? (args.video_url ? 'REELS' : 'IMAGE');

      const container = await ig.createContainer(
        {
          imageUrl: args.image_url,
          videoUrl: args.video_url,
          caption: args.caption,
          // A plain feed image needs no media_type; sending one is rejected.
          mediaType: mediaType === 'IMAGE' ? undefined : mediaType,
          coverUrl: args.cover_url,
          thumbOffset: args.thumb_offset,
          locationId: args.location_id,
          shareToFeed: args.share_to_feed,
        },
        args.account,
      );

      const state = await ig.waitForContainer(container.id, {}, args.account);

      if (state.status_code === 'ERROR') {
        throw new Error(
          `Container ${container.id} failed processing: ${state.status ?? 'no detail returned'}`,
        );
      }
      if (state.status_code === 'IN_PROGRESS') {
        return ok({
          container_id: container.id,
          status_code: state.status_code,
          published: false,
          note: 'Still transcoding after the polling window. Finish with get_publishing_status using publish_when_ready.',
        });
      }
      if (args.publish === false) {
        return ok({
          container_id: container.id,
          status_code: state.status_code,
          published: false,
        });
      }

      const published = await ig.publishContainer(container.id, args.account);
      return ok({
        container_id: container.id,
        media_id: published.id,
        status_code: state.status_code,
        published: true,
      });
    }),
  );

  server.registerTool(
    'get_publishing_status',
    {
      title: 'Check a media container, optionally publish it',
      description:
        'Check the processing status of a media container created earlier, and optionally publish it once it reports FINISHED. Use this to complete a publish that was still transcoding.',
      inputSchema: {
        container_id: z.string().describe('Media container ID returned by publish_media.'),
        publish_when_ready: z
          .boolean()
          .optional()
          .describe('Publish immediately if the container is FINISHED (default false).'),
        account,
      },
    },
    guard(async (args) => {
      const state = await ig.getContainerStatus(args.container_id, args.account);
      if (args.publish_when_ready && state.status_code === 'FINISHED') {
        const published = await ig.publishContainer(args.container_id, args.account);
        return ok({ ...state, published: true, media_id: published.id });
      }
      return ok({ ...state, published: false });
    }),
  );

  /* --------------------------- 8. Diagnostics --------------------------- */
  server.registerTool(
    'get_diagnostics',
    {
      title: 'Report server configuration',
      description:
        'Configuration the server is actually running with: the configured Graph API version versus the version Graph reports serving, which Redis provider style is active, and where the Instagram token came from. Reads no Instagram data. Use this when results look inconsistent with the documented API version.',
      inputSchema: {},
    },
    guard(async () => {
      const observed = ig.getObservedVersion();
      return ok({
        graph_version_configured: env.graphVersion,
        graph_version_observed: observed,
        graph_version_matches:
          observed === null ? 'unknown (no paginated call yet)' : observed === env.graphVersion,
        store: storeKind(),
        token_source: (await readToken().catch(() => null))
          ? 'redis'
          : process.env.INSTAGRAM_ACCESS_TOKEN
            ? 'INSTAGRAM_ACCESS_TOKEN'
            : 'none',
      });
    }),
  );

  /* ------------------------------ 9. Quota ------------------------------ */
  server.registerTool(
    'get_publishing_limit',
    {
      title: 'Get content publishing quota',
      description:
        'Current API publishing quota usage against the rolling 24-hour limit (25 posts per day). Check this before bulk publishing.',
      inputSchema: { account },
    },
    guard(async (args) => ok(await ig.getPublishingLimit(args.account))),
  );
});

/**
 * Bearer-secret gate in front of the MCP transport. Applied to every method so
 * an unauthenticated client cannot even enumerate the tool list.
 */
async function authed(request: Request): Promise<Response> {
  if (!verifyBearer(request)) return unauthorized();
  return handler(request);
}

export { authed as GET, authed as POST, authed as DELETE };
