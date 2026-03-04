import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { describe, expect, it } from "vitest";
import { createNewManifest, rewriteUrl } from "./index";

describe("rewriteUrl", () => {
  it("should replace the host while preserving the path", () => {
    const result = rewriteUrl(
      "https://old-host.com/api/slack/events",
      "new-branch.vercel.app",
    );

    expect(result).toBe("https://new-branch.vercel.app/api/slack/events");
  });

  it("should preserve existing query parameters", () => {
    const result = rewriteUrl(
      "https://old-host.com/api/events?foo=bar&baz=qux",
      "branch.vercel.app",
    );

    const url = new URL(result);
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("baz")).toBe("qux");
  });

  it("should add bypass secret as a query parameter", () => {
    const result = rewriteUrl(
      "https://old-host.com/api/events",
      "branch.vercel.app",
      "abc123",
    );

    const url = new URL(result);
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe("abc123");
  });

  it("should not add bypass param when secret is omitted", () => {
    const result = rewriteUrl(
      "https://old-host.com/api/events",
      "branch.vercel.app",
    );

    const url = new URL(result);
    expect(url.searchParams.has("x-vercel-protection-bypass")).toBe(false);
  });

  it("should default to '/' path when original URL has no path", () => {
    const result = rewriteUrl("https://old-host.com", "branch.vercel.app");

    expect(new URL(result).pathname).toBe("/");
  });

  it("should merge bypass secret with existing query params", () => {
    const result = rewriteUrl(
      "https://old-host.com/api?existing=yes",
      "branch.vercel.app",
      "secret",
    );

    const url = new URL(result);
    expect(url.searchParams.get("existing")).toBe("yes");
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe("secret");
  });

  it("should handle URL with port number in the original host", () => {
    const result = rewriteUrl(
      "https://old-host.com:8080/api/events",
      "branch.vercel.app",
    );

    const url = new URL(result);
    expect(url.hostname).toBe("branch.vercel.app");
    expect(url.pathname).toBe("/api/events");
  });

  it("should handle URL with hash fragment by preserving path extraction", () => {
    const result = rewriteUrl(
      "https://old-host.com/callback#section",
      "branch.vercel.app",
    );

    const url = new URL(result);
    expect(url.hostname).toBe("branch.vercel.app");
    expect(url.pathname).toBe("/callback");
  });

  it("should produce a valid URL when branchUrl has no subdomain", () => {
    const result = rewriteUrl("https://old-host.com/api", "localhost");

    expect(() => new URL(result)).not.toThrow();
    expect(new URL(result).hostname).toBe("localhost");
  });
});

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    display_information: {
      name: "TestApp",
      long_description: "A test app",
    },
    settings: {
      event_subscriptions: {
        request_url: "https://prod.example.com/api/slack/events",
      },
      interactivity: {
        is_enabled: true,
        request_url: "https://prod.example.com/api/slack/interact",
      },
    },
    features: {
      bot_user: {
        display_name: "TestBot",
        always_online: true,
      },
      slash_commands: [
        {
          command: "/test",
          url: "https://prod.example.com/api/slack/commands",
          description: "Test",
        },
      ],
    },
    oauth_config: {
      redirect_urls: ["https://prod.example.com/api/slack/oauth"],
    },
    ...overrides,
  } as Manifest;
}

const defaultParams = {
  branchUrl: "my-branch.vercel.app",
  bypassSecret: "bypass123",
  branch: "feat/cool-feature",
  commitSha: "abcdef1234567890",
  commitMessage: "fix the thing",
  commitAuthor: "alice",
};

describe("createNewManifest", () => {
  it("should not mutate the original manifest", () => {
    const original = baseManifest();
    const originalUrl = original.settings!.event_subscriptions!.request_url;

    createNewManifest({ originalManifest: original, ...defaultParams });

    expect(original.settings!.event_subscriptions!.request_url).toBe(
      originalUrl,
    );
  });

  describe("URL rewriting", () => {
    it("should rewrite the event subscriptions URL with bypass secret", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
      });

      const url = new URL(result.settings!.event_subscriptions!.request_url!);
      expect(url.hostname).toBe("my-branch.vercel.app");
      expect(url.pathname).toBe("/api/slack/events");
      expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
        "bypass123",
      );
    });

    it("should rewrite the interactivity URL with bypass secret", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
      });

      const url = new URL(result.settings!.interactivity!.request_url!);
      expect(url.hostname).toBe("my-branch.vercel.app");
      expect(url.pathname).toBe("/api/slack/interact");
      expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
        "bypass123",
      );
    });

    it("should rewrite slash command URLs with bypass secret", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
      });

      const url = new URL(result.features!.slash_commands![0].url!);
      expect(url.hostname).toBe("my-branch.vercel.app");
      expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(
        "bypass123",
      );
    });

    it("should rewrite redirect URLs without bypass secret", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
      });

      const url = new URL(result.oauth_config!.redirect_urls![0]);
      expect(url.hostname).toBe("my-branch.vercel.app");
      expect(url.searchParams.has("x-vercel-protection-bypass")).toBe(false);
    });

    it("should rewrite all slash commands when there are multiple", () => {
      const manifest = baseManifest({
        features: {
          bot_user: { display_name: "TestBot", always_online: true },
          slash_commands: [
            {
              command: "/a",
              url: "https://prod.example.com/a",
              description: "A",
            },
            {
              command: "/b",
              url: "https://prod.example.com/b",
              description: "B",
            },
          ],
        },
      } as Partial<Manifest>);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      for (const cmd of result.features!.slash_commands!) {
        expect(new URL(cmd.url!).hostname).toBe("my-branch.vercel.app");
      }
    });

    it("should skip slash commands that have no url", () => {
      const manifest = baseManifest({
        features: {
          bot_user: { display_name: "TestBot", always_online: true },
          slash_commands: [
            { command: "/no-url", description: "No URL" },
            {
              command: "/has-url",
              url: "https://prod.example.com/cmd",
              description: "Has URL",
            },
          ],
        },
      } as Partial<Manifest>);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      expect(result.features!.slash_commands![0].url).toBeUndefined();
      expect(new URL(result.features!.slash_commands![1].url!).hostname).toBe(
        "my-branch.vercel.app",
      );
    });
  });

  describe("graceful handling of missing optional fields", () => {
    it("should handle manifest with no settings", () => {
      const manifest = baseManifest({ settings: undefined });

      expect(() =>
        createNewManifest({ originalManifest: manifest, ...defaultParams }),
      ).not.toThrow();
    });

    it("should handle manifest with no slash commands", () => {
      const manifest = baseManifest({
        features: {
          bot_user: { display_name: "TestBot", always_online: true },
        },
      } as Partial<Manifest>);

      expect(() =>
        createNewManifest({ originalManifest: manifest, ...defaultParams }),
      ).not.toThrow();
    });

    it("should handle manifest with no oauth redirect URLs", () => {
      const manifest = baseManifest({ oauth_config: undefined });

      expect(() =>
        createNewManifest({ originalManifest: manifest, ...defaultParams }),
      ).not.toThrow();
    });

    it("should handle manifest with no bot_user", () => {
      const manifest = baseManifest({
        features: {
          slash_commands: [
            {
              command: "/test",
              url: "https://prod.example.com/cmd",
              description: "Test",
            },
          ],
        },
      } as Partial<Manifest>);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      expect(result.features?.bot_user).toBeUndefined();
    });
  });

  describe("display name", () => {
    it("should append cleaned branch name to bot_user display_name", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        branch: "main",
      });

      expect(result.display_information.name).toBe("TestBot (main)");
      expect(result.features!.bot_user!.display_name).toBe("TestBot (main)");
    });

    it("should strip refs/heads/ prefix from branch name", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        branch: "refs/heads/main",
      });

      expect(result.display_information.name).toBe("TestBot (main)");
    });

    it("should replace slashes with dashes in branch name", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        branch: "feat/nested/branch",
      });

      expect(result.display_information.name).toContain("feat-nested-branch");
    });

    it("should truncate display name to 35 characters while keeping bracket format", () => {
      const manifest = baseManifest();
      (manifest.features!.bot_user as { display_name: string }).display_name =
        "VeryLongAppName";

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
        branch: "a-really-long-branch-name-that-exceeds",
      });

      expect(result.display_information.name.length).toBeLessThanOrEqual(35);
      expect(result.display_information.name).toMatch(
        /^VeryLongAppName \(.+\)$/,
      );
    });

    it("should hard-truncate when app name alone leaves no room for branch", () => {
      const manifest = baseManifest();
      const longName = "A".repeat(33);
      (manifest.features!.bot_user as { display_name: string }).display_name =
        longName;

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
        branch: "main",
      });

      expect(result.display_information.name.length).toBeLessThanOrEqual(35);
    });

    it("should fall back to display_information.name when bot_user is absent", () => {
      const manifest = baseManifest({
        features: {},
      } as Partial<Manifest>);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
        branch: "main",
      });

      expect(result.display_information.name).toBe("TestApp (main)");
    });

    it("should produce exactly 35 characters when name + branch fills the limit", () => {
      const manifest = baseManifest();
      // "App (branch-name-exactly-fills-it)" = exactly 35 chars
      (manifest.features!.bot_user as { display_name: string }).display_name =
        "App";

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
        branch: "branch-name-exactly-fills-it-yes",
      });

      expect(result.display_information.name.length).toBeLessThanOrEqual(35);
      expect(result.display_information.name).toMatch(/^App \(.+\)$/);
    });

    it("should handle branch name with special characters (dots, underscores, @)", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        branch: "user@fix_bug.v2",
      });

      expect(result.display_information.name).toContain("user@fix_bug.v2");
    });

    it("should keep display_information.name and bot_user.display_name in sync", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        branch: "main",
      });

      expect(result.display_information.name).toBe(
        result.features!.bot_user!.display_name,
      );
    });
  });

  describe("long description", () => {
    it("should append deployment info to existing description", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
      });

      const desc = result.display_information.long_description!;
      expect(desc).toContain("A test app");
      expect(desc).toContain("my-branch.vercel.app");
      expect(desc).toContain("feat/cool-feature");
      expect(desc).toContain("abcdef1");
      expect(desc).toContain("fix the thing");
      expect(desc).toContain("alice");
      expect(desc).toContain("Automatically created by ▲ Vercel");
    });

    it("should truncate commit SHA to 7 characters", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        commitSha: "abcdef1234567890",
      });

      const desc = result.display_information.long_description!;
      expect(desc).toContain("abcdef1");
      expect(desc).not.toContain("abcdef12");
    });

    it("should use 'unknown' for sha when commitSha is omitted", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        commitSha: undefined,
      });

      expect(result.display_information.long_description).toContain(
        "*Commit:* unknown",
      );
    });

    it("should use 'unknown' when commitAuthor is omitted", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        commitAuthor: undefined,
      });

      expect(result.display_information.long_description).toMatch(
        /Last updated by.*unknown/,
      );
    });

    it("should handle missing long_description in original manifest", () => {
      const manifest = baseManifest();
      manifest.display_information.long_description = undefined;

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      const desc = result.display_information.long_description!;
      expect(desc).toContain("Automatically created by ▲ Vercel");
      expect(desc).toContain("my-branch.vercel.app");
    });

    it("should cap long description at 4000 characters", () => {
      const manifest = baseManifest();
      manifest.display_information.long_description = "x".repeat(4000);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      expect(
        result.display_information.long_description!.length,
      ).toBeLessThanOrEqual(4000);
    });

    it("should still include deployment info when existing description is very long", () => {
      const manifest = baseManifest();
      manifest.display_information.long_description = "x".repeat(3900);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      const desc = result.display_information.long_description!;
      expect(desc.length).toBeLessThanOrEqual(4000);
      expect(desc).toContain("Automatically created by ▲ Vercel");
    });

    it("should produce exactly 4000 chars when combined length would exceed the limit", () => {
      const manifest = baseManifest();
      manifest.display_information.long_description = "y".repeat(3980);

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      expect(result.display_information.long_description!.length).toBe(4000);
    });

    it("should not truncate when combined length is under 4000", () => {
      const manifest = baseManifest();
      manifest.display_information.long_description = "short";

      const result = createNewManifest({
        originalManifest: manifest,
        ...defaultParams,
      });

      const desc = result.display_information.long_description!;
      expect(desc).toMatch(/^short/);
      expect(desc).toContain("Automatically created by ▲ Vercel");
      expect(desc.length).toBeLessThan(4000);
    });

    it("should use empty string when commitMessage is omitted", () => {
      const result = createNewManifest({
        originalManifest: baseManifest(),
        ...defaultParams,
        commitMessage: undefined,
      });

      const desc = result.display_information.long_description!;
      expect(desc).toMatch(/\*Commit:\* abcdef1 \n/);
    });
  });
});
