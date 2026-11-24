// The other tests import `src`, and attw only reads types. These run the built
// package in a fresh Node.js process, resolved through its `exports` the way an
// installed copy is. They need a build first; `turbo run test` does that.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const { version } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as { version: string };

// Runs from the package directory, where `@vercel/slack-bolt` resolves to the
// package itself.
const node = (...args: string[]) =>
  execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" }).trim();

// Prints the status of a request that matches no route.
const PRINT_STATUS = `new VercelReceiver({ signatureVerification: false })
  .fetch(new Request("http://localhost/unknown"))
  .then((response) => console.log(response.status));`;

describe("built package", () => {
  // Jest and some bundlers can't require() an ES module, so the CommonJS build
  // must not depend on one. srvx is bundled for that reason.
  it("loads as CommonJS without require(esm)", () => {
    const status = node(
      "--no-experimental-require-module",
      "--eval",
      `const { VercelReceiver } = require("@vercel/slack-bolt");
       require("@vercel/slack-bolt/preview");
       ${PRINT_STATUS}`,
    );

    expect(status).toBe("404");
  });

  // Bolt is CommonJS, so its named imports only resolve if Node.js detects
  // them.
  it("loads as an ES module", () => {
    const status = node(
      "--input-type=module",
      "--eval",
      `import { VercelReceiver } from "@vercel/slack-bolt";
       import "@vercel/slack-bolt/preview";
       ${PRINT_STATUS}`,
    );

    expect(status).toBe("404");
  });

  it("runs the vercel-slack CLI", () => {
    expect(node("bin/vercel-slack.js", "--version")).toBe(version);
  });
});
