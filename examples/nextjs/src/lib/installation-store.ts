import type {
  Installation,
  InstallationQuery,
  InstallationStore,
} from "@slack/bolt";
import { redis } from "./redis";

type StoredInstallation = Installation<"v1" | "v2", boolean>;

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

async function upsert(key: string, incoming: Record<string, unknown>) {
  const existing = await redis.get(key);
  const merged = existing ? { ...JSON.parse(existing), ...incoming } : incoming;
  await redis.set(key, JSON.stringify(merged));
}

export const installationStore: InstallationStore = {
  storeInstallation: async (installation) => {
    const tk = teamKey({
      teamId: installation.team?.id,
      enterpriseId: installation.enterprise?.id,
      isEnterpriseInstall: installation.isEnterpriseInstall,
    });

    // Team-level: upsert so bot credentials are always current
    await upsert(tk, installation as unknown as Record<string, unknown>);

    // User-level: upsert so each user's token/scopes are preserved independently
    if (installation.user?.id) {
      await upsert(
        userKey(tk, installation.user.id),
        installation as unknown as Record<string, unknown>,
      );
    }
  },

  fetchInstallation: async (query: InstallationQuery<boolean>) => {
    const tk = teamKey(query);

    if (query.userId) {
      const data = await redis.get(userKey(tk, query.userId));
      if (data) return JSON.parse(data) as StoredInstallation;
    }

    const data = await redis.get(tk);
    if (!data) {
      throw new Error(`No installation found for ${tk}`);
    }
    return JSON.parse(data) as StoredInstallation;
  },

  deleteInstallation: async (query: InstallationQuery<boolean>) => {
    const tk = teamKey(query);

    if (query.userId) {
      await redis.del(userKey(tk, query.userId));
      return;
    }

    // Deleting a team-level installation: remove all user keys too
    const pattern = `${tk}:*`;
    const userKeys = await redis.keys(pattern);
    if (userKeys.length > 0) {
      await redis.del(...userKeys);
    }
    await redis.del(tk);
  },
};
