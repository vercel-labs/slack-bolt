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
}
