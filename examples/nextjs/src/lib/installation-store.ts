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

type StoredInstallation = Installation<"v1" | "v2", boolean>;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encrypt(text: string, secret: string): string {
  const key = scryptSync(secret, "slack-token-encryption", 32);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(encrypted: string, secret: string): string {
  const key = scryptSync(secret, "slack-token-encryption", 32);
  const [ivHex, tagHex, dataHex] = encrypted.split(":");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"), {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
}

function encryptTokens(installation: StoredInstallation): StoredInstallation {
  const secret = process.env.SLACK_STATE_SECRET;
  if (!secret) return installation;

  const copy = structuredClone(installation);
  if (copy.bot?.token) copy.bot.token = encrypt(copy.bot.token, secret);
  if (copy.bot?.refreshToken)
    copy.bot.refreshToken = encrypt(copy.bot.refreshToken, secret);
  if (copy.user.token) copy.user.token = encrypt(copy.user.token, secret);
  if (copy.user.refreshToken)
    copy.user.refreshToken = encrypt(copy.user.refreshToken, secret);
  return copy;
}

function decryptTokens(installation: StoredInstallation): StoredInstallation {
  const secret = process.env.SLACK_STATE_SECRET;
  if (!secret) return installation;

  const copy = structuredClone(installation);
  if (copy.bot?.token)
    copy.bot.token = decrypt(copy.bot.token, secret);
  if (copy.bot?.refreshToken)
    copy.bot.refreshToken = decrypt(copy.bot.refreshToken, secret);
  if (copy.user.token)
    copy.user.token = decrypt(copy.user.token, secret);
  if (copy.user.refreshToken)
    copy.user.refreshToken = decrypt(copy.user.refreshToken, secret);
  return copy;
}

function teamKey(query: {
  teamId?: string;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
}): string {
  if (query.isEnterpriseInstall && query.enterpriseId) {
    return `slack:installation:enterprise:${query.enterpriseId}`;
  }
  if (query.teamId) {
    return `slack:installation:${query.teamId}`;
  }
  throw new Error("Either teamId or enterpriseId is required");
}

function userKey(base: string, userId: string): string {
  return `${base}:${userId}`;
}

async function upsert(key: string, incoming: StoredInstallation) {
  const existing = await redis.get<StoredInstallation>(key);
  const merged = existing ? { ...existing, ...incoming } : incoming;
  await redis.set(key, merged);
}

export const installationStore: InstallationStore = {
  storeInstallation: async (installation) => {
    const tk = teamKey({
      teamId: installation.team?.id,
      enterpriseId: installation.enterprise?.id,
      isEnterpriseInstall: installation.isEnterpriseInstall,
    });

    const encrypted = encryptTokens(
      installation as unknown as StoredInstallation,
    );

    await upsert(tk, encrypted);

    if (installation.user?.id) {
      await upsert(userKey(tk, installation.user.id), encrypted);
    }
  },

  fetchInstallation: async (query: InstallationQuery<boolean>) => {
    const tk = teamKey(query);

    if (query.userId) {
      const data = await redis.get<StoredInstallation>(userKey(tk, query.userId));
      if (data) return decryptTokens(data);
    }

    const data = await redis.get<StoredInstallation>(tk);
    if (!data) {
      throw new Error(`No installation found for ${tk}`);
    }
    return decryptTokens(data);
  },

  deleteInstallation: async (query: InstallationQuery<boolean>) => {
    const tk = teamKey(query);

    if (query.userId) {
      await redis.del(userKey(tk, query.userId));
      return;
    }

    const userKeys = await redis.keys(`${tk}:*`);
    if (userKeys.length > 0) {
      await redis.del(...userKeys);
    }
    await redis.del(tk);
  },
};
