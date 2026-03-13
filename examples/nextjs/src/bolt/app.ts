import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import manifest from "../../manifest.json";
import { installationStore } from "../lib/installation-store";
import registerListeners from "./listeners";

const receiver = new VercelReceiver({
  scopes: manifest.oauth_config.scopes.bot,
  installationStore,
});

const app = new App({
  receiver,
  deferInitialization: true,
});

registerListeners(app);

export { app, receiver };
