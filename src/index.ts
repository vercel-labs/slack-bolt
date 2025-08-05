import {
  VercelReceiverError,
  RequestParsingError,
  SignatureVerificationError,
} from "./errors";
import { waitUntil } from "@vercel/functions";

import {
  verifySlackRequest,
  type AckFn,
  type App,
  type Receiver,
  type ReceiverEvent,
  type StringIndexed,
} from "@slack/bolt";
import { ConsoleLogger, type Logger, LogLevel } from "@slack/logger";

// Types
/**
 * A function to handle the request from the Slack app.
 * @param req - The request from the Slack app.
 * @returns A response object.
 */
export type VercelHandler = (req: Request) => Promise<Response>;

/**
 * Configuration options for the VercelReceiver.
 * @property signingSecret - The signing secret for the Slack app.
 * @property signatureVerification - If true, verifies the Slack request signature.
 * @property logger - The logger to use for the VercelReceiver.
 * @property logLevel - The log level to use for the VercelReceiver.
 * @property customPropertiesExtractor - A function to extract custom properties from the request.
 * @property customResponseHandler - A function to handle the response from the Slack app.
 */
export interface VercelReceiverOptions {
  /**
   * The signing secret for the Slack app.
   * @default process.env.SLACK_SIGNING_SECRET
   */
  signingSecret?: string;
  /**
   * If true, verifies the Slack request signature.
   * @default true
   */
  signatureVerification?: boolean;
  /**
   * The logger to use for the VercelReceiver.
   * @default new ConsoleLogger()
   */
  logger?: Logger;
  /**
   * The log level to use for the VercelReceiver.
   * @default LogLevel.INFO
   */
  logLevel?: LogLevel;
  /**
   * A function to extract custom properties from incoming events.
   * @default undefined
   * @returns An object with custom properties.
   */
  customPropertiesExtractor?: (req: Request) => StringIndexed;
  /**
   * A function to handle the response from the Slack app.
   * @default undefined
   * @returns A response object.
   */
  customResponseHandler?: (event: ReceiverEvent) => Promise<Response>;
}

const SCOPE = ["@vercel/slack-bolt"];
const ACK_TIMEOUT_MS = 3001;
const SLACK_RETRY_NUM_HEADER = "x-slack-retry-num";
const SLACK_RETRY_REASON_HEADER = "x-slack-retry-reason";
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SLACK_SIGNATURE_HEADER = "x-slack-signature";

/**
 * A Slack Bolt receiver implementation designed for Vercel's serverless environment.
 * Handles Slack events, interactions, and slash commands with automatic request verification,
 * background processing, and timeout management.
 *
 * @example
 * ```typescript
 * import { App } from '@slack/bolt';
 * import { VercelReceiver, createHandler } from '@vercel/slack-bolt';
 *
 * const receiver = new VercelReceiver();
 *
 * const app = new App({
 *   receiver,
 *   token: process.env.SLACK_BOT_TOKEN,
 *   signingSecret: process.env.SLACK_SIGNING_SECRET,
 * });
 * ```
 *
 */
export class VercelReceiver implements Receiver {
  private readonly signingSecret: string;
  private readonly signatureVerification: boolean;
  private readonly logger: Logger;
  private readonly customPropertiesExtractor?: (req: Request) => StringIndexed;
  private readonly customResponseHandler?: (
    event: ReceiverEvent
  ) => Promise<Response>;
  private app?: App;

  /**
   * Gets the logger instance used by this receiver.
   * @returns The logger instance
   */
  public getLogger(): Logger {
    return this.logger;
  }

  /**
   * Creates a new VercelReceiver instance.
   *
   * @param options - Configuration options for the receiver
   * @throws {VercelReceiverError} When signing secret is not provided
   *
   * @example
   * ```typescript
   * const receiver = new VercelReceiver();
   * ```
   */
  public constructor({
    signingSecret = process.env.SLACK_SIGNING_SECRET,
    signatureVerification = true,
    logger,
    logLevel = LogLevel.INFO,
    customPropertiesExtractor,
    customResponseHandler,
  }: VercelReceiverOptions = {}) {
    if (!signingSecret) {
      throw new VercelReceiverError(
        "SLACK_SIGNING_SECRET is required for VercelReceiver"
      );
    }

    this.signingSecret = signingSecret;
    this.signatureVerification = signatureVerification;
    this.logger = this.createScopedLogger(
      logger ?? new ConsoleLogger(),
      logLevel
    );
    this.customPropertiesExtractor = customPropertiesExtractor;
    this.customResponseHandler = customResponseHandler;

    this.logger.debug("VercelReceiver initialized");
  }

  /**
   * Initializes the receiver with a Slack Bolt app instance.
   * This method is called automatically by the Bolt framework.
   *
   * @param app - The Slack Bolt app instance
   */
  public init(app: App): void {
    this.app = app;
    this.logger.debug("App initialized in VercelReceiver");
  }

  /**
   * Starts the receiver and returns a handler function for processing requests.
   * This method is called automatically by the Bolt framework.
   *
   * @returns A handler function that processes incoming Slack requests
   */
  public async start(): Promise<VercelHandler> {
    this.logger.debug("VercelReceiver started");
    return this.toHandler();
  }

  /**
   * Stops the receiver. This method is called automatically by the Bolt framework.
   */
  public async stop(): Promise<void> {
    this.logger.debug("VercelReceiver stopped");
  }

  /**
   * Creates a handler function that processes incoming Slack requests.
   * This is the main entry point for handling Slack events in Vercel.
   * It is called automatically by the Bolt framework in the start() method.
   *
   * @returns A handler function compatible with Vercel's function signature
   */
  public toHandler(): VercelHandler {
    return async (req: Request): Promise<Response> => {
      try {
        if (!this.app) {
          throw new VercelReceiverError("Slack app not initialized", 500);
        }

        const rawBody = await req.text();

        if (this.signatureVerification) {
          await this.verifySlackRequest(req, rawBody);
        }

        const body = await this.parseRequestBody(req, rawBody);

        if (body.type === "url_verification") {
          this.logger.debug("Handling URL verification challenge");
          return Response.json({ challenge: body.challenge });
        }

        return await this.handleSlackEvent(req, body);
      } catch (error) {
        return this.handleError(error);
      }
    };
  }

  private async parseRequestBody(
    req: Request,
    rawBody: string
  ): Promise<StringIndexed> {
    const contentType = req.headers.get("content-type");

    try {
      if (contentType === "application/x-www-form-urlencoded") {
        const parsedBody: StringIndexed = {};
        const params = new URLSearchParams(rawBody);

        for (const [key, value] of params.entries()) {
          parsedBody[key] = value;
        }

        if (typeof parsedBody.payload === "string") {
          return JSON.parse(parsedBody.payload);
        }
        return parsedBody;
      }
      if (contentType === "application/json") {
        return JSON.parse(rawBody);
      }

      this.logger.warn(`Unexpected content-type detected: ${contentType}`);

      return JSON.parse(rawBody);
    } catch (e) {
      throw new RequestParsingError(
        `Failed to parse body as JSON data for content-type: ${contentType}. Error: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  private async handleSlackEvent(
    req: Request,
    body: StringIndexed
  ): Promise<Response> {
    if (!this.app) {
      throw new VercelReceiverError("App not initialized", 500);
    }

    let isAcknowledged = false;
    let responseResolver: (value: Response) => void;
    let responseRejecter: (error: Error) => void;

    const responsePromise = new Promise<Response>((resolve, reject) => {
      responseResolver = resolve;
      responseRejecter = reject;
    });

    // Slack requires an acknowledgment from your app within 3 seconds
    const timeoutId = setTimeout(() => {
      if (!isAcknowledged) {
        this.logger.error("Event not acknowledged within timeout period");
        const error = new VercelReceiverError("Request timeout", 408);
        responseRejecter(error);
      }
    }, ACK_TIMEOUT_MS);

    // Create an acknowledgment function to handle ack() calls from Bolt while waiting for the event to be processed
    const ackFn: AckFn<StringIndexed> = async (ackResponse) => {
      if (isAcknowledged) {
        throw new Error("Cannot acknowledge an event multiple times");
      }

      isAcknowledged = true;
      clearTimeout(timeoutId);

      try {
        let response: Response;

        if (this.customResponseHandler) {
          const event = this.createSlackReceiverEvent({
            body,
            headers: req.headers,
            ack: ackFn,
            request: req,
          });
          response = await this.customResponseHandler(event);
        } else {
          const responseBody = ackResponse || null;
          const body =
            typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody);
          response = new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        responseResolver(response);
      } catch (error) {
        this.logger.error("Error in acknowledgment handler", error);
        responseRejecter(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };

    const event = this.createSlackReceiverEvent({
      body,
      headers: req.headers,
      ack: ackFn,
      request: req,
    });

    // Process event in background using waitUntil from Vercel Functions
    // https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil
    waitUntil(this.app.processEvent(event));

    try {
      return await responsePromise;
    } catch (error) {
      return this.handleError(error);
    }
  }

  private async verifySlackRequest(
    req: Request,
    rawBody: string
  ): Promise<void> {
    const timestamp = req.headers.get(SLACK_TIMESTAMP_HEADER);
    const signature = req.headers.get(SLACK_SIGNATURE_HEADER);

    if (!timestamp) {
      throw new SignatureVerificationError("Missing required timestamp header");
    }

    if (!signature) {
      throw new SignatureVerificationError(
        "Missing required signature headers"
      );
    }

    try {
      verifySlackRequest({
        signingSecret: this.signingSecret,
        body: rawBody,
        headers: {
          "x-slack-signature": signature,
          "x-slack-request-timestamp": Number.parseInt(timestamp, 10),
        },
        logger: this.logger,
      });
    } catch (error) {
      this.logger.error("Slack request verification failed", error);
      throw new SignatureVerificationError(
        error instanceof Error ? error.message : "Signature verification failed"
      );
    }
  }

  private createSlackReceiverEvent({
    body,
    headers,
    ack,
    request,
  }: {
    body: StringIndexed;
    headers: Headers;
    ack: AckFn<StringIndexed>;
    request: Request;
  }): ReceiverEvent {
    const customProperties = this.customPropertiesExtractor
      ? this.customPropertiesExtractor(request)
      : {};

    const retryNum = headers.get(SLACK_RETRY_NUM_HEADER) || "0";

    const retryReason = headers.get(SLACK_RETRY_REASON_HEADER) || "";

    return {
      body,
      ack,
      retryNum: Number(retryNum),
      retryReason,
      customProperties,
    };
  }

  private handleError(error: unknown): Response {
    if (error instanceof VercelReceiverError) {
      this.logger.error(`VercelReceiverError: ${error.message}`, {
        statusCode: error.statusCode,
        name: error.name,
      });
      return new Response(
        JSON.stringify({
          error: error.message,
          type: error.name,
        }),
        { status: error.statusCode }
      );
    }

    this.logger.error("Unexpected error in VercelReceiver", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        type: "UnexpectedError",
      }),
      { status: 500 }
    );
  }

  private createScopedLogger(logger: Logger, logLevel: LogLevel): Logger {
    const prefix = SCOPE.map((s) => `[${s}]`).join(" ");
    logger.setLevel(logLevel);

    return {
      ...logger,
      error: (...args) => logger.error?.(prefix, ...args),
      warn: (...args) => logger.warn?.(prefix, ...args),
      info: (...args) => logger.info?.(prefix, ...args),
      debug: (...args) => logger.debug?.(prefix, ...args),
      setLevel: logger.setLevel,
      getLevel: logger.getLevel,
    };
  }
}

/**
 * Creates a Vercel-compatible handler function for a Slack Bolt app.
 * This is the recommended way to create handlers for deployment on Vercel.
 *
 * @param {App} app - The initialized Slack Bolt app instance.
 * @param {VercelReceiver} receiver - The VercelReceiver instance.
 * @returns {VercelHandler} A handler function compatible with Vercel's function signature.
 *
 * @example
 * ```typescript
 * // api/events.ts
 * import { createHandler } from '@vercel/slack-bolt';
 * import { app, receiver } from '../app';
 *
 * const handler = createHandler(app, receiver);
 *
 * export const POST = async (req: Request) => {
 *   return handler(req);
 * };
 * ```
 *
 * @throws {Error} If app initialization fails.
 * @throws {VercelReceiverError} If request processing fails.
 */
export function createHandler(
  app: App,
  receiver: VercelReceiver
): VercelHandler {
  let initPromise: Promise<void> | null = null;

  return async (req: Request) => {
    try {
      if (!initPromise) {
        initPromise = app.init();
      }
      await initPromise;

      receiver.init(app);
      const handler = await receiver.start();
      return handler(req);
    } catch (error) {
      const logger = receiver.getLogger();
      logger.error("Error in createHandler:", error);
      return new Response(
        JSON.stringify({
          error: "Internal Server Error",
          type: "HandlerError",
        }),
        { status: 500 }
      );
    }
  };
}
