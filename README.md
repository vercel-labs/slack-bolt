# slack-bolt

Monorepo for [`@vercel/slack-bolt`](https://www.npmjs.com/package/@vercel/slack-bolt) — a custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

## Packages

| Package | Description |
| --- | --- |
| [`@vercel/slack-bolt`](./packages/slack-bolt) | Core library and CLI |

## Examples

| Example | Description |
| --- | --- |
| [`slack-bolt-with-next`](./examples/nextjs) | Next.js starter template |
| [`slack-bolt-with-hono`](./examples/hono) | Hono starter template |
| [`slack-bolt-with-express`](./examples/express) | Express starter template |
| [`slack-bolt-with-tanstack-start`](./examples/tanstack-start) | TanStack Start starter template |
| [`slack-bolt-with-nitro`](./examples/nitro) | Nitro starter template |

Each example is a standalone template that serves its Slack route at `/api/slack/events`.

## Hosting the examples

[`vercel.ts`](./vercel.ts) deploys all five examples to one Vercel project as [Vercel Services](https://vercel.com/docs/services), each under its own path, like `/nitro/api/slack/events`. Every service strips its prefix before the request reaches the app, so the examples themselves don't change. The project's Root Directory is the repository root and its Framework Preset is Services.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
