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

// Constants
const SCOPE = ["@vercel/bolt"];
const ACK_TIMEOUT_MS = 3001;
const SLACK_RETRY_NUM_HEADER = "x-slack-retry-num";
const SLACK_RETRY_REASON_HEADER = "x-slack-retry-reason";
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SLACK_SIGNATURE_HEADER = "x-slack-signature";

export class VercelReceiver implements Receiver {
  private readonly signingSecret: string;
  private readonly signatureVerification: boolean;
  private readonly logger: Logger;
  private readonly customPropertiesExtractor?: (req: Request) => StringIndexed;
  private readonly customResponseHandler?: (
    event: ReceiverEvent,
    res: Response
  ) => Promise<Response>;
  private app?: App;

  public getLogger(): Logger {
    return this.logger;
  }

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

  public init(app: App): void {
    this.app = app;
    this.logger.debug("App initialized in VercelReceiver");
  }

  public async start(): Promise<VercelHandler> {
    this.logger.debug("VercelReceiver started");
    return this.toHandler();
  }

  public async stop(): Promise<void> {
    this.logger.debug("VercelReceiver stopped");
  }

  public toHandler(): VercelHandler {
    return async (req: Request, res: Response): Promise<Response> => {
      const startTime = Date.now();

      try {
        if (!this.app) {
          throw new VercelReceiverError("Slack app not initialized", 500);
        }

        const rawBody = await req.text();

        // Verify signature if enabled
        if (this.signatureVerification) {
          await this.verifySlackRequest(req, rawBody);
        }

        const body = await this.parseRequestBody(req, rawBody);

        // Handle URL verification challenge
        if (body.type === "url_verification") {
          this.logger.debug("Handling URL verification challenge");
          return new Response(JSON.stringify({ challenge: body.challenge }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        // Process Slack event
        const response = await this.handleSlackEvent(req, res, body);

        const processingTime = Date.now() - startTime;
        this.logger.debug(`Request processed in ${processingTime}ms`);

        return response;
      } catch (error) {
        return this.handleError(error, res);
      }
    };
  }

  private async parseRequestBody(
    req: Request,
    rawBody: string
  ): Promise<StringIndexed> {
    const contentType = req?.headers.get("content-type") ?? undefined;

    try {
      if (contentType === "application/x-www-form-urlencoded") {
        // Parse URL-encoded form data
        const parsedBody: StringIndexed = {};
        const params = new URLSearchParams(rawBody);

        for (const [key, value] of params.entries()) {
          parsedBody[key] = value;
        }

        // Check if payload field contains JSON (common with Slack)
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
      this.logger.error(
        `Failed to parse body as JSON data for content-type: ${contentType}`
      );
      throw new RequestParsingError(
        `Failed to parse body as JSON data for content-type: ${contentType}`
      );
    }
  }

  private async handleSlackEvent(
    req: Request,
    res: Response,
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

    // Set up acknowledgment timeout
    const timeoutId = setTimeout(() => {
      if (!isAcknowledged) {
        this.logger.error("Event not acknowledged within timeout period");
        const error = new VercelReceiverError("Request timeout", 408);
        responseRejecter(error);
      }
    }, ACK_TIMEOUT_MS);

    // Create acknowledgment function
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
          response = await this.customResponseHandler(event, res);
        } else {
          const responseBody = ackResponse || {};
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

    // Create Slack receiver event
    const event = this.createSlackReceiverEvent({
      body,
      headers: req.headers,
      ack: ackFn,
      request: req,
    });

    // Process event in background
    waitUntil(this.app.processEvent(event));

    try {
      return await responsePromise;
    } catch (error) {
      return this.handleError(error, res);
    }
  }

  private async verifySlackRequest(
    req: Request,
    rawBody: string
  ): Promise<void> {
    const timestamp = req.headers.get(SLACK_TIMESTAMP_HEADER);
    const signature = req.headers.get(SLACK_SIGNATURE_HEADER);

    if (!timestamp || !signature) {
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
    request?: Request;
  }): ReceiverEvent {
    const customProperties = this.customPropertiesExtractor
      ? this.customPropertiesExtractor(request!)
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

  private handleError(error: unknown, res: Response): Response {
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

// Convenience handler function
export function createHandler(
  app: App,
  receiver: VercelReceiver
): VercelHandler {
  let initPromise: Promise<void> | null = null;

  return async (req: Request, res: Response) => {
    try {
      if (!initPromise) {
        initPromise = app.init();
      }
      await initPromise;

      receiver.init(app);
      const handler = await receiver.start();
      return handler(req, res);
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

// Types
export type VercelHandler = (req: Request, res: Response) => Promise<Response>;

export interface VercelReceiverOptions {
  signingSecret?: string;
  signatureVerification?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  customPropertiesExtractor?: (req: Request) => StringIndexed;
  customResponseHandler?: (
    event: ReceiverEvent,
    res: Response
  ) => Promise<Response>;
}
