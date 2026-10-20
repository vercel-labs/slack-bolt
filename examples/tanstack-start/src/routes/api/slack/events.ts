import { createFileRoute } from "@tanstack/react-router";
import { GET, POST } from "@/bolt/app";

export const Route = createFileRoute("/api/slack/events")({
  server: {
    handlers: {
      GET: ({ request }) => GET(request),
      POST: ({ request }) => POST(request),
    },
  },
});
