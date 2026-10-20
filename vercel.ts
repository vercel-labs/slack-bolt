import type { VercelConfig } from "@vercel/config/v1";

// Deploys every example to one Vercel project as Vercel Services, each under
// its own path: /nextjs, /hono, /express, /nitro and /tanstack-start. This is
// only how we host the examples. Each example is a standalone template that
// serves its Slack route at /api/slack/events, so the path prefix is added
// here, at deploy time, and never in the examples' code.

// @vercel/config types only the older experimentalServices key, so describe
// the parts of `services` used here.
type Rewrite = {
  source: string;
  destination: string | { service: string };
  has?: { type: "header"; key: string; value: string }[];
  transforms?: { type: "request.path"; op: "set"; args: string }[];
};
type Service = {
  root: string;
  framework?: string;
  entrypoint?: string;
  buildCommand?: string;
  rewrites?: Rewrite[];
};

// The examples import @vercel/slack-bolt from the workspace, so every service
// builds it first.
const buildLibrary =
  "pnpm --dir ../.. exec turbo run build --filter=@vercel/slack-bolt";

// Serves an app built for / under /<name>: routes the request without the
// prefix, and hands the app that path too, since apps built on Nitro read the
// original one.
const stripPrefix = (name: string): Rewrite[] => [
  {
    source: `/${name}/:path*`,
    destination: "/:path*",
    transforms: [{ type: "request.path", op: "set", args: "/:path*" }],
  },
  {
    source: `/${name}/`,
    destination: "/",
    transforms: [{ type: "request.path", op: "set", args: "/" }],
  },
];

const services = {
  nextjs: {
    root: "examples/nextjs",
    buildCommand: `${buildLibrary} && pnpm run build`,
    rewrites: stripPrefix("nextjs"),
  },
  // Hono and Express have no build script of their own.
  hono: {
    root: "examples/hono",
    entrypoint: "src/index.ts",
    buildCommand: buildLibrary,
    rewrites: stripPrefix("hono"),
  },
  express: {
    root: "examples/express",
    entrypoint: "src/index.ts",
    buildCommand: buildLibrary,
    rewrites: stripPrefix("express"),
  },
  nitro: {
    root: "examples/nitro",
    buildCommand: `${buildLibrary} && pnpm run build`,
    rewrites: stripPrefix("nitro"),
  },
  // TanStack Start's router runs in the browser too and reads the address
  // bar, so build it for /tanstack-start instead of stripping the prefix:
  // Vite's --base sets the router's basepath and asset URLs, and
  // NITRO_APP_BASE_URL serves the server there.
  "tanstack-start": {
    root: "examples/tanstack-start",
    // Detection needs @tanstack/router-plugin, which the example doesn't
    // list, so it would otherwise detect Nitro.
    framework: "tanstack-start",
    buildCommand: `${buildLibrary} && NITRO_APP_BASE_URL=/tanstack-start/ pnpm exec vite build --base /tanstack-start/`,
  },
} satisfies Record<string, Service>;

type Name = keyof typeof services;
const names = Object.keys(services) as Name[];

export const config: Omit<VercelConfig, "rewrites"> & {
  services: Record<Name, Service>;
  rewrites: Rewrite[];
} = {
  services,
  rewrites: [
    // `/:path*` doesn't match a trailing slash, which TanStack Start's home
    // page redirects to, so match it separately.
    ...names.flatMap((name) => [
      { source: `/${name}/:path*`, destination: { service: name } },
      { source: `/${name}/`, destination: { service: name } },
    ]),
    // Next.js loads its assets from the root, outside /nextjs.
    { source: "/_next/:path*", destination: { service: "nextjs" } },
    { source: "/favicon.ico", destination: { service: "nextjs" } },
    // Each home page links to /api/slack/events, so send that to the example
    // the link was clicked on.
    ...names.map((name) => ({
      source: "/api/slack/events",
      has: [
        {
          type: "header" as const,
          key: "referer",
          value: `^https?://[^/]+/${name}(?:[/?#].*)?$`,
        },
      ],
      destination: { service: name },
    })),
  ],
};
