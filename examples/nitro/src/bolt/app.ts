import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import manifest from "../../manifest.json";
import { installationStore } from "../lib/installation-store";
import registerListeners from "./listeners";

// Each workspace's bot token comes from the installation store once the
// workspace installs the app.
const receiver = new VercelReceiver({
  signingSecret: process.env.NITRO_SLACK_SIGNING_SECRET,
  clientId: process.env.NITRO_SLACK_CLIENT_ID,
  clientSecret: process.env.NITRO_SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: manifest.oauth_config.scopes.bot,
  installationStore,
});

const app = new App({ receiver });

registerListeners(app);

export { receiver };
