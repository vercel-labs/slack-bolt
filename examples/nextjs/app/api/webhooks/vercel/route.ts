import { createCleanupHandler } from "@vercel/slack-bolt/preview";

// Handle Vercel deployment.cleanup webhooks to delete Slack apps when branches are removed.
// Register this endpoint in Vercel Webhook settings for deployment.cleanup events.
export const POST = createCleanupHandler();
