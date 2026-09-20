/**
 * What a host supplies to the component UI. A capability describes an
 * operation the host can perform. It never says an imported policy is trusted:
 * every policy goes through the engine whatever its origin.
 */
export interface WorkbenchHostCapabilities {
  /** The host bound the launch folder to an org policy and put it in the model. */
  readonly boundPolicy: boolean;
  /** The explicit GitHub skill intake. Only the CLI host's admin page has it. */
  readonly githubIntake: boolean;
}

export type WorkbenchRoute = "admin" | "user";

/**
 * Where the route lives is the host's decision: the CLI host keeps its request
 * token in the fragment, so it routes in the query instead.
 */
export interface WorkbenchNavigation {
  current(): WorkbenchRoute;
  go(route: WorkbenchRoute): void;
  subscribe(listener: () => void): () => void;
  href(route: WorkbenchRoute): string;
}

export interface WorkbenchFile {
  readonly name: string;
  readonly text: string;
}

/**
 * Lane E (row 18): the one connected operation of this delivery. The CLI host
 * implements it against the local server's existing routes, with its request
 * token; no other host has it. A result is UNTRUSTED data: the engine judges
 * it (`checkConnectedSkillPin`) before anything is pinned.
 */
export interface WorkbenchGithubSkillHost {
  /** Ask the local server to pin one Skill's exact commit and SKILL.md path. */
  resolve(request: { readonly repository: string; readonly skill: string }): Promise<unknown>;
  /**
   * Ask the local server to prepare the pending Skill against the current
   * draft policy. It answers by re-rendering the page, so nothing returns.
   */
  prepare(request: {
    readonly policy: unknown;
    readonly source: {
      readonly repository: string;
      readonly skill: string;
      readonly commit: string;
      readonly path: string;
    };
  }): Promise<unknown>;
}

export interface WorkbenchHost {
  readonly capabilities: WorkbenchHostCapabilities;
  /** Present exactly when `capabilities.githubIntake` is true. */
  readonly githubSkill?: WorkbenchGithubSkillHost;
  readonly navigation: WorkbenchNavigation;
  /** SHA-256, lower-case hex, of exactly these bytes. Never of re-serialized JSON. */
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  /** Hand a finished file to the person. */
  save(file: WorkbenchFile): void;
  /**
   * Put text on the clipboard. False on any failure or absence: the page then
   * reports the failure and never claims a copy.
   */
  copyText(text: string): Promise<boolean>;
}
