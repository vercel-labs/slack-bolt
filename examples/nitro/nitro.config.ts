import { defineConfig } from "nitro";

export default defineConfig({
  // Scan src/ for routes, so src/routes/api/slack/events.ts serves
  // /api/slack/events.
  serverDir: "./src",
});
