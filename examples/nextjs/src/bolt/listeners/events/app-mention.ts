import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";

export const appMentionCallback = async ({
  event,
  client,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  await client.chat.postMessage({
    channel: event.channel,
    text: `Hello, <@${event.user}>!`,
  });
};
