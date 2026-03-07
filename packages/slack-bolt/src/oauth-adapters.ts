import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Converts a Web API Request into a minimal object that satisfies
 * the IncomingMessage properties accessed by @slack/oauth's InstallProvider:
 * - req.url (path + query string)
 * - req.method
 * - req.headers.host
 * - req.headers.cookie
 */
export function toIncomingMessage(req: Request): IncomingMessage {
  const url = new URL(req.url);
  const headers: Record<string, string | undefined> = {
    host: req.headers.get("host") ?? undefined,
    cookie: req.headers.get("cookie") ?? undefined,
  };

  return {
    url: url.pathname + url.search,
    method: req.method,
    headers,
  } as unknown as IncomingMessage;
}

interface ResponseCapture extends ServerResponse {
  toResponse(): Response;
}

/**
 * Creates an object that satisfies the ServerResponse methods called by
 * @slack/oauth's InstallProvider:
 * - res.setHeader(name, value) / res.getHeader(name) / res.removeHeader(name) / res.hasHeader(name)
 * - res.writeHead(statusCode, headers?)
 * - res.write(chunk?) / res.end(body?)
 *
 * After InstallProvider finishes writing, call toResponse() to build
 * a standard Web API Response from the captured data.
 */
export function createResponseCapture(): ResponseCapture {
  let statusCode = 200;
  const headers = new Headers();
  let body = "";

  const capture = {
    setHeader(name: string, value: string | string[]) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(name, v);
        }
      } else {
        headers.set(name, value);
      }
      return capture;
    },
    getHeader(name: string): string | string[] | undefined {
      const values =
        name.toLowerCase() === "set-cookie"
          ? headers.getSetCookie()
          : [headers.get(name)].filter(Boolean);
      if (values.length === 0) return undefined;
      if (values.length === 1) return values[0] as string;
      return values as string[];
    },
    removeHeader(name: string) {
      headers.delete(name);
    },
    hasHeader(name: string): boolean {
      return headers.has(name);
    },
    get headersSent() {
      return false;
    },
    writeHead(code: number, rawHeaders?: Record<string, string>) {
      statusCode = code;
      if (rawHeaders) {
        for (const [key, val] of Object.entries(rawHeaders)) {
          headers.set(key, val);
        }
      }
      return capture;
    },
    write(chunk?: string) {
      if (chunk) {
        body += chunk;
      }
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        body += chunk;
      }
      return capture;
    },
    toResponse(): Response {
      return new Response(body || null, { status: statusCode, headers });
    },
  } as unknown as ResponseCapture;

  return capture;
}
