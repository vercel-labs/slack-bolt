import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import manifest from "../../manifest.json";
import registerListeners from "./listeners";

// Single-workspace setup (uses a static bot token):
// const receiver = new VercelReceiver();

// const app = new App({
//   token: process.env.SLACK_BOT_TOKEN,
//   signingSecret: process.env.SLACK_SIGNING_SECRET,
//   receiver,
//   deferInitialization: true,
// });

// Multi-workspace OAuth setup:
import type { Installation, InstallationStore } from "@slack/bolt";

const myStore: InstallationStore = {
  storeInstallation: async (_installation) => {
    /* save to DB */
  },
  fetchInstallation: async (
    _query,
  ): Promise<Installation<"v1" | "v2", boolean>> => {
    return {
      team: { id: "T123", name: "Test" },
      enterprise: undefined,
      user: { id: "U123", token: undefined, scopes: undefined },
      bot: {
        id: "B123",
        userId: "U456",
        token: "xoxb-test",
        scopes: ["chat:write"],
      },
      tokenType: "bot" as const,
      isEnterpriseInstall: false,
      appId: "A123",
    }; /* load from DB */
  },
  deleteInstallation: async (_query) => {
    /* remove from DB */
  },
};
//
const receiver = new VercelReceiver({
  scopes: manifest.oauth_config?.scopes?.bot ?? [],
  installationStore: myStore,
});

const app = new App({
  receiver,
  authorize: receiver.installer?.authorize,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  deferInitialization: true,
});
//
// Then wire up the OAuth routes:
// - app/api/slack/install/route.ts -> export const GET = createInstallHandler(receiver)
// - app/api/slack/oauth_redirect/route.ts -> export const GET = createOAuthCallbackHandler(receiver)

registerListeners(app);

export { app, receiver };
