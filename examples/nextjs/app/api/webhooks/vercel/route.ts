import { createPreviewHandler } from "@vercel/slack-bolt/preview";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Handle Vercel deployment webhooks to create/delete Slack apps for previews
export const POST = createPreviewHandler({
  repository: "vercel-labs/slack-bolt",
  manifestPath: "examples/nextjs/manifest.json",
  deployments: {
    get: async (id) => redis.get<string>(`slack-app:${id}`),
    set: async (id, appId) => {
      await redis.set(`slack-app:${id}`, appId);
    },
    delete: async (id) => {
      await redis.del(`slack-app:${id}`);
    },
  },
});
