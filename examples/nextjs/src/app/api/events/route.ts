import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "@/bolt/app";

const handler = createHandler(app, receiver);

export const POST = async (request: Request) => {
  return await handler(request);
};
