export class HTTPError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public body?: string,
  ) {
    const parts = [`${message}: ${status} ${statusText}`];
    if (body) parts.push(body);
    super(parts.join(" - "));
  }

  static async fromResponse(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    let body: string | undefined;
    try {
      const text = await response.text();
      if (text) body = text;
    } catch {
      // body unreadable, that's fine
    }
    return new HTTPError(message, response.status, response.statusText, body);
  }

  /**
   * Sanitized variant for endpoints that submit or retrieve secrets.
   *
   * Never includes the raw response body in the error message or attaches
   * it to the error object, since Vercel error bodies may echo submitted
   * values (e.g. secrets or env var values) and thrown errors end up in
   * CLI/build logs. At most, the Vercel error `code` (from the standard
   * `{ "error": { "code": string } }` shape) is included — never
   * `error.message` and never the raw body.
   */
  static async fromResponseRedacted(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    let code: string | undefined;
    try {
      const data: unknown = JSON.parse(await response.text());
      if (
        data !== null &&
        typeof data === "object" &&
        "error" in data &&
        data.error !== null &&
        typeof data.error === "object" &&
        "code" in data.error &&
        typeof data.error.code === "string"
      ) {
        code = data.error.code;
      }
    } catch {
      // body unreadable or not JSON, that's fine
    }
    const error = new HTTPError(message, response.status, response.statusText);
    if (code) error.message += ` (code: ${code})`;
    return error;
  }
}
