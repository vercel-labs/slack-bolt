import { App } from "@slack/bolt";
import { VercelReceiver, createHandler } from "@vercel/slack-bolt";

// Lazy initialization to avoid errors during build
let _receiver: VercelReceiver | null = null;
let _app: App | null = null;
let _handler: ReturnType<typeof createHandler> | null = null;

function getReceiver() {
  if (!_receiver) {
    _receiver = new VercelReceiver();
  }
  return _receiver;
}

function getApp() {
  if (!_app) {
    const receiver = getReceiver();
    _app = new App({
      receiver,
      token: process.env.SLACK_BOT_TOKEN,
    });

    // Register event handlers

    // Respond to @mentions
    _app.event("app_mention", async ({ event, say }) => {
      await say(`Hello <@${event.user}>! 👋`);
    });

    // Respond to messages in channels the bot is in
    _app.message("hello", async ({ message, say }) => {
      if (message.subtype === undefined && "user" in message) {
        await say(`Hey there <@${message.user}>!`);
      }
    });

    // Handle the /hello slash command
    _app.command("/hello", async ({ command, ack, respond }) => {
      await ack();

      const name = command.text || "World";
      await respond({
        response_type: "in_channel",
        text: `Hello, ${name}! 🎉`,
      });
    });
  }
  return _app;
}

// Export the request handler for the API route
export const handler: ReturnType<typeof createHandler> = async (req) => {
  if (!_handler) {
    _handler = createHandler(getApp(), getReceiver());
  }
  return _handler(req);
};
