import type {
  AllMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from "@slack/bolt";

export const sampleViewCallback = async ({
  ack,
  view,
  body,
  client,
  logger,
  respond,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  await ack();

  try {
    const { input_block_id } = view.state.values;
    const sampleInputValue = input_block_id.sample_input_id.value;
    const text = `<@${body.user.id}> submitted the following :sparkles: hopes and dreams :sparkles:: \n\n ${sampleInputValue}`;

    // The channel select has response_url_enabled, so Slack sends a response
    // URL that posts in the picked conversation, even one the bot isn't in.
    if (body.response_urls?.length) {
      await respond({ text, response_type: "in_channel" });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text });
    }
  } catch (error) {
    logger.error(error);
  }
};
