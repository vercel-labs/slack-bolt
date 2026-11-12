import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import { installationStore } from "@/lib/installation-store";
import manifest from "../../manifest.json";
import registerListeners from "./listeners";

// Each workspace's bot token comes from the installation store once the
// workspace installs the app.
const receiver = new VercelReceiver({
  signingSecret: process.env.NEXT_SLACK_SIGNING_SECRET,
  clientId: process.env.NEXT_SLACK_CLIENT_ID,
  clientSecret: process.env.NEXT_SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: manifest.oauth_config.scopes.bot,
  installationStore,
});

const app = new App({ receiver });

registerListeners(app);

export const { GET, POST } = receiver;
