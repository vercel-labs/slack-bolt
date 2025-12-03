import { createHandler } from "@vercel/slack-bolt";
import { defineEventHandler, toWebRequest } from "h3";
import { app, receiver } from "../../lib/bolt/app";

const handler = createHandler(app, receiver);

export default defineEventHandler(async (event) => {
  const req = toWebRequest(event);
  return await handler(req);
});
