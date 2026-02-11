import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "@/bolt/app";

export const POST = createHandler(app, receiver);
