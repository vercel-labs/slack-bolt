import { createOAuthCallbackHandler } from "@vercel/slack-bolt";
import { receiver } from "@/bolt/app";

export const GET = createOAuthCallbackHandler(receiver);
