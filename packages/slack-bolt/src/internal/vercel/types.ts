export type AddEnvironmentVariablesResult = {
  created: Record<string, unknown> | Record<string, unknown>[];
  failed: { error: { code: string; message: string; key?: string } }[];
};

export type GetAuthUserResult = {
  user: {
    id: string;
    email: string;
    name: string | null;
    username: string;
    avatar: string | null;
    defaultTeamId: string | null;
    limited?: true;
  };
};
