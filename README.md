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

Nothing in an example's folder refers to this repository: its `package.json` depends on the published `@vercel/slack-bolt`, so `slack create --template vercel-labs/slack-bolt --subdir examples/<name>` and each example's Deploy button copy it as-is. Inside this repository, `overrides` in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) links the examples to [`packages/slack-bolt`](./packages/slack-bolt) instead, and the root [`turbo.json`](./turbo.json) builds the library before them. The examples' lint and format settings live outside their folders too, in [`examples/.oxlintrc.json`](./examples/.oxlintrc.json) and the root config.

Until 2.0.0 is released, the examples depend on the `canary` dist-tag. Switch them to `^2.0.0` with the release.

## Hosting the examples

[`vercel.ts`](./vercel.ts) deploys all five examples to one Vercel project as [Vercel Services](https://vercel.com/docs/services), each under its own path, like `/nitro/api/slack/events`. Every service strips its prefix before the request reaches the app, so the examples themselves don't change. The project's Root Directory is the repository root and its Framework Preset is Services.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
