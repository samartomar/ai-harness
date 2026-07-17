import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { parse, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { type CommandSpec, plan } from "../internals/plan.js";
import {
  canonicalizeMethodologyIntent,
  exactSourceIdentity,
  hostAdapterFor,
  MethodologyCommandEnvelopeSchema,
  MethodologyFailureEnvelopeSchema,
  type MethodologyFinding,
  MethodologyIntentSchema,
  type MethodologyStatus,
  MethodologyStatusSchema,
  providerAdapterFor,
} from "./schema.js";

export type MethodologyCommand = "inspect" | "project" | "status";

const METHODOLOGY_SUMMARIES: Record<MethodologyCommand, string> = {
  inspect: "Inspect a committed passive-methodology intent without reading provider content",
  project: "Report the Phase 1 dry-run projection block without writing",
  status: "Report bounded passive-methodology status without runtime claims",
};

const METHODOLOGY_COMMAND_NAMES = ["inspect", "project", "status"] as const;
const MAX_INTENT_INPUT_BYTES = 64 * 1024;
const MAX_INTENT_RELATIVE_PATH_LENGTH = 240;
const MAX_ROOT_PATH_LENGTH = 4096;

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
    value.length <= MAX_INTENT_RELATIVE_PATH_LENGTH &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
}

interface VerifiedIntentFile {
  descriptor: number;
  file: FileIdentity;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function fileIdentity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size };
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // A descriptor that cannot be closed is never reused as authority.
  }
}

function assertRegularDirectory(info: Stats): void {
  if (!info.isDirectory()) {
    throw new MethodologyFailClosedError(
      "METHODOLOGY_INTENT_MALFORMED",
      "intent root and ancestors must be regular directories without links or reparse points",
    );
  }
}

function openError(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "ENOENT" || code === "EACCES") {
    throw new MethodologyInputError("METHODOLOGY_INTENT_UNREADABLE", "intent file is not readable");
  }
  throw new MethodologyFailClosedError(
    "METHODOLOGY_INTENT_MALFORMED",
    "intent cannot be opened without following a link or reparse point",
  );
}

function openDescriptor(path: string, flags: number): number {
  try {
    return openSync(path, flags);
  } catch (error) {
    return openError(error);
  }
}

function descriptorPath(descriptor: number, segment: string): string {
  return `/proc/self/fd/${descriptor}/${segment}`;
}

/**
 * Linux descriptor-relative traversal keeps each subsequent lookup beneath an
 * already-open parent. Node does not expose an equivalent atomic primitive for
 * other platforms, so Phase 1 refuses their filesystem input rather than race
 * a pathname check and read.
 */
function openVerifiedIntentFile(root: string, relativeIntent: string): VerifiedIntentFile {
  if (!isSafeRelativePath(relativeIntent)) {
    throw new MethodologyInputError(
      "METHODOLOGY_INTENT_PATH_INVALID",
      "intent must be a non-empty project-relative slash path",
    );
  }
  if (root.length === 0 || root.length > MAX_ROOT_PATH_LENGTH) {
    throw new MethodologyInputError("METHODOLOGY_INTENT_PATH_INVALID", "target root is invalid");
  }
  if (process.platform !== "linux") {
    throw new MethodologyFailClosedError(
      "METHODOLOGY_INTENT_MALFORMED",
      "Phase 1 intent reads require Linux descriptor-relative no-follow semantics",
    );
  }
  const rootPath = resolve(root);
  const parsed = parse(rootPath);
  const rootSegments = relative(parsed.root, rootPath).split(sep).filter(Boolean);
  if (rootSegments.some((segment) => segment === "..")) {
    throw new MethodologyInputError("METHODOLOGY_INTENT_PATH_INVALID", "target root is invalid");
  }
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parent: number | undefined;
  let descriptor: number | undefined;
  try {
    parent = openDescriptor(parsed.root, directoryFlags);
    assertRegularDirectory(fstatSync(parent));
    for (const segment of [...rootSegments, ...relativeIntent.split("/").slice(0, -1)]) {
      const next = openDescriptor(descriptorPath(parent, segment), directoryFlags);
      try {
        assertRegularDirectory(fstatSync(next));
      } catch (error) {
        closeQuietly(next);
        throw error;
      }
      closeQuietly(parent);
      parent = next;
    }
    const leaf = relativeIntent.split("/").at(-1);
    if (leaf === undefined) {
      throw new MethodologyFailClosedError("METHODOLOGY_INTENT_MALFORMED", "intent is invalid");
    }
    descriptor = openDescriptor(
      descriptorPath(parent, leaf),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      closeQuietly(descriptor);
      descriptor = undefined;
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent must be an unlinked regular file",
      );
    }
    if (info.size > MAX_INTENT_INPUT_BYTES) {
      closeQuietly(descriptor);
      descriptor = undefined;
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent exceeds the Phase 1 byte limit",
      );
    }
    const verified = { descriptor, file: fileIdentity(info) };
    descriptor = undefined;
    return verified;
  } catch (error) {
    if (error instanceof MethodologyInputError || error instanceof MethodologyFailClosedError) {
      throw error;
    }
    throw new MethodologyFailClosedError("METHODOLOGY_INTENT_MALFORMED", "intent is not readable");
  } finally {
    closeQuietly(parent);
    closeQuietly(descriptor);
  }
}

/** Read exact bounded bytes through the verified descriptor, then revalidate its identity. */
function readVerifiedIntentFile(verified: VerifiedIntentFile): string {
  try {
    const before = fstatSync(verified.descriptor);
    if (!before.isFile() || !sameFileIdentity(verified.file, fileIdentity(before))) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent identity changed before reading",
      );
    }
    const bytes = Buffer.alloc(verified.file.size);
    if (readSync(verified.descriptor, bytes, 0, bytes.length, null) !== bytes.length) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent changed while reading",
      );
    }
    const after = fstatSync(verified.descriptor);
    if (!after.isFile() || !sameFileIdentity(verified.file, fileIdentity(after))) {
      throw new MethodologyFailClosedError(
        "METHODOLOGY_INTENT_MALFORMED",
        "intent identity changed while reading",
      );
    }
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof MethodologyInputError || error instanceof MethodologyFailClosedError) {
      throw error;
    }
    throw new MethodologyFailClosedError("METHODOLOGY_INTENT_MALFORMED", "intent is not readable");
  } finally {
    closeQuietly(verified.descriptor);
  }
}

function loadIntent(root: string, relativeIntent: string) {
  const verified = openVerifiedIntentFile(root, relativeIntent);
  let value: unknown;
  try {
    value = JSON.parse(readVerifiedIntentFile(verified));
  } catch (error) {
    if (error instanceof MethodologyInputError || error instanceof MethodologyFailClosedError) {
      throw error;
    }
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
  command: MethodologyCommand | null,
  exitCode: 1 | 3,
  code:
    | MethodologyInputError["code"]
    | MethodologyFailClosedError["code"]
    | "METHODOLOGY_COMMAND_INVALID",
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
      writeJson(
        deps,
        MethodologyCommandEnvelopeSchema.parse({
          schemaVersion: 1,
          command,
          outcome,
          status,
          boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
        }),
      );
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

function methodologyCommandFromArgv(argv: readonly string[]): MethodologyCommand | null {
  if (argv[2] !== "methodology") return null;
  const candidate = argv[3];
  return METHODOLOGY_COMMAND_NAMES.includes(candidate as MethodologyCommand)
    ? (candidate as MethodologyCommand)
    : null;
}

function isMethodologyJsonInvocation(argv: readonly string[]): boolean {
  return argv[2] === "methodology" && argv.slice(3).includes("--json");
}

/** Render parser failures before Commander can bypass the closed Phase 1 JSON contract. */
export function writeMethodologyParserFailure(
  argv: readonly string[],
  deps: MethodologyCommandDeps = {
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  },
): boolean {
  if (!isMethodologyJsonInvocation(argv)) return false;
  writeJson(
    deps,
    MethodologyFailureEnvelopeSchema.parse({
      schemaVersion: 1,
      command: methodologyCommandFromArgv(argv),
      outcome: "invalid",
      failure: {
        schemaVersion: 1,
        state: "invalid",
        findings: [
          finding(
            "METHODOLOGY_COMMAND_INVALID",
            "blocked",
            "methodology command arguments are invalid",
          ),
        ],
      },
      boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
    }),
  );
  return true;
}

export function registerMethodologyCommands(parent: Command): void {
  parent.exitOverride();
  parent.configureOutput({
    writeOut: (text) => {
      if (!isMethodologyJsonInvocation(process.argv)) process.stdout.write(text);
    },
    writeErr: (text) => {
      if (!isMethodologyJsonInvocation(process.argv)) process.stderr.write(text);
    },
  });
  for (const spec of methodologyCommandSpecs) {
    const name = spec.name as MethodologyCommand;
    const command = parent
      .command(name)
      .description(spec.summary)
      .requiredOption("--intent <path>", "project-relative passive-methodology intent JSON")
      .option("--root <dir>", "target project root (defaults to cwd)")
      .option("--json", "emit the stable Phase 1 methodology envelope");
    command.exitOverride();
    command.configureOutput({
      writeOut: (text) => {
        if (!isMethodologyJsonInvocation(process.argv)) process.stdout.write(text);
      },
      writeErr: (text) => {
        if (!isMethodologyJsonInvocation(process.argv)) process.stderr.write(text);
      },
    });
    command.action((options: MethodologyCommandOptions) => {
      process.exitCode = runMethodologyCommand(name, options);
    });
  }
}
