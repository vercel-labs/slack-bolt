import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { IncomingHttpHeaders } from "node:http";
import type {
  AckFn,
  App,
  Receiver,
  ReceiverEvent,
  StringIndexed,
} from "@slack/bolt";
import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Bolt Receiver for Vercel Fluid Compute
 */
export class VercelReceiver implements Receiver {
  private readonly signingSecret: string;
  private readonly signatureVerification: boolean;
  private app?: App;

  public constructor(options?: VercelReceiverOptions) {
    const providedSecret = options?.signingSecret;
    const envSecret = process.env.SLACK_SIGNING_SECRET;
    const resolvedSigningSecret = providedSecret ?? envSecret;

    if (!resolvedSigningSecret) {
      throw new Error(
        "SLACK_SIGNING_SECRET is required. Either provide signingSecret parameter or set SLACK_SIGNING_SECRET environment variable."
      );
    }

    this.signingSecret = resolvedSigningSecret;
    this.signatureVerification = options?.signatureVerification ?? true;
  }

  public init(app: App): void {
    this.app = app;
  }

  public start(): Promise<VercelHandler> {
    return new Promise((resolve, reject) => {
      try {
        const handler = this.toHandler();
        resolve(handler);
      } catch (error) {
        console.error("Error creating handler:", error);
        reject(error);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, _reject) => {
      resolve();
    });
  }

  public toHandler(): VercelHandler {
    return async (
      req: VercelRequest,
      res: VercelResponse
    ): Promise<VercelResponse> => {
      if (!this.app) {
        console.error("Slack app not initialized");
        return res.json({
          message: "Slack app not initialized",
          status: 500,
        });
      }
      const { headers, body } = req;

      if (this.signatureVerification) {
        const rawBody = await this.getRawBody(req);

        const timestamp = this.getHeaderValue(
          headers,
          "x-slack-request-timestamp"
        );
        const signature = this.getHeaderValue(headers, "x-slack-signature");

        if (!timestamp || !signature) {
          console.error("Missing required headers");
          return res.json({ message: "Unauthorized" });
        }

        const isValidSignature = this.verifySlackRequest(
          timestamp,
          signature,
          rawBody
        );

        if (!isValidSignature) {
          console.error("Invalid request signature");
          return res.json({ message: "Unauthorized" });
        }
      }

      if (body.type === "url_verification") {
        return res.json({ message: body.challenge });
      }

      let isAcknowledged = false;
      let storedResponse: unknown;
      let responsePromiseResolve: (value: VercelResponse) => void;
      // Create a promise that resolves when ack is called or processing completes
      const responsePromise = new Promise<VercelResponse>((resolve) => {
        responsePromiseResolve = resolve;
      });

      const noAckTimeoutId = setTimeout(() => {
        if (!isAcknowledged) {
          console.error(
            "An incoming event was not acknowledged within 3 seconds. " +
              "Ensure that the ack() argument is called in a listener."
          );
          // Return a default response if no ack within timeout
          responsePromiseResolve(
            res.send("Command timed out - no acknowledgment received")
          );
        }
      }, 3001);

      const event = this.createSlackReceiverEvent({
        body,
        headers: req.headers,
        ack: async (response) => {
          if (isAcknowledged) {
            throw new Error("Multiple ack calls");
          }
          isAcknowledged = true;
          clearTimeout(noAckTimeoutId);

          if (typeof response === "undefined" || response == null) {
            storedResponse = "";
          } else {
            storedResponse = response;
          }

          // Immediately resolve with the ack response
          if (typeof storedResponse === "string") {
            responsePromiseResolve(res.send(storedResponse));
          } else {
            responsePromiseResolve(res.json(storedResponse));
          }
        },
      });

      waitUntil(this.app.processEvent(event));

      try {
        return await responsePromise;
      } catch (err) {
        console.error("Error in response handling:", err);
        return res.json({ message: "Internal server error", status: 500 });
      }
    };
  }

  private getHeaderValue(
    headers: IncomingHttpHeaders,
    name: string
  ): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private verifySlackRequest(
    timestamp: string,
    signature: string,
    body: string
  ): boolean {
    // Check timestamp to prevent replay attacks (max 5 minutes)
    const requestTime = Number.parseInt(timestamp, 10);
    const currentTime = Math.floor(Date.now() / 1000);

    if (Math.abs(currentTime - requestTime) > 300) {
      console.error(
        "Request timestamp is more than 5 minutes old. Possible replay attack."
      );
      return false;
    }

    const baseString = `v0:${timestamp}:${body}`;

    const computedSignature = `v0=${createHmac("sha256", this.signingSecret)
      .update(baseString, "utf8")
      .digest("hex")}`;

    try {
      return timingSafeEqual(
        Buffer.from(signature, "utf8"),
        Buffer.from(computedSignature, "utf8")
      );
    } catch (error) {
      console.error("Error comparing signatures:", error);
      return false;
    }
  }

  private async getRawBody(req: VercelRequest): Promise<string> {
    let rawBody = "";
    for await (const chunk of req) {
      rawBody += chunk;
    }

    return rawBody;
  }

  private createSlackReceiverEvent({
    body,
    headers,
    ack,
  }: {
    body: StringIndexed;
    headers: IncomingHttpHeaders;
    ack: AckFn<StringIndexed>;
  }): ReceiverEvent {
    return {
      body,
      ack,
      retryNum: Number(
        this.getHeaderValue(headers, "X-Slack-Retry-Num") || "0"
      ),
      retryReason:
        this.getHeaderValue(headers, "X-Slack-Retry-Reason") ?? undefined,
      customProperties: {},
    };
  }
}

export function handler(app: App, receiver: VercelReceiver): VercelHandler {
  let initPromise: Promise<void> | null = null;

  return async (
    req: VercelRequest,
    res: VercelResponse
  ): Promise<VercelResponse> => {
    try {
      if (!initPromise) {
        initPromise = app.init();
      }
      await initPromise;

      const handler = await receiver.start();
      return await handler(req, res);
    } catch (error) {
      console.error("Error processing Slack event:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  };
}

export type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse
) => Promise<VercelResponse>;

export interface VercelReceiverOptions {
  signingSecret?: string;
  signatureVerification?: boolean;
}
