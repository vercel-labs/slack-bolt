import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { VercelHandler, VercelReceiver } from "./VercelReceiver";
import type { App } from "@slack/bolt";

export function handler(app: App, receiver: VercelReceiver): VercelHandler {
  let initPromise: Promise<void> | null = null;

  return async (
    req: VercelRequest,
    res: VercelResponse
  ): Promise<VercelResponse> => {
    try {
      if (!initPromise) {
        initPromise = app.init();
      }
      await initPromise;

      const handler = await receiver.start();
      return await handler(req, res);
    } catch (error) {
      console.error("Error processing Slack event:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  };
}
