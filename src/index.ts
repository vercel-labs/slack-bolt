import {
  type AckFn,
  type App,
  type Receiver,
  ReceiverAuthenticityError,
  type ReceiverEvent,
  ReceiverMultipleAckError,
  type StringIndexed,
  verifySlackRequest,
} from "@slack/bolt";
import { ConsoleLogger, type Logger, LogLevel } from "@slack/logger";
import { waitUntil } from "@vercel/functions";
import {
  ERROR_MESSAGES,
  getErrorMessage,
  getErrorType,
  getStatusCode,
  RequestParsingError,
  VercelReceiverError,
} from "./errors";

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
   * The timeout in milliseconds for event acknowledgment.
   * @default 3001
   */
  ackTimeoutMs?: number;
}

const LOG_PREFIX = "[@vercel/slack-bolt]";
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
  private readonly ackTimeoutMs: number;
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
    ackTimeoutMs = ACK_TIMEOUT_MS,
  }: VercelReceiverOptions = {}) {
    if (!signingSecret) {
      throw new VercelReceiverError(ERROR_MESSAGES.SIGNING_SECRET_REQUIRED);
    }

    this.signingSecret = signingSecret;
    this.signatureVerification = signatureVerification;
    this.logger = this.createScopedLogger(
      logger ?? new ConsoleLogger(),
      logLevel,
    );
    this.customPropertiesExtractor = customPropertiesExtractor;
    this.ackTimeoutMs = ackTimeoutMs;

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
        const rawBody = await req.text();

        if (this.signatureVerification) {
          this.verifyRequest(req, rawBody);
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
    rawBody: string,
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
        }`,
      );
    }
  }

  private async handleSlackEvent(
    req: Request,
    body: StringIndexed,
  ): Promise<Response> {
    if (!this.app) {
      throw new VercelReceiverError(ERROR_MESSAGES.APP_NOT_INITIALIZED, 500);
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
        isAcknowledged = true;
        this.logger.error(ERROR_MESSAGES.EVENT_NOT_ACKNOWLEDGED);
        const error = new VercelReceiverError(
          ERROR_MESSAGES.REQUEST_TIMEOUT,
          408,
        );
        responseRejecter(error);
      }
    }, this.ackTimeoutMs);

    // Create acknowledgment function
    const ackFn: AckFn<StringIndexed> = async (responseBody) => {
      this.logger.debug(`ack() call begins (body: ${responseBody})`);
      if (isAcknowledged) {
        throw new ReceiverMultipleAckError();
      }

      isAcknowledged = true;
      clearTimeout(timeoutId);

      try {
        let body: string | undefined;
        if (typeof responseBody === "undefined") {
          body = undefined;
        } else if (typeof responseBody === "string") {
          body = responseBody;
        } else {
          body = JSON.stringify(responseBody);
        }
        const response = new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });

        responseResolver(response);
      } catch (error) {
        this.logger.error(ERROR_MESSAGES.ACKNOWLEDGMENT_ERROR, error);
        responseRejecter(
          error instanceof Error ? error : new Error(String(error)),
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
    waitUntil(
      this.app.processEvent(event).catch((error) => {
        return this.handleError(error);
      }),
    );

    try {
      return await responsePromise;
    } catch (error) {
      return this.handleError(error);
    }
  }

  private verifyRequest(req: Request, body: string): void {
    const timestamp = req.headers.get(SLACK_TIMESTAMP_HEADER);
    const signature = req.headers.get(SLACK_SIGNATURE_HEADER);

    if (!signature) {
      throw new ReceiverAuthenticityError(
        ERROR_MESSAGES.MISSING_REQUIRED_HEADER(SLACK_SIGNATURE_HEADER),
      );
    }

    if (!timestamp) {
      throw new ReceiverAuthenticityError(
        ERROR_MESSAGES.MISSING_REQUIRED_HEADER(SLACK_TIMESTAMP_HEADER),
      );
    }

    try {
      verifySlackRequest({
        signingSecret: this.signingSecret,
        body,
        headers: {
          "x-slack-signature": signature,
          "x-slack-request-timestamp": Number.parseInt(timestamp, 10),
        },
        logger: this.logger,
      });
    } catch (error) {
      throw new ReceiverAuthenticityError(
        error instanceof Error
          ? error.message
          : "Failed to verify request signature",
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

  public handleError(error: unknown): Response {
    const errorMessage = getErrorMessage(error);
    const errorType = getErrorType(error);
    const errorStatusCode = getStatusCode(error);

    this.logger.error(error);
    return new Response(
      JSON.stringify({
        error: errorMessage,
        type: errorType,
      }),
      {
        status: errorStatusCode,
        headers: { "content-type": "application/json" },
      },
    );
  }

  private createScopedLogger(logger: Logger, logLevel: LogLevel): Logger {
    logger.setLevel(logLevel);

    return {
      ...logger,
      error: (...args) => logger.error?.(LOG_PREFIX, ...args),
      warn: (...args) => logger.warn?.(LOG_PREFIX, ...args),
      info: (...args) => logger.info?.(LOG_PREFIX, ...args),
      debug: (...args) => logger.debug?.(LOG_PREFIX, ...args),
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
  receiver: VercelReceiver,
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
      // if app.init fails, we use console.error instead of logger.error because the logger is not available
      console.error(ERROR_MESSAGES.CREATE_HANDLER_ERROR, error);
      return new Response(
        JSON.stringify({
          error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR_HANDLER,
          type: ERROR_MESSAGES.TYPES.HANDLER_ERROR,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  };
}
