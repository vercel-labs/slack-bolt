import {
  VercelReceiverError,
  RequestParsingError,
  SignatureVerificationError,
} from "./errors";
import { waitUntil } from "@vercel/functions";
import type { IncomingHttpHeaders } from "node:http";
import {
  verifySlackRequest,
  type AckFn,
  type App,
  type Receiver,
  type ReceiverEvent,
  type StringIndexed,
} from "@slack/bolt";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ConsoleLogger, type Logger, LogLevel } from "@slack/logger";

// Constants
const SCOPE = ["@vercel/bolt", "VercelReceiver"];
const ACK_TIMEOUT_MS = 3001;
const SLACK_RETRY_NUM_HEADER = "x-slack-retry-num";
const SLACK_RETRY_REASON_HEADER = "x-slack-retry-reason";
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SLACK_SIGNATURE_HEADER = "x-slack-signature";

export class VercelReceiver implements Receiver {
  private readonly signingSecret: string;
  private readonly signatureVerification: boolean;
  private readonly logger: Logger;
  private readonly customPropertiesExtractor?: (
    req: VercelRequest
  ) => StringIndexed;
  private readonly customResponseHandler?: (
    event: ReceiverEvent,
    res: VercelResponse
  ) => Promise<VercelResponse>;
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
    return async (
      req: VercelRequest,
      res: VercelResponse
    ): Promise<VercelResponse> => {
      const startTime = Date.now();

      try {
        if (!this.app) {
          throw new VercelReceiverError("Slack app not initialized", 500);
        }

        this.logger.debug("Processing incoming request", {
          method: req.method,
          url: req.url,
          headers: req.headers,
        });

        // Parse request body
        const { body, rawBody } = await this.parseRequestBody(req);

        // Verify signature if enabled
        if (this.signatureVerification) {
          await this.verifySlackRequest(req, rawBody);
        }

        // Handle URL verification challenge
        if (body.type === "url_verification") {
          this.logger.debug("Handling URL verification challenge");
          return res.status(200).json({ challenge: body.challenge });
        }

        // Process Slack event
        const response = await this.handleSlackEvent(req, res, body, rawBody);

        const processingTime = Date.now() - startTime;
        this.logger.debug(`Request processed in ${processingTime}ms`);

        return response;
      } catch (error) {
        return this.handleError(error, res);
      }
    };
  }

  private async parseRequestBody(
    req: VercelRequest
  ): Promise<ParsedRequestBody> {
    try {
      let rawBody: string;

      // Handle different ways body might be provided
      if (typeof req.body === "string") {
        rawBody = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString("utf8");
      } else if (req.body && typeof req.body === "object") {
        // Body is already parsed
        rawBody = JSON.stringify(req.body);
        return { body: req.body, rawBody };
      } else {
        // Read from stream
        rawBody = await this.getRawBody(req);
      }

      const contentType =
        this.getHeaderValue(req.headers, "content-type") || "";
      let body: StringIndexed;

      if (contentType.includes("application/json")) {
        body = JSON.parse(rawBody);
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const urlParams = new URLSearchParams(rawBody);
        const payload = urlParams.get("payload");
        body = payload ? JSON.parse(payload) : Object.fromEntries(urlParams);
      } else {
        // Default to JSON parsing
        body = JSON.parse(rawBody);
      }

      return { body, rawBody };
    } catch (error) {
      this.logger.error("Failed to parse request body", error);
      throw new RequestParsingError(`Failed to parse request body: ${error}`);
    }
  }

  private async handleSlackEvent(
    req: VercelRequest,
    res: VercelResponse,
    body: StringIndexed,
    rawBody: string
  ): Promise<VercelResponse> {
    if (!this.app) {
      throw new VercelReceiverError("App not initialized", 500);
    }

    let isAcknowledged = false;
    let responseResolver: (value: VercelResponse) => void;
    let responseRejecter: (error: Error) => void;

    const responsePromise = new Promise<VercelResponse>((resolve, reject) => {
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
    const ackFn: AckFn<StringIndexed> = async (response) => {
      if (isAcknowledged) {
        throw new Error("Cannot acknowledge an event multiple times");
      }

      isAcknowledged = true;
      clearTimeout(timeoutId);

      try {
        let vercelResponse: VercelResponse;

        if (this.customResponseHandler) {
          const event = this.createSlackReceiverEvent({
            body,
            headers: req.headers,
            ack: ackFn,
            request: req,
          });
          vercelResponse = await this.customResponseHandler(event, res);
        } else {
          const responseData = response ?? "";
          vercelResponse =
            typeof responseData === "string"
              ? res.status(200).send(responseData)
              : res.status(200).json(responseData);
        }

        responseResolver(vercelResponse);
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
    req: VercelRequest,
    rawBody: string
  ): Promise<void> {
    const timestamp = this.getHeaderValue(req.headers, SLACK_TIMESTAMP_HEADER);
    const signature = this.getHeaderValue(req.headers, SLACK_SIGNATURE_HEADER);

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

  private async getRawBody(req: VercelRequest): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  private createSlackReceiverEvent({
    body,
    headers,
    ack,
    request,
  }: {
    body: StringIndexed;
    headers: IncomingHttpHeaders;
    ack: AckFn<StringIndexed>;
    request?: VercelRequest;
  }): ReceiverEvent {
    const customProperties = this.customPropertiesExtractor
      ? this.customPropertiesExtractor(request!)
      : {};

    return {
      body,
      ack,
      retryNum: Number(
        this.getHeaderValue(headers, SLACK_RETRY_NUM_HEADER) || "0"
      ),
      retryReason: this.getHeaderValue(headers, SLACK_RETRY_REASON_HEADER),
      customProperties,
    };
  }

  private getHeaderValue(
    headers: IncomingHttpHeaders,
    name: string
  ): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private handleError(error: unknown, res: VercelResponse): VercelResponse {
    if (error instanceof VercelReceiverError) {
      this.logger.error(`VercelReceiverError: ${error.message}`, {
        statusCode: error.statusCode,
        name: error.name,
      });
      return res.status(error.statusCode).json({
        error: error.message,
        type: error.name,
      });
    }

    this.logger.error("Unexpected error in VercelReceiver", error);
    return res.status(500).json({
      error: "Internal server error",
      type: "UnexpectedError",
    });
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

  return async (req: VercelRequest, res: VercelResponse) => {
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
      return res.status(500).json({
        error: "Internal Server Error",
        type: "HandlerError",
      });
    }
  };
}

// Types
export type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse
) => Promise<VercelResponse>;

export interface VercelReceiverOptions {
  signingSecret?: string;
  signatureVerification?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  customPropertiesExtractor?: (req: VercelRequest) => StringIndexed;
  customResponseHandler?: (
    event: ReceiverEvent,
    res: VercelResponse
  ) => Promise<VercelResponse>;
}

interface ParsedRequestBody {
  body: StringIndexed;
  rawBody: string;
}
