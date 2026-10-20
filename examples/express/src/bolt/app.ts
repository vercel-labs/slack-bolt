import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import manifest from "../../manifest.json" with { type: "json" };
import { installationStore } from "../lib/installation-store.js";
import registerListeners from "./listeners/index.js";

// Each workspace's bot token comes from the installation store once the
// workspace installs the app.
const receiver = new VercelReceiver({
  signingSecret: process.env.EXPRESS_SLACK_SIGNING_SECRET,
  clientId: process.env.EXPRESS_SLACK_CLIENT_ID,
  clientSecret: process.env.EXPRESS_SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: manifest.oauth_config.scopes.bot,
  installationStore,
});

const app = new App({
  receiver,
  // Sets up OAuth on the first request instead of at build time.
  deferInitialization: true,
});

registerListeners(app);

export { receiver };
