import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1>Slack Bolt with TanStack Start</h1>
      {/* A plain link: the install page is a server route, not a client route. */}
      <a href="/api/slack/events" className="text-blue-500 underline">
        Install
      </a>
    </div>
  );
}
