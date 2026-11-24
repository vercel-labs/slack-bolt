/** What a token is made of: visible ASCII characters and nothing else. */
const TOKEN = /^[!-~]+$/;

/**
 * Fails for a value that can't be a token, without repeating it. A token with
 * a line break in it, like one copied across a wrapped line, can't go in a
 * request header: fetch throws before anything is sent, with an error that
 * quotes the header and looks like the network failing.
 *
 * Space around the token is fine. fetch drops it from a header.
 */
export function assertToken(name: string, value: string | undefined): void {
  if (!value || TOKEN.test(value.trim())) return;
  throw new Error(
    `${name} contains a line break, space or non-ASCII character, so it isn't a valid token\nCopy it again in one piece and save it.`,
  );
}
