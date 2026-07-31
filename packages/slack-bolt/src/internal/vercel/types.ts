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

/**
 * Response of GET /v5/projects/{idOrName}/branches.
 *
 * Unlike most Vercel list endpoints (which return a `pagination` object),
 * this endpoint returns a top-level `until` cursor. When `until` is present,
 * more pages exist and it must be passed as the `until` query parameter of
 * the next request. When it is absent, the last page has been reached.
 */
export type ListBranchesResponse = {
  branches?: { branch: string }[];
  until?: string | number;
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
