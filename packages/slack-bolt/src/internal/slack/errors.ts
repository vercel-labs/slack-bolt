type ManifestProblem = { message: string; pointer: string };

/** Slack answered a Web API call with `ok: false`. */
export class SlackAPIError extends Error {
  constructor(
    /** The method that failed, like `apps.manifest.update`. */
    public method: string,
    /** Slack's error code, like `invalid_manifest`. */
    public code: string,
    /** Each problem Slack found in a manifest, and where it is. */
    public errors?: ManifestProblem[],
  ) {
    super(`Slack's ${method} failed: ${code}`);
  }
}

export class SlackManifestCreateError extends SlackAPIError {
  constructor(code: string, errors?: ManifestProblem[]) {
    super("apps.manifest.create", code, errors);
  }
}

export class SlackManifestUpdateError extends SlackAPIError {
  constructor(code: string, errors?: ManifestProblem[]) {
    super("apps.manifest.update", code, errors);
  }
}

export class SlackManifestExportError extends SlackAPIError {
  constructor(code: string) {
    super("apps.manifest.export", code);
  }
}
