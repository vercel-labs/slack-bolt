import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "@/lib/bolt/app";

export const POST = createHandler(app, receiver);
