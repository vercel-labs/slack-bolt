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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

Install dependencies with `pnpm install`. Inside this repo, the example uses `packages/slack-bolt` instead of the published package.

Run the example's dev server, with the library rebuilding as you change it:

```bash
pnpm dev --filter=@vercel/slack-bolt --filter=slack-bolt-with-next
```

Set the environment variables the example's README lists first.

Before you open a pull request, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. `pnpm typecheck` also builds the Next.js example, so first copy `examples/nextjs/.env.example` to `examples/nextjs/.env.local`, as CI does.
