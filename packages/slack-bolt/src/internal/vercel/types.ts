export type AddEnvironmentVariablesResult = {
  created: Record<string, unknown> | Record<string, unknown>[];
  failed: { error: { code: string; message: string; key?: string } }[];
};
