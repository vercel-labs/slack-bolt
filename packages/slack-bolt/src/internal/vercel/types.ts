export type CreateProjectEnv = {
  key: string;
  value: string;
  type?: string;
  target?: string[];
  gitBranch?: string;
  comment?: string;
};

export type AddEnvironmentVariablesResult = {
  created: Record<string, unknown> | Record<string, unknown>[];
  failed: { error: { code: string; message: string; key?: string } }[];
};

export type EnvironmentVariable = {
  id: string;
  key: string;
  value?: string;
  target?: string[];
  gitBranch?: string;
  comment?: string;
  type?: string;
};
