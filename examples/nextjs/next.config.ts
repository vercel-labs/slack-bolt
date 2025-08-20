import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Compute absolute root for this example app without hardcoding machine paths
const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root,
  },
};

export default nextConfig;
