import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1>Slack Bolt with Next.js</h1>
      <Link href="/api/slack/install" className="text-blue-500 underline">
        Install
      </Link>
    </div>
  );
}
