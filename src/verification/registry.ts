import type { VerificationPass } from "./types.js";

const MAX_PASS_NAME_LENGTH = 4_096;

export interface VerificationRegistrySelection {
  names?: readonly string[];
  projectType?: string;
}

function assertPassName(name: string): void {
  if (name.trim() === "") throw new Error("verification pass name is required");
  if (name.length > MAX_PASS_NAME_LENGTH) {
    throw new Error(`verification pass name is too long: ${name.length}/${MAX_PASS_NAME_LENGTH}`);
  }
}

function isEnabledForProject(pass: VerificationPass, projectType: string | undefined): boolean {
  if (
    projectType === undefined ||
    pass.projectTypes === undefined ||
    pass.projectTypes.length === 0
  )
    return true;
  return pass.projectTypes.includes(projectType);
}

export class VerificationRegistry {
  readonly #passes = new Map<string, VerificationPass>();

  register(pass: VerificationPass): this {
    assertPassName(pass.name);
    if (this.#passes.has(pass.name))
      throw new Error(`verification pass already registered: ${pass.name}`);
    this.#passes.set(pass.name, pass);
    return this;
  }

  list(selection: Pick<VerificationRegistrySelection, "projectType"> = {}): VerificationPass[] {
    return [...this.#passes.values()].filter((pass) =>
      isEnabledForProject(pass, selection.projectType),
    );
  }

  select(selection: VerificationRegistrySelection = {}): VerificationPass[] {
    if (selection.names === undefined) return this.list(selection);
    return selection.names.map((name) => {
      assertPassName(name);
      const pass = this.#passes.get(name);
      if (pass === undefined) throw new Error(`verification pass is not registered: ${name}`);
      if (!isEnabledForProject(pass, selection.projectType)) {
        throw new Error(
          `verification pass is not enabled for project type ${selection.projectType}: ${name}`,
        );
      }
      return pass;
    });
  }
}
