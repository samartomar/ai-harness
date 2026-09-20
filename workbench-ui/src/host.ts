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

export interface WorkbenchFile {
  readonly name: string;
  readonly text: string;
}

export interface WorkbenchHost {
  readonly capabilities: WorkbenchHostCapabilities;
  /** SHA-256, lower-case hex, of exactly these bytes. Never of re-serialized JSON. */
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  /** Hand a finished file to the person. */
  save(file: WorkbenchFile): void;
}
