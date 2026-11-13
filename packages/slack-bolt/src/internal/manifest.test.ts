import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  about,
  branchLabel,
  hostOf,
  loadManifest,
  type Manifest,
  previewManifest,
  toHost,
  withBranch,
} from "./manifest";

const HOST = "app-git-x.vercel.app";

describe("toHost", () => {
  it.each([
    ["https://acme.com/api/slack", "/api/slack"],
    ["https://acme.com", "/"],
    ["https://acme.com/a/b?c=1&d=2#e", "/a/b?c=1&d=2#e"],
    ["http://localhost:3000/api/slack", "/api/slack"],
    ["//acme.com/api/slack", "/api/slack"],
    // What a template leaves for its user to fill in.
    ["<your-domain>/api/slack/events", "/api/slack/events"],
    ["https://<your-domain>/api/slack", "/api/slack"],
    ["acme.com/api/slack?x=1", "/api/slack?x=1"],
    ["acme.com?x=1", "/?x=1"],
    ["/api/slack", "/api/slack"],
    // Not another host.
    ["https://acme.com//evil.com/x", "//evil.com/x"],
    ["", "/"],
  ])("points %s at the host, keeping %s", (original, rest) => {
    expect(toHost(original, HOST)).toBe(`https://${HOST}${rest}`);
  });

  it("adds the bypass secret, in place of one that's there", () => {
    expect(toHost("https://acme.com/a?b=1", HOST, "s3cret")).toBe(
      `https://${HOST}/a?b=1&x-vercel-protection-bypass=s3cret`,
    );
    expect(
      toHost(
        "https://acme.com/a?x-vercel-protection-bypass=old&b=1",
        HOST,
        "new",
      ),
    ).toBe(`https://${HOST}/a?x-vercel-protection-bypass=new&b=1`);
  });
});

describe("hostOf", () => {
  it.each([
    ["app.vercel.app", "app.vercel.app"],
    ["https://app.vercel.app/path?q=1", "app.vercel.app"],
    ["http://localhost:3000", "localhost:3000"],
  ])("reads %s as %s", (url, host) => {
    expect(hostOf(url)).toBe(host);
  });

  it("refuses what isn't a host", () => {
    expect(() => hostOf("https://")).toThrow("https:// isn't a host or a URL");
  });
});

describe("branchLabel", () => {
  it.each([
    ["feature/login", "feature-login"],
    ["refs/heads/main", "main"],
    ["user@fix#1+2", "user-fix-1-2"],
    [
      "dependabot/npm_and_yarn/lodash-4.17.21",
      "dependabot-npm_and_yarn-lodash-4.17.21",
    ],
    ["a//b", "a-b"],
    ["-odd-/", "odd"],
    ["機能/ログイン", "preview"],
  ])("makes %s into %s", (branch, label) => {
    expect(branchLabel(branch)).toBe(label);
  });
});

describe("withBranch", () => {
  it("puts the branch after the name", () => {
    expect(withBranch("Acme", "feature-login", 35)).toBe(
      "Acme (feature-login)",
    );
  });

  it("cuts a branch that doesn't fit, and not at a separator", () => {
    const name = withBranch("Acme Support", "feature-checkout-redesign", 35);

    expect(name).toBe("Acme Support (feature-checkout-red)");
    expect(name).toHaveLength(35);
    // Twenty characters of this one end in a dash.
    expect(withBranch("Acme Support", "feature-checkout-re-design", 35)).toBe(
      "Acme Support (feature-checkout-re)",
    );
  });

  it("cuts the name too, before the branch is too short to tell apps apart", () => {
    const name = withBranch(
      "Acme Customer Support Assistant",
      "feature-checkout-redesign",
      35,
    );

    expect(name).toBe("Acme Customer Suppor (feature-chec)");
    expect(name).toHaveLength(35);
  });

  it("never goes over the limit", () => {
    for (const name of [
      "A",
      "Acme",
      "A".repeat(34),
      "A".repeat(35),
      "A".repeat(60),
    ]) {
      for (const label of ["x", "feature-login", "b".repeat(40)]) {
        expect(withBranch(name, label, 35).length).toBeLessThanOrEqual(35);
        expect(withBranch(name, label, 35)).toMatch(/ \(.+\)$/);
      }
    }
  });
});

describe("about", () => {
  it("is always long enough to be a long description", () => {
    expect(about("x", "a.co").length).toBeGreaterThanOrEqual(175);
  });

  it("says which commit runs, by its first line", () => {
    const text = about("feature/login", HOST, {
      sha: "a1b2c3d4e5f6",
      message: `Add login\n\n${"Details. ".repeat(40)}`,
      author: "octocat",
    });

    expect(text).toContain(
      `the feature/login branch of its project, deployed on Vercel at https://${HOST}. It runs commit a1b2c3d ("Add login") by octocat.`,
    );
    expect(
      about("x", HOST, { sha: "a1b2c3d4", message: "m".repeat(300) }),
    ).toContain(`("${"m".repeat(100)}")`);
    expect(about("x", HOST, { message: "No SHA" })).not.toContain("No SHA");
  });
});

describe("previewManifest", () => {
  const source: Manifest = {
    _metadata: { major_version: 2 },
    display_information: { name: "Acme", background_color: "#000000" },
    features: {
      bot_user: { display_name: "Acme Bot", always_online: true },
      slash_commands: [
        { command: "/one", url: "https://acme.com/one" },
        { command: "/socket" },
      ],
      code_channels: { slash_command_url: "https://acme.com/agent" },
    },
    oauth_config: {
      redirect_urls: ["https://acme.com/oauth", "https://acme.com/other"],
      scopes: { bot: ["commands"] },
    },
    settings: {
      event_subscriptions: {
        request_url: "https://acme.com/events",
        bot_events: ["app_mention"],
      },
      interactivity: {
        is_enabled: true,
        request_url: "https://acme.com/actions",
        message_menu_options_url: "https://acme.com/options",
      },
    },
  };
  const target = {
    host: HOST,
    branch: "feature/login",
    bypassSecret: "s3cret",
  };
  const called = (path: string) =>
    `https://${HOST}${path}?x-vercel-protection-bypass=s3cret`;

  it("sends everything Slack calls to the branch's deployment, with the bypass secret", () => {
    const manifest = previewManifest(source, target);

    expect(manifest.settings?.event_subscriptions?.request_url).toBe(
      called("/events"),
    );
    expect(manifest.settings?.interactivity).toEqual({
      is_enabled: true,
      request_url: called("/actions"),
      message_menu_options_url: called("/options"),
    });
    expect(manifest.features?.slash_commands).toEqual([
      { command: "/one", url: called("/one") },
      { command: "/socket" },
    ]);
    expect(manifest.features?.code_channels?.slash_command_url).toBe(
      called("/agent"),
    );
  });

  it("sends OAuth redirects there too, without the secret", () => {
    expect(previewManifest(source, target).oauth_config?.redirect_urls).toEqual(
      [`https://${HOST}/oauth`, `https://${HOST}/other`],
    );
  });

  it("names the app and its bot after the branch, and leaves the rest alone", () => {
    const manifest = previewManifest(source, target);

    expect(manifest.display_information.name).toBe("Acme (feature-login)");
    expect(manifest.features?.bot_user).toEqual({
      display_name: "Acme Bot (feature-login)",
      always_online: true,
    });
    expect(manifest._metadata).toEqual({ major_version: 2 });
    expect(manifest.display_information.background_color).toBe("#000000");
    expect(manifest.settings?.event_subscriptions?.bot_events).toEqual([
      "app_mention",
    ]);
    expect(manifest.oauth_config?.scopes).toEqual({ bot: ["commands"] });
  });

  it("doesn't change the manifest it was given", () => {
    const before = structuredClone(source);

    previewManifest(source, target);

    expect(source).toEqual(before);
  });

  it("gives an app without a bot, URLs or a secret nothing it didn't have", () => {
    const manifest = previewManifest(
      { display_information: { name: "  Bare  " } },
      { host: HOST, branch: "main" },
    );

    expect(Object.keys(manifest)).toEqual(["display_information"]);
    expect(manifest.display_information.name).toBe("Bare (main)");
    expect(manifest.display_information.long_description).toBe(
      about("main", HOST),
    );
  });

  it("says which deployment it is after the app's own description", () => {
    const own = "What Acme does. ".repeat(20).trim();
    const commit = { sha: "a1b2c3d4" };

    const manifest = previewManifest(
      { display_information: { name: "Acme", long_description: own } },
      { ...target, commit },
    );

    expect(manifest.display_information.long_description).toBe(
      `${own}\n\n${about("feature/login", HOST, commit)}`,
    );
  });

  it("cuts the app's own description to stay within Slack's 4000 characters", () => {
    const manifest = previewManifest(
      {
        display_information: {
          name: "Acme",
          long_description: "x".repeat(5000),
        },
      },
      target,
    );
    const description = manifest.display_information.long_description ?? "";

    expect(description).toHaveLength(4000);
    expect(description.endsWith(about("feature/login", HOST))).toBe(true);
  });

  it("keeps names within Slack's limits", () => {
    const manifest = previewManifest(
      {
        display_information: { name: "N".repeat(50) },
        features: { bot_user: { display_name: "B".repeat(100) } },
      },
      { host: HOST, branch: "b".repeat(100) },
    );

    expect(manifest.display_information.name).toHaveLength(35);
    expect(manifest.features?.bot_user?.display_name).toHaveLength(80);
  });
});

describe("loadManifest", () => {
  let dir: string;
  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(dir, file), content);
  const named = (name: string) =>
    JSON.stringify({ display_information: { name } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vercel-slack-manifest-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("takes a manifest as it is", () => {
    const manifest = { display_information: { name: "Given" } };

    expect(loadManifest(manifest, dir)).toEqual({
      manifest,
      from: "the manifest",
    });
  });

  it("finds manifest.json, then .yaml, then .yml", () => {
    write("manifest.yml", "display_information:\n  name: yml\n");
    expect(loadManifest(undefined, dir).from).toBe("manifest.yml");

    write("manifest.yaml", "display_information:\n  name: yaml\n");
    expect(loadManifest(undefined, dir).manifest.display_information.name).toBe(
      "yaml",
    );

    write("manifest.json", named("json"));
    expect(loadManifest(undefined, dir)).toEqual({
      manifest: { display_information: { name: "json" } },
      from: "manifest.json",
    });
  });

  it("reads a path from the working directory, or an absolute one", () => {
    fs.mkdirSync(path.join(dir, "slack"));
    write("slack/app.json", named("nested"));

    expect(
      loadManifest("slack/app.json", dir).manifest.display_information.name,
    ).toBe("nested");
    expect(
      loadManifest(path.join(dir, "slack/app.json"), "/elsewhere").from,
    ).toBe(path.join(dir, "slack/app.json"));
  });

  it.each([
    [
      "no manifest",
      undefined,
      () => {},
      /^No manifest\.json in .+\nCreate one, or set MANIFEST_PATH/,
    ],
    [
      "a path with no file",
      "nope.json",
      () => {},
      /^Couldn't read the manifest at nope\.json\n/,
    ],
    [
      "JSON that doesn't parse",
      "manifest.json",
      () => write("manifest.json", "{"),
      /^manifest\.json isn't valid JSON\nFix the file/,
    ],
    [
      "YAML that doesn't parse",
      "m.yaml",
      () => write("m.yaml", "a: [1"),
      /^m\.yaml isn't valid YAML\n/,
    ],
    [
      "a manifest without a name",
      "manifest.json",
      () => write("manifest.json", "{}"),
      /^manifest\.json has no display_information\.name\nSlack requires one/,
    ],
    [
      "a blank name",
      "manifest.json",
      () => write("manifest.json", named("  ")),
      /has no display_information\.name/,
    ],
    [
      "something that isn't a manifest",
      "manifest.json",
      () => write("manifest.json", "null"),
      /has no display_information\.name/,
    ],
  ])("refuses %s", (_, source, setup, message) => {
    setup();

    expect(() => loadManifest(source, dir)).toThrow(message);
  });
});
