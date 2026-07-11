import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import type { EccComponentId, EccMcpComponentId } from "./components.js";

const COMPONENT_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const ComponentIdSchema = z.string().min(3).max(160).regex(COMPONENT_ID);
const McpComponentIdSchema = ComponentIdSchema.refine((value) => value.startsWith("mcp:"), {
  message: "MCP component IDs must start with mcp:",
});

const AuthorizationSchema = z
  .object({
    componentId: ComponentIdSchema,
    source: z.string().min(1).max(240),
    pinnedSha: z.string().regex(SHA40),
    treeSha256: z.string().regex(SHA256),
    tier: z.enum(["vendor", "org"]),
    issuer: z.string().min(1).max(240),
    evidenceSha256: z.string().regex(SHA256),
  })
  .strict();

const ProjectRegistrationSchema = z
  .object({
    root: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value), "project root must be absolute"),
    scope: z.enum(["scoped", "full"]),
    components: z.array(ComponentIdSchema).max(4096),
    mcps: z.array(McpComponentIdSchema).max(128),
  })
  .strict()
  .superRefine((project, context) => {
    duplicateIssues(project.components, "component", context);
    duplicateIssues(project.mcps, "MCP component", context);
  });

const InstalledComponentSchema = z
  .object({
    id: ComponentIdSchema,
    authorization: AuthorizationSchema,
  })
  .strict();

const TargetRegistrationSchema = z
  .object({
    target: z.enum(SUPPORTED_CLIS),
    components: z.array(InstalledComponentSchema).max(4096),
    mcps: z.array(McpComponentIdSchema).max(128),
  })
  .strict()
  .superRefine((target, context) => {
    duplicateIssues(
      target.components.map((component) => component.id),
      "component",
      context,
    );
    duplicateIssues(target.mcps, "MCP component", context);
  });

const RegistrationLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(ProjectRegistrationSchema).max(4096),
    targets: z.array(TargetRegistrationSchema).max(SUPPORTED_CLIS.length),
  })
  .strict()
  .superRefine((ledger, context) => {
    duplicateIssues(
      ledger.projects.map((project) => project.root),
      "project root",
      context,
    );
    duplicateIssues(
      ledger.targets.map((target) => target.target),
      "target",
      context,
    );
  });

export interface ProjectRegistration {
  root: string;
  scope: "scoped" | "full";
  components: EccComponentId[];
  mcps: EccMcpComponentId[];
}

export interface InstalledComponentRegistration {
  id: EccComponentId;
  authorization: BaselineAuthorization;
}

export interface TargetRegistration {
  target: Cli;
  components: InstalledComponentRegistration[];
  mcps: EccMcpComponentId[];
}

export interface RegistrationLedger {
  schemaVersion: 1;
  projects: ProjectRegistration[];
  targets: TargetRegistration[];
}

export interface RegistrationUnion {
  components: EccComponentId[];
  mcps: EccMcpComponentId[];
}

export interface AtomicLedgerWriteDeps {
  rename?: (from: string, to: string) => void;
}

function duplicateIssues(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `duplicate ${label}: ${value}` });
    }
    seen.add(value);
  }
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeStoredProject(project: ProjectRegistration): ProjectRegistration {
  if (!isAbsolute(project.root)) throw new Error("project root must be absolute");
  return {
    root: resolve(project.root),
    scope: project.scope,
    components: uniqueSorted(project.components),
    mcps: uniqueSorted(project.mcps),
  };
}

function canonicalizeProjectContribution(project: ProjectRegistration): ProjectRegistration {
  const normalized = normalizeStoredProject(project);
  return { ...normalized, root: realpathSync(normalized.root) };
}

function normalizeTarget(target: TargetRegistration): TargetRegistration {
  const byId = new Map<string, InstalledComponentRegistration>();
  for (const component of target.components) byId.set(component.id, component);
  return {
    target: target.target,
    components: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    mcps: uniqueSorted(target.mcps),
  };
}

function normalizeLedger(ledger: RegistrationLedger): RegistrationLedger {
  return {
    schemaVersion: 1,
    projects: ledger.projects
      .map(normalizeStoredProject)
      .sort((left, right) => left.root.localeCompare(right.root)),
    targets: ledger.targets
      .map(normalizeTarget)
      .sort((left, right) => left.target.localeCompare(right.target)),
  };
}

export function emptyRegistrationLedger(): RegistrationLedger {
  return { schemaVersion: 1, projects: [], targets: [] };
}

export function parseRegistrationLedger(text: string): RegistrationLedger {
  try {
    const parsed = RegistrationLedgerSchema.parse(JSON.parse(text)) as RegistrationLedger;
    return normalizeLedger(parsed);
  } catch (error) {
    throw new Error(`invalid ECC registration ledger: ${(error as Error).message}`);
  }
}

export function machineRegistrationUnion(ledger: RegistrationLedger): RegistrationUnion {
  return {
    components: uniqueSorted(ledger.projects.flatMap((project) => project.components)),
    mcps: uniqueSorted(ledger.projects.flatMap((project) => project.mcps)),
  };
}

export function mergeRegistrationLedger(
  ledger: RegistrationLedger,
  project: ProjectRegistration,
  installedTargets: readonly TargetRegistration[],
): RegistrationLedger {
  const current = RegistrationLedgerSchema.parse(ledger) as RegistrationLedger;
  const normalizedProject = canonicalizeProjectContribution(project);
  const projects = current.projects.filter((entry) => entry.root !== normalizedProject.root);
  projects.push(normalizedProject);
  const replacedTargets = new Set(installedTargets.map((target) => target.target));
  const targets = current.targets.filter((target) => !replacedTargets.has(target.target));
  targets.push(...installedTargets.map(normalizeTarget));
  const merged = normalizeLedger({ schemaVersion: 1, projects, targets });
  return RegistrationLedgerSchema.parse(merged) as RegistrationLedger;
}

export function serializeRegistrationLedger(ledger: RegistrationLedger): string {
  const validated = RegistrationLedgerSchema.parse(ledger) as RegistrationLedger;
  return `${JSON.stringify(normalizeLedger(validated), null, 2)}\n`;
}

export function registrationLedgerPath(home: string): string {
  if (!isAbsolute(home)) throw new Error("ECC registration ledger home must be absolute");
  return join(home, ".aih", "ecc", "registration-ledger.json");
}

function assertExistingPathSafe(path: string, kind: "directory" | "file"): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`refusing symlinked ECC ledger path: ${path}`);
  if (kind === "directory" && !stats.isDirectory()) {
    throw new Error(`ECC ledger parent is not a directory: ${path}`);
  }
  if (kind === "file" && !stats.isFile())
    throw new Error(`ECC ledger is not a regular file: ${path}`);
}

function prepareLedgerDirectory(home: string): string {
  assertExistingPathSafe(home, "directory");
  let current = home;
  for (const segment of [".aih", "ecc"]) {
    current = join(current, segment);
    assertExistingPathSafe(current, "directory");
    if (!existsSync(current)) mkdirSync(current, { recursive: false, mode: 0o700 });
    assertExistingPathSafe(current, "directory");
  }
  return current;
}

export function readRegistrationLedger(home: string): RegistrationLedger {
  const path = registrationLedgerPath(home);
  assertExistingPathSafe(home, "directory");
  assertExistingPathSafe(join(home, ".aih"), "directory");
  assertExistingPathSafe(join(home, ".aih", "ecc"), "directory");
  if (!existsSync(path)) return emptyRegistrationLedger();
  assertExistingPathSafe(path, "file");
  const opened = readRegularFileWithStats(path);
  if (opened === undefined) throw new Error(`refusing unreadable ECC registration ledger: ${path}`);
  return parseRegistrationLedger(opened.contents.toString("utf8"));
}

export function writeRegistrationLedgerAtomic(
  home: string,
  ledger: RegistrationLedger,
  deps: AtomicLedgerWriteDeps = {},
): void {
  const contents = serializeRegistrationLedger(ledger);
  const directory = prepareLedgerDirectory(home);
  const path = registrationLedgerPath(home);
  assertExistingPathSafe(path, "file");
  const temporary = join(directory, `.registration-ledger.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    const rename =
      deps.rename ?? ((from: string, to: string) => retryTransient(() => renameSync(from, to)));
    rename(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
