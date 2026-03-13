/**
 * Minimal Web <-> Node HTTP adapters for @slack/oauth InstallProvider.
 *
 * These do NOT implement the full IncomingMessage/ServerResponse contract.
 * Only the methods actually called by InstallProvider are intercepted.
 * Do not reuse for other Node libraries without verifying which methods
 * they call.
 *
 * Targets @slack/oauth\@3.0.5 InstallProvider internals.
 * Do not upgrade without running the integration tests.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

export type ResponseCapture = ServerResponse & { toResponse(): Response };

/**
 * Wraps a Web API Request as a minimal Node.js IncomingMessage
 * so it can be passed to @slack/oauth's InstallProvider methods.
 */
export function toIncomingMessage(req: Request): IncomingMessage {
  const url = new URL(req.url);
  // Dummy socket — satisfies the IncomingMessage constructor but is never connected.
  const msg = new IncomingMessage(new Socket());
  msg.url = url.pathname + url.search;
  msg.method = req.method;
  for (const [key, value] of req.headers.entries()) {
    msg.headers[key.toLowerCase()] = value;
  }

  if (req.body) {
    req
      .arrayBuffer()
      .then((buf) => {
        msg.push(Buffer.from(buf));
        msg.push(null);
      })
      .catch(() => msg.destroy());
  } else {
    msg.push(null);
  }

  return msg;
}

/**
 * Creates a fake ServerResponse that captures setHeader/writeHead/end calls
 * and converts them into a Web API Response.
 *
 * InstallProvider uses res.setHeader() for Location, Set-Cookie, Content-Type
 * and res.getHeader() to read back Set-Cookie before appending.
 */
export function createResponseCapture(): ResponseCapture {
  let statusCode = 200;
  const capturedHeaders: Record<string, string | string[]> = {};
  const chunks: Buffer[] = [];

  // Dummy socket/message pair — never connected, just satisfies the constructor.
  const res = new ServerResponse(new IncomingMessage(new Socket()));

  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (
    name: string,
    value: string | number | readonly string[],
  ) => {
    const key = name.toLowerCase();
    if (Array.isArray(value)) {
      capturedHeaders[key] = [...value];
    } else {
      capturedHeaders[key] = String(value);
    }
    return originalSetHeader(name, value);
  };

  const originalGetHeader = res.getHeader.bind(res);
  res.getHeader = (name: string): string | number | string[] | undefined => {
    const val = capturedHeaders[name.toLowerCase()];
    if (val !== undefined) return val;
    return originalGetHeader(name);
  };

  const originalWriteHead = res.writeHead.bind(res);
  // writeHead has four overloads: (code), (code, message), (code, headers),
  // and (code, message, headers). We sniff for the first non-array object arg
  // to find the headers object in all cases.
  // biome-ignore lint/suspicious/noExplicitAny: writeHead has many overloads
  res.writeHead = (code: number, ...args: any[]) => {
    statusCode = code;
    const headersArg = args.find(
      (a) => a !== undefined && typeof a === "object" && !Array.isArray(a),
    ) as Record<string, string | string[]> | undefined;
    if (headersArg) {
      for (const [key, value] of Object.entries(headersArg)) {
        const lower = key.toLowerCase();
        capturedHeaders[lower] = value;
      }
    }
    return originalWriteHead(code, ...args);
  };

  const originalEnd = res.end.bind(res);
  // biome-ignore lint/suspicious/noExplicitAny: end has many overloads
  res.end = (chunk?: any, ...args: any[]) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return originalEnd(chunk, ...args);
  };

  (res as ResponseCapture).toResponse = () => {
    const body = chunks.length > 0 ? Buffer.concat(chunks).toString() : null;
    const webHeaders = new Headers();
    for (const [key, value] of Object.entries(capturedHeaders)) {
      if (Array.isArray(value)) {
        for (const v of value) webHeaders.append(key, v);
      } else {
        webHeaders.set(key, value);
      }
    }
    return new Response(body, { status: statusCode, headers: webHeaders });
  };

  return res as ResponseCapture;
}
