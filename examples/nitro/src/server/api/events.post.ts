import { createHandler } from '@vercel/slack-bolt';
import { eventHandler, toWebRequest } from 'h3';
import { app, receiver } from '../../app';

const handler = createHandler(app, receiver);

export default eventHandler(async (event) => {
  const request = toWebRequest(event);
  return await handler(request);
});
