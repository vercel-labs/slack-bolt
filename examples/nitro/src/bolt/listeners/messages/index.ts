import type { App } from "@slack/bolt";
import { sampleMessageCallback } from "./sample-message";

const register = (app: App) => {
  app.message(/^hello.*/, sampleMessageCallback);
};

export default { register };
