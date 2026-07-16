import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { type CommandSpec, plan } from "../internals/plan.js";
import {
  canonicalizeMethodologyIntent,
  exactSourceIdentity,
  hostAdapterFor,
  MethodologyFailureEnvelopeSchema,
  type MethodologyFinding,
  MethodologyIntentSchema,
  type MethodologyStatus,
  MethodologyStatusSchema,
  providerAdapterFor,
} from "./schema.js";

type MethodologyCommand = "inspect" | "project" | "status";

const METHODOLOGY_SUMMARIES: Record<MethodologyCommand, string> = {
  inspect: "Inspect a committed passive-methodology intent without reading provider content",
  project: "Report the Phase 1 dry-run projection block without writing",
  status: "Report bounded passive-methodology status without runtime claims",
};

const METHODOLOGY_COMMAND_NAMES = ["inspect", "project", "status"] as const;

/**
 * Canonical CLI registry entries. Dispatch deliberately bypasses `runCapability`
 * below so Phase 1 cannot create a run ledger or invoke the action executor.
 */
export const methodologyCommandSpecs: readonly CommandSpec[] = METHODOLOGY_COMMAND_NAMES.map(
  (name) => ({
    name,
    summary: METHODOLOGY_SUMMARIES[name],
    readOnly: true,
    plan: () => plan(`methodology ${name}`),
  }),
);

interface MethodologyCommandOptions {
  root?: string;
  intent: string;
  json: boolean;
}

interface MethodologyCommandDeps {
  write: (text: string) => void;
  writeError: (text: string) => void;
}

class MethodologyInputError extends Error {
  constructor(
    readonly code: "METHODOLOGY_INTENT_PATH_INVALID" | "METHODOLOGY_INTENT_UNREADABLE",
    message: string,
  ) {
    super(message);
  }
}

class MethodologyFailClosedError extends Error {
  constructor(
    readonly code: "METHODOLOGY_INTENT_MALFORMED",
    message: string,
  ) {
    super(message);
  }
}

/** Phase 1 has no mechanism capable of provider/host execution, network fetch, or writes. */
export const METHODOLOGY_PHASE_ONE_BOUNDARY = Object.freeze({
  providerExecution: false,
  providerFetch: false,
  hostExecution: false,
  writes: false,
});

const NO_RUNTIME_CLAIMS = Object.freeze({
  installed: false,
  active: false,
  isolated: false,
  switchable: false,
  concurrent: false,
  conflictFree: false,
});

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

/** Read only a contained regular intent file; symbolic links fail closed. */
function intentFile(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new MethodologyInputError(
      "METHODOLOGY_INTENT_PATH_INVALID",
      "intent must be a non-empty project-relative slash path",
    );
  }
  const rootPath = resolve(root);
  let rootInfo: ReturnType<typeof lstatSync>;
  try {
    rootInfo = lstatSync(rootPath);
  } catch {
    throw new MethodologyInputError("METHODOLOGY_INTENT_UNREADABLE", "target root is not readable");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new MethodologyFailClosedError(
      "METHODOLOGY_INTENT_MALFORMED",
      "target root must be a regular directory",
    );
  }

  let current = rootPath;
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      throw new MethodologyInputError(
        "METHODOLOGY_INTENT_UNREADABLE",
        "intent file is not readable",
      );
    }
    if (info.isSymbolicLink()) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent path must not contain symbolic links or reparse points",
      );
    }
    if (index === segments.length - 1 && (!info.isFile() || info.nlink !== 1)) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent must be an unlinked regular file",
      );
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent path must stay beneath regular directories",
      );
    }
  }
  return current;
}

function loadIntent(root: string, relative: string) {
  const path = intentFile(root, relative);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MethodologyFailClosedError(
      "METHODOLOGY_INTENT_MALFORMED",
      "intent must contain valid JSON",
    );
  }
  const parsed = MethodologyIntentSchema.safeParse(value);
  if (!parsed.success) {
    throw new MethodologyFailClosedError(
      "METHODOLOGY_INTENT_MALFORMED",
      "intent does not satisfy the Phase 1 exact identity schema",
    );
  }
  return canonicalizeMethodologyIntent(parsed.data);
}

function finding(
  code: MethodologyFinding["code"],
  disposition: MethodologyFinding["disposition"],
  detail: string,
): MethodologyFinding {
  return { code, disposition, detail };
}

function statusFor(command: MethodologyCommand, root: string, relative: string): MethodologyStatus {
  const intent = loadIntent(root, relative);
  const state = command === "project" ? "blocked" : command === "status" ? "advisory" : "selected";
  const findings =
    command === "project"
      ? [
          finding(
            "METHODOLOGY_PHASE_ONE_NO_PROJECTION",
            "blocked",
            "Phase 1 provides no projection planner or write path",
          ),
        ]
      : command === "status"
        ? [
            finding(
              "METHODOLOGY_HOST_ADVISORY",
              "advisory",
              "Phase 1 has no provider admission, projection, or host-discovery proof",
            ),
          ]
        : [];
  return MethodologyStatusSchema.parse({
    schemaVersion: 1,
    state,
    identity: exactSourceIdentity(intent),
    compatibility: intent.selection.compatibility,
    adapters: {
      provider: providerAdapterFor(intent),
      host: hostAdapterFor(intent),
    },
    claims: NO_RUNTIME_CLAIMS,
    findings,
  });
}

function writeJson(deps: MethodologyCommandDeps, value: unknown): void {
  deps.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeFailure(
  command: MethodologyCommand,
  exitCode: 1 | 3,
  code: MethodologyInputError["code"] | MethodologyFailClosedError["code"],
  message: string,
  options: MethodologyCommandOptions,
  deps: MethodologyCommandDeps,
): void {
  if (options.json) {
    const state = exitCode === 3 ? "fail-closed" : "invalid";
    writeJson(
      deps,
      MethodologyFailureEnvelopeSchema.parse({
        schemaVersion: 1,
        command,
        outcome: state,
        failure: {
          schemaVersion: 1,
          state,
          findings: [finding(code, exitCode === 3 ? "fail-closed" : "blocked", message)],
        },
        boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
      }),
    );
    return;
  }
  deps.writeError(`methodology ${command}: ${code}: ${message}\n`);
}

/** Run a Phase 1 command without using the action executor or any provider/host runtime. */
export function runMethodologyCommand(
  command: MethodologyCommand,
  options: MethodologyCommandOptions,
  deps: MethodologyCommandDeps = {
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  },
): number {
  try {
    const status = statusFor(command, options.root ?? process.cwd(), options.intent);
    const exitCode = command === "project" ? 2 : 0;
    const outcome = command === "project" ? "blocked" : "completed";
    if (options.json) {
      writeJson(deps, {
        schemaVersion: 1,
        command,
        outcome,
        status,
        boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
      });
    } else {
      deps.write(`methodology ${command}: ${status.state}\n`);
    }
    return exitCode;
  } catch (error) {
    if (error instanceof MethodologyInputError) {
      writeFailure(command, 1, error.code, error.message, options, deps);
      return 1;
    }
    if (error instanceof MethodologyFailClosedError) {
      writeFailure(command, 3, error.code, error.message, options, deps);
      return 3;
    }
    writeFailure(
      command,
      3,
      "METHODOLOGY_INTENT_MALFORMED",
      "unexpected Phase 1 methodology failure",
      options,
      deps,
    );
    return 3;
  }
}

export function registerMethodologyCommands(parent: Command): void {
  for (const spec of methodologyCommandSpecs) {
    const name = spec.name as MethodologyCommand;
    const command = parent
      .command(name)
      .description(spec.summary)
      .requiredOption("--intent <path>", "project-relative passive-methodology intent JSON")
      .option("--root <dir>", "target project root (defaults to cwd)")
      .option("--json", "emit the stable Phase 1 methodology envelope");
    command.action((options: MethodologyCommandOptions) => {
      process.exitCode = runMethodologyCommand(name, options);
    });
  }
}
