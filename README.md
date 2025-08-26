# @vercel/slack-bolt

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

## Getting Started

Visit our [template](https://vercel.com/templates/backend/slack-bolt-with-nitro) to get started building a Slack app.


## Installation
```bash
npm install @vercel/slack-bolt
# or
yarn add @vercel/slack-bolt
# or
pnpm add @vercel/slack-bolt
# or
bun add @vercel/slack-bolt
```

## API Reference

### `VercelReceiver`
Responsible for handling and parsing any incoming requests from Slack and then forwarding them to your Bolt app for event processing.

```typescript
import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";

const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

app.message(/^(hi|hello|hey).*/, async ({ say }) => {
  await say("Hello, world!");
});

export { app, receiver };
```
#### Parameters

| Name | Type | Default Value | Required | Description |
| --- | --- | --- | --- | --- |
| `signingSecret` | `string` | `process.env.SLACK_SIGNING_SECRET` | No<sup>1</sup> | Signing secret for your Slack app used to verify requests. |
| `signatureVerification` | `boolean` | `true` | No | Enable or disable request signature verification. |
| `logger` | `Logger`<sup>2</sup> | `new ConsoleLogger()` | No | Logger used for diagnostics. |
| `logLevel` | `LogLevel`<sup>2</sup> | `LogLevel.INFO` | No | Minimum log level for the logger. |
| `customPropertiesExtractor` | `(req: Request) => StringIndexed` | `undefined` | No | Return value is merged into Bolt event `customProperties`<sup>2</sup>. |
| `ackTimeoutMs` | `number` | `3001` | No | Milliseconds to wait for `ack()` before returning a timeout error. |

<sup>1</sup> Optional if `process.env.SLACK_SIGNING_SECRET` is provided.

<sup>2</sup> Provided by the [`@slack/bolt`](https://www.npmjs.com/package/@slack/bolt) library. More information [here](https://docs.slack.dev/tools/bolt-js/reference#app-options).


### `createHandler`
A function that returns a Vercel-compatible request handler that will initialize and start your Bolt app to process the event.

```typescript
// An example using Next.js route handlers

import { createHandler } from "@vercel/slack-bolt"
import { app, receiver } from "./app"

export const POST = createHandler(app, receiver)
```

#### Parameters

| Name        | Type        | Required | Description                                                          |
|-------------|-------------|----------|----------------------------------------------------------------------|
| `app`       | `App`<sup>1</sup>       | Yes       | Your Bolt app                                            |
| `receiver`  | `VercelReceiver`  | Yes       | The Vercel receiver instance used to process Slack requests.   |

<sup>1</sup> Provided by the [`@slack/bolt`](https://www.npmjs.com/package/@slack/bolt) library. More information [here](https://docs.slack.dev/tools/bolt-js/reference#app-options).

## Examples
Starter templates: [Next.js](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/nextjs), [Hono](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/hono), [Nitro](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/nitro).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
