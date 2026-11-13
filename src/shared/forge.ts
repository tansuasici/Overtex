// What the GitLab and Gitea clients share. No vscode import.

/** A failed call to a Git server's API, with the HTTP status and a message the person can act on. */
export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface CreatedProject {
  /** owner/name (or namespace/name) */
  path: string;
  sshUrl: string;
  httpUrl: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect?: 'error' }
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;
