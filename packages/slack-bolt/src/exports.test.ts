// The package's public surface, by entry point. v1's `createHandler` is gone,
// and nothing else should appear here without a deliberate change to this list.
import { describe, expect, it } from "vitest";

describe("public exports", () => {
  it("exports only VercelReceiver from the main entry", async () => {
    expect(Object.keys(await import("./index"))).toEqual(["VercelReceiver"]);
  });

  it("exports only preview and cleanup from ./preview", async () => {
    expect(Object.keys(await import("./preview")).sort()).toEqual([
      "cleanup",
      "preview",
    ]);
  });
});
