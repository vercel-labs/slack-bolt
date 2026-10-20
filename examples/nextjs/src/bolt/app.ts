import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt/v2";
import registerListeners from "./listeners";

// Reads SLACK_SIGNING_SECRET from the environment.
const receiver = new VercelReceiver();

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  // Checks the token on the first event instead of at build time.
  deferInitialization: true,
});

registerListeners(app);

export const { POST } = receiver;
