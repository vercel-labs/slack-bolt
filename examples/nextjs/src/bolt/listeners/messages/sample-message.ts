import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';

export const sampleMessageCallback = async ({
  context,
  say,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'message'>) => {
  try {
    const greeting = context.matches[0];
    await say(`${greeting}, how are you?`);
  } catch (error) {
    logger.error(error);
  }
};
