import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { problem } from "./errors";

/**
 * A Slack app manifest: the fields this package reads or changes. Everything
 * else passes through untouched.
 */
export interface Manifest {
  display_information: {
    name: string;
    long_description?: string;
    [key: string]: unknown;
  };
  features?: {
    bot_user?: { display_name?: string; [key: string]: unknown };
    slash_commands?: { url?: string; [key: string]: unknown }[];
    code_channels?: { slash_command_url?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  oauth_config?: {
    redirect_urls?: string[];
    scopes?: { bot?: string[]; user?: string[] };
    [key: string]: unknown;
  };
  settings?: {
    event_subscriptions?: { request_url?: string; [key: string]: unknown };
    interactivity?: {
      request_url?: string;
      message_menu_options_url?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const DOCS = "https://docs.slack.dev/reference/app-manifest";

/** Where a manifest is looked for when nothing says where it is. */
const DEFAULT_FILES = ["manifest.json", "manifest.yaml", "manifest.yml"];

/** Slack's limits on an app's name, a bot's name and a long description. */
const MAX_APP_NAME = 35;
const MAX_BOT_NAME = 80;
const MAX_DESCRIPTION = 4000;

/** What a name keeps of its branch when both can't fit. */
const MIN_BRANCH_LABEL = 12;

const BYPASS_PARAM = "x-vercel-protection-bypass";

function check(value: unknown, from: string): Manifest {
  const info = (value as Manifest | null)?.display_information;
  if (
    typeof info !== "object" ||
    info === null ||
    typeof info.name !== "string" ||
    info.name.trim() === ""
  ) {
    throw problem(
      `${from} has no display_information.name`,
      `Slack requires one: ${DOCS}`,
    );
  }
  return value as Manifest;
}

/**
 * The app's manifest and where it came from: the object given, the file
 * given, or `manifest.json`, `manifest.yaml` or `manifest.yml` in `cwd`.
 * Files are read as YAML by a `.yaml` or `.yml` extension, as JSON otherwise.
 */
export function loadManifest(
  source: string | Manifest | undefined,
  cwd: string,
): { manifest: Manifest; from: string } {
  if (typeof source === "object") {
    return { manifest: check(source, "The manifest"), from: "the manifest" };
  }

  const from =
    source ??
    DEFAULT_FILES.find((file) => fs.existsSync(path.resolve(cwd, file)));
  if (!from) {
    throw problem(
      `No manifest.json in ${cwd}`,
      `Create one, or set MANIFEST_PATH to where yours is: ${DOCS}`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(cwd, from), "utf8");
  } catch (error) {
    throw problem(
      `Couldn't read the manifest at ${from}`,
      `Create it, or set MANIFEST_PATH to where yours is: ${DOCS}`,
      error,
    );
  }

  const yaml = /\.ya?ml$/i.test(from);
  let parsed: unknown;
  try {
    parsed = yaml ? parseYaml(raw) : JSON.parse(raw);
  } catch (error) {
    throw problem(
      `${from} isn't valid ${yaml ? "YAML" : "JSON"}`,
      "Fix the file, then redeploy.",
      error,
    );
  }
  return { manifest: check(parsed, from), from };
}

/**
 * A deployment's host, from a host or a URL.
 *
 * @throws When it's neither.
 */
export function hostOf(url: string): string {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(url)
    ? url
    : `https://${url}`;
  try {
    const { host } = new URL(withScheme);
    if (host) return host;
  } catch {
    // Falls through.
  }
  throw new Error(`${url} isn't a host or a URL`);
}

/**
 * What follows the host in a manifest URL: its path, query and fragment. A
 * placeholder like `<your-domain>/api/slack` isn't a URL, so this finds them
 * without parsing one.
 */
function afterHost(url: string): string {
  // `scheme://host/...`, or `//host/...`.
  const absolute = /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#]*(.*)$/is.exec(url);
  if (absolute) return absolute[1] ?? "";
  // A path on its own.
  if (url.startsWith("/")) return url;
  // `host/...`, without a scheme.
  const slash = url.search(/[/?#]/);
  return slash === -1 ? "" : url.slice(slash);
}

/**
 * Points a manifest URL at another host, keeping its path, query and
 * fragment. With a bypass secret, requests to it get through Deployment
 * Protection.
 */
export function toHost(
  original: string,
  host: string,
  bypassSecret?: string,
): string {
  const rest = afterHost(original);
  const from = new URL(
    `https://placeholder${rest.startsWith("/") ? "" : "/"}${rest}`,
  );
  // Set each part: resolving a path like `//x` against the host would read
  // it as another host.
  const url = new URL(`https://${host}`);
  url.pathname = from.pathname;
  url.search = from.search;
  url.hash = from.hash;
  if (bypassSecret) url.searchParams.set(BYPASS_PARAM, bypassSecret);
  return url.toString();
}

/**
 * The branch as part of a name. Slack rejects app names with characters like
 * `+`, `@` or `#`, and bot names with letters outside ASCII, so each run of
 * anything else becomes one `-`.
 */
export function branchLabel(branch: string): string {
  return (
    branch
      .replace(/^refs\/heads\//, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "preview"
  );
}

/**
 * `Name (branch)`, within `max` characters. When both don't fit the branch
 * is cut first, down to `MIN_BRANCH_LABEL` characters, then the name: the
 * branch is what tells one preview app from another.
 */
export function withBranch(name: string, label: string, max: number): string {
  const full = `${name} (${label})`;
  if (full.length <= max) return full;

  const decoration = " ()".length;
  const room = Math.max(
    max - name.length - decoration,
    Math.min(label.length, MIN_BRANCH_LABEL),
  );
  const short = label.slice(0, room).replace(/[-._]+$/, "");
  const kept = name.slice(0, max - short.length - decoration).trimEnd();
  return `${kept} (${short})`;
}

export interface Commit {
  sha?: string;
  message?: string;
  author?: string;
}

/**
 * A paragraph for the app's page in Slack, saying which deployment it's a
 * preview of. Always longer than the 175 characters Slack requires of a long
 * description.
 */
export function about(
  branch: string,
  host: string,
  commit: Commit = {},
): string {
  const sha = commit.sha?.slice(0, 7);
  const subject = commit.message?.split("\n")[0]?.trim().slice(0, 100);
  const running = sha
    ? ` It runs commit ${sha}${subject ? ` ("${subject}")` : ""}${commit.author ? ` by ${commit.author}` : ""}.`
    : "";
  return `This app is a preview of the ${branch} branch of its project, deployed on Vercel at https://${host}.${running} @vercel/slack-bolt created it for the branch, and updates it from the branch's manifest with every deployment.`;
}

export interface PreviewTarget {
  /** The host the branch's deployments are served from. */
  host: string;
  branch: string;
  /** Sent with Slack's requests, to get them through Deployment Protection. */
  bypassSecret?: string;
  commit?: Commit;
}

/**
 * The manifest of a branch's preview app: everything Slack calls and every
 * OAuth redirect goes to the branch's deployment, and the app and its bot
 * are named and described after the branch. The manifest given isn't changed.
 */
export function previewManifest(
  source: Manifest,
  { host, branch, bypassSecret, commit }: PreviewTarget,
): Manifest {
  const manifest = structuredClone(source);
  const called = (url: string) => toHost(url, host, bypassSecret);

  // Every URL Slack calls. One left on its original host would send a
  // preview app's requests to production.
  const events = manifest.settings?.event_subscriptions;
  if (events?.request_url) events.request_url = called(events.request_url);

  const interactivity = manifest.settings?.interactivity;
  if (interactivity?.request_url) {
    interactivity.request_url = called(interactivity.request_url);
  }
  if (interactivity?.message_menu_options_url) {
    interactivity.message_menu_options_url = called(
      interactivity.message_menu_options_url,
    );
  }

  for (const command of manifest.features?.slash_commands ?? []) {
    if (command.url) command.url = called(command.url);
  }

  const channels = manifest.features?.code_channels;
  if (channels?.slash_command_url) {
    channels.slash_command_url = called(channels.slash_command_url);
  }

  // A browser follows these, signed in to Vercel, so they carry no secret.
  if (manifest.oauth_config?.redirect_urls) {
    manifest.oauth_config.redirect_urls =
      manifest.oauth_config.redirect_urls.map((url) => toHost(url, host));
  }

  const label = branchLabel(branch);
  const info = manifest.display_information;
  info.name = withBranch(info.name.trim(), label, MAX_APP_NAME);

  const bot = manifest.features?.bot_user;
  if (bot?.display_name) {
    bot.display_name = withBranch(bot.display_name.trim(), label, MAX_BOT_NAME);
  }

  // The deployment's details matter most here, so a long description gives
  // way to them.
  const footer = about(branch, host, commit);
  const own = info.long_description?.trim();
  info.long_description = own
    ? `${own.slice(0, MAX_DESCRIPTION - footer.length - 2).trimEnd()}\n\n${footer}`
    : footer;

  return manifest;
}
