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
import { redis } from "./redis";

// Each workspace (or Enterprise Grid org) is one Redis hash: the `workspace`
// field holds the installation with its bot token, and a `user:<id>` field
// holds the user token of each user who authorized user scopes. Both are
// encrypted with TOKEN_ENCRYPTION_SECRET.

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

function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("hex"))
    .join(":");
}

function decrypt<T>(value: string): T {
  const [iv, tag, data] = value
    .split(":")
    .map((hex) => Buffer.from(hex, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
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
  if (query.isEnterpriseInstall && query.enterpriseId) {
    return `slack:workspace:enterprise:${query.enterpriseId}`;
  }
  if (query.teamId) return `slack:workspace:${query.teamId}`;
  throw new Error("Either teamId or enterpriseId is required");
}

type User = Installation["user"];

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
    const workspace = encrypt({ ...installation, user: { id: user.id } });
    if (installation.bot) {
      await redis.hset(key, { workspace });
    } else {
      // A user-only authorization has no bot, so don't replace a workspace
      // that has one; only save it if it's the first.
      await redis.hsetnx(key, "workspace", workspace);
    }
    if (user.token) {
      await redis.hset(key, { [`user:${user.id}`]: encrypt(user) });
    }
  },

  fetchInstallation: async (query: InstallationQuery<boolean>) => {
    const key = workspaceKey(query);
    const userField = `user:${query.userId}`;
    const fields = await redis.hmget<Record<string, string | null>>(
      key,
      "workspace",
      userField,
    );
    const workspace = fields?.workspace;
    const user = query.userId ? fields?.[userField] : undefined;
    if (!workspace) throw new Error(`No installation found for ${key}`);
    const installation = decrypt<Installation<"v1" | "v2", boolean>>(workspace);
    // Only the user who authorized gets a user token.
    return user ? { ...installation, user: decrypt<User>(user) } : installation;
  },

  deleteInstallation: async (query: InstallationQuery<boolean>) => {
    const key = workspaceKey(query);
    if (query.userId) await redis.hdel(key, `user:${query.userId}`);
    else await redis.del(key);
  },
};
