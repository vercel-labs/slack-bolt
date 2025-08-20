import pkg from '@slack/bolt';
import { VercelReceiver } from '@vercel/slack-bolt';
import registerListeners from './listeners';

const { App } = pkg;
const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

registerListeners(app);

export { app, receiver };
