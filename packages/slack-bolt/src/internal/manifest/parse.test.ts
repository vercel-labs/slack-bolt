import { describe, expect, it } from "vitest";
import { parseManifest, stringifyManifest } from "./parse";
import type { Manifest } from "./types";

const sampleManifest: Manifest = {
  display_information: {
    name: "TestApp",
    description: "A test app",
  },
  settings: {
    event_subscriptions: {
      request_url: "https://example.com/api/slack/events",
    },
  },
  oauth_config: {
    scopes: {
      bot: ["chat:write"],
    },
  },
};

const sampleJson = JSON.stringify(sampleManifest, null, 2);

const sampleYaml = `display_information:
  name: TestApp
  description: A test app
settings:
  event_subscriptions:
    request_url: https://example.com/api/slack/events
oauth_config:
  scopes:
    bot:
      - "chat:write"
`;

describe("parseManifest", () => {
  it("should parse a JSON manifest when path ends with .json", () => {
    const result = parseManifest(sampleJson, "manifest.json");

    expect(result.display_information.name).toBe("TestApp");
    expect(result.settings?.event_subscriptions?.request_url).toBe(
      "https://example.com/api/slack/events",
    );
  });

  it("should parse a YAML manifest when path ends with .yaml", () => {
    const result = parseManifest(sampleYaml, "manifest.yaml");

    expect(result.display_information.name).toBe("TestApp");
    expect(result.settings?.event_subscriptions?.request_url).toBe(
      "https://example.com/api/slack/events",
    );
  });

  it("should parse a YAML manifest when path ends with .yml", () => {
    const result = parseManifest(sampleYaml, "manifest.yml");

    expect(result.display_information.name).toBe("TestApp");
    expect(result.oauth_config?.scopes?.bot).toEqual(["chat:write"]);
  });

  it("should be case-insensitive for file extensions", () => {
    const result = parseManifest(sampleYaml, "manifest.YAML");

    expect(result.display_information.name).toBe("TestApp");
  });

  it("should handle nested directory paths", () => {
    const result = parseManifest(sampleYaml, "config/slack/manifest.yaml");

    expect(result.display_information.name).toBe("TestApp");
  });

  it("should fall back to JSON for unknown extensions", () => {
    const result = parseManifest(sampleJson, "manifest.txt");

    expect(result.display_information.name).toBe("TestApp");
  });
});

describe("stringifyManifest", () => {
  it("should produce valid JSON when path ends with .json", () => {
    const output = stringifyManifest(sampleManifest, "manifest.json");
    const parsed = JSON.parse(output);

    expect(parsed.display_information.name).toBe("TestApp");
  });

  it("should produce indented JSON with 2-space indent", () => {
    const output = stringifyManifest(sampleManifest, "manifest.json");

    expect(output).toBe(JSON.stringify(sampleManifest, null, 2));
  });

  it("should produce valid YAML when path ends with .yaml", () => {
    const output = stringifyManifest(sampleManifest, "manifest.yaml");

    expect(output).toContain("display_information:");
    expect(output).toContain("name: TestApp");
    expect(output).not.toContain("{");
  });

  it("should produce valid YAML when path ends with .yml", () => {
    const output = stringifyManifest(sampleManifest, "manifest.yml");

    expect(output).toContain("display_information:");
    expect(output).toContain("name: TestApp");
  });

  it("should round-trip JSON correctly", () => {
    const json = stringifyManifest(sampleManifest, "manifest.json");
    const roundTripped = parseManifest(json, "manifest.json");

    expect(roundTripped).toEqual(sampleManifest);
  });

  it("should round-trip YAML correctly", () => {
    const yaml = stringifyManifest(sampleManifest, "manifest.yaml");
    const roundTripped = parseManifest(yaml, "manifest.yaml");

    expect(roundTripped).toEqual(sampleManifest);
  });
});
