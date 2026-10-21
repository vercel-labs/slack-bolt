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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

Install dependencies with `pnpm install`. Inside this repo, the examples use `packages/slack-bolt` instead of the published package.

Run one example's dev server, with the library rebuilding as you change it:

```bash
pnpm dev --filter=@vercel/slack-bolt --filter=slack-bolt-with-next
```

Swap in another example's name from the table above, and set the environment variables its README lists. Every example's dev server defaults to port 3000, so `pnpm dev` without filters starts all five at once and some of them fail to start.

Before you open a pull request, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. `pnpm typecheck` also builds the Next.js example, so first copy `examples/nextjs/.env.example` to `examples/nextjs/.env.local`, as CI does.
