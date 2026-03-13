export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen font-sans">
      <h1 className="text-2xl font-bold text-red-500">Installation Failed</h1>
      <p className="mt-2 text-gray-400">
        Something went wrong. Please try again.
      </p>
      {error && (
        <p className="mt-4 text-sm text-gray-500">
          Error:{" "}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">{error}</code>
        </p>
      )}
    </div>
  );
}
