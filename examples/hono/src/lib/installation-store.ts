import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type {
  Installation,
  InstallationQuery,
  InstallationStore,
} from "@slack/bolt";
import { redis } from "./redis.js";

// Each workspace (or Enterprise Grid org) is one Redis hash: the `workspace`
// field holds the installation with its bot token, and a `user:<id>` field
// holds the user token of each user who authorized user scopes. Both are
// encrypted with TOKEN_ENCRYPTION_SECRET and bound to their key and field, so
// one copied to another workspace or user doesn't decrypt. Keys include the
// Slack app's client ID, so apps sharing one Redis, like a development and a
// production app, don't overwrite each other's installations.

let key: Buffer | undefined;
function encryptionKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_SECRET is required for secure token storage",
    );
  }
  key ??= scryptSync(secret, "slack-token-encryption", 32);
  return key;
}

function encrypt(value: unknown, hashKey: string, field: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(`${hashKey}\n${field}`));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("hex"))
    .join(":");
}

function decrypt<T>(value: string, hashKey: string, field: string): T {
  const [iv, tag, data] = value
    .split(":")
    .map((hex) => Buffer.from(hex, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(`${hashKey}\n${field}`));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
  );
}

function workspaceKey(query: {
  teamId?: string;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
}): string {
  const prefix = `slack:${process.env.HONO_SLACK_CLIENT_ID}:workspace`;
  if (query.isEnterpriseInstall && query.enterpriseId) {
    return `${prefix}:enterprise:${query.enterpriseId}`;
  }
  if (query.teamId) return `${prefix}:${query.teamId}`;
  throw new Error("Either teamId or enterpriseId is required");
}

type User = Installation["user"];

// fetchInstallation puts the requesting user in `user` so Bolt gets their
// token, and tags the result with the workspace's installer. Bolt saves a
// refresh as a copy of that result, tag included, so storeInstallation keeps
// the installer instead of recording whoever triggered the refresh.
const INSTALLER = Symbol("installer");
type Fetched = Installation & { [INSTALLER]?: string };

export const installationStore: InstallationStore = {
  // Bolt also calls this to save refreshed tokens, with what
  // fetchInstallation returned.
  storeInstallation: async (installation) => {
    const key = workspaceKey({
      teamId: installation.team?.id,
      enterpriseId: installation.enterprise?.id,
      isEnterpriseInstall: installation.isEnterpriseInstall,
    });
    const { user } = installation;
    const installer = (installation as Fetched)[INSTALLER] ?? user.id;
    const workspace = encrypt(
      { ...installation, user: { id: installer } },
      key,
      "workspace",
    );
    // One atomic request, so the workspace and user token are saved together.
    const tx = redis.multi();
    if (installation.bot) {
      tx.hset(key, { workspace });
    } else {
      // A user-only authorization has no bot, so don't replace a workspace
      // that has one; only save it if it's the first.
      tx.hsetnx(key, "workspace", workspace);
    }
    if (user.token) {
      const field = `user:${user.id}`;
      tx.hset(key, { [field]: encrypt(user, key, field) });
    }
    await tx.exec();
  },

  fetchInstallation: async (query: InstallationQuery<boolean>) => {
    const key = workspaceKey(query);
    const userField = query.userId ? `user:${query.userId}` : undefined;
    const fields = await redis.hmget<Record<string, string | null>>(
      key,
      "workspace",
      ...(userField ? [userField] : []),
    );
    const workspace = fields?.workspace;
    const user = userField ? fields?.[userField] : undefined;
    if (!workspace) throw new Error(`No installation found for ${key}`);
    const installation = decrypt<Installation<"v1" | "v2", boolean>>(
      workspace,
      key,
      "workspace",
    );
    // Only the user who authorized gets a user token. Unlike Slack's
    // FileInstallationStore, a lookup with no user, like a bot message event,
    // doesn't get the installer's token, so no event acts as someone it isn't.
    if (!userField || !user) return installation;
    const fetched: Fetched = {
      ...installation,
      user: decrypt<User>(user, key, userField),
      [INSTALLER]: installation.user.id,
    };
    return fetched;
  },

  deleteInstallation: async (query: InstallationQuery<boolean>) => {
    const key = workspaceKey(query);
    if (query.userId) await redis.hdel(key, `user:${query.userId}`);
    else await redis.del(key);
  },
};
