import { createInstallHandler } from "@vercel/slack-bolt";
import { receiver } from "@/bolt/app";

export const GET = createInstallHandler(receiver);
