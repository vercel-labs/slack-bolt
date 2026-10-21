import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1>Slack Bolt with Next.js</h1>
      {/* No prefetch: it would run the install route handler on every view. */}
      <Link
        href="/api/slack/events"
        prefetch={false}
        className="text-blue-500 underline"
      >
        Install
      </Link>
    </div>
  );
}
