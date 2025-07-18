import type { VercelRequest, VercelResponse } from "@vercel/node";

export type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse
) => Promise<VercelResponse>;

export interface VercelReceiverOptions {
  signingSecret?: string;
  signatureVerification?: boolean;
}
