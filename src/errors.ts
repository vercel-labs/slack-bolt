export class VercelReceiverError extends Error {
  constructor(message: string, public readonly statusCode: number = 500) {
    super(message);
    this.name = "VercelReceiverError";
  }
}

export class SignatureVerificationError extends VercelReceiverError {
  constructor(message: string = "Invalid request signature") {
    super(message, 401);
    this.name = "SignatureVerificationError";
  }
}

export class RequestParsingError extends VercelReceiverError {
  constructor(message: string = "Failed to parse request") {
    super(message, 400);
    this.name = "RequestParsingError";
  }
}
