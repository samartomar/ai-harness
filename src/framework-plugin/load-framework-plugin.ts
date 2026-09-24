import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type CatalogFrameworkPluginIdentitiesLoadV1,
  loadFrameworkPluginIdentitiesV1,
} from "../catalog-package/framework-plugins.js";
import { catalogPackageRefusalMessage } from "../catalog-package/load-catalog-package.js";
import { AihError } from "../errors.js";
import { FRAMEWORK_HOST_API_VERSION } from "../framework-host/index.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { allowedPluginRoots, sanitizeLabel } from "../plugins/registry.js";
import {
  FRAMEWORK_PLUGIN_COMMANDS,
  FRAMEWORK_PLUGIN_CONTRACT_VERSION,
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkIdV1,
  type FrameworkPluginDescriptionV1,
  type FrameworkPluginPackageNameV1,
  type FrameworkPluginV1,
  frameworkDescriptorSubpathV1,
} from "./contract-v1.js";

/**
 * The one place Core loads a framework plugin (C3).
 *
 * `@aihq/framework-ecc` and `@aihq/framework-superpowers` are optional peers
 * of `@aihq/core`, imported ONLY here and ONLY by their literal specifiers, so
 * nothing user-controlled can point the import at other code. Before importing,
 * the installed package must resolve inside Core's own install tree and carry
 * its own `package.json`, and the real path of the module file that literal
 * import loads (its `exports` "import" entry) must lie inside that package's
 * own real directory, so no link can make Core execute code from elsewhere.
 * After importing, its `aihFrameworkPluginV1` export
 * must implement contract 1 against this Core's host API, name the installed
 * package and version, and implement every command Core dispatches to it. When
 * Catalog is installed, the installed version must also equal Catalog's plugin
 * identity record (Catalog describes; it never authorizes).
 *
 * `framework-plugin-unavailable` means exactly one thing: the package is not
 * installed. Everything else is `framework-plugin-incompatible`, which callers
 * surface as a refusal. There is no embedded fallback.
 *
 * Unlike the enterprise command registry there is no environment kill switch:
 * a framework plugin is imported only when its own command runs, the refusal
 * vocabulary is closed, and an organization disables a framework by policy.
 */

export const FRAMEWORK_PLUGIN_DEFAULT_TIMEOUT_MS = 10_000;

export type FrameworkPluginRefusalReasonV1 =
  | "framework-plugin-unavailable"
  | "framework-plugin-incompatible";

export interface FrameworkPluginRefusalV1 {
  readonly reason: FrameworkPluginRefusalReasonV1;
  readonly frameworkId: FrameworkIdV1;
  readonly packageName: FrameworkPluginPackageNameV1;
  /** One actionable paragraph naming the install command; bounded and control-free. */
  readonly detail: string;
}

/** How the loaded plugin compares with the installed Catalog's identity record. */
export type FrameworkPluginCatalogIdentityV1 =
  | { readonly state: "catalog-not-installed" }
  | {
      readonly state: "matched";
      readonly catalogVersion: string | undefined;
      readonly sha256: string;
    };

export type FrameworkPluginLoadV1 =
  | {
      readonly ok: true;
      readonly frameworkId: FrameworkIdV1;
      readonly packageName: FrameworkPluginPackageNameV1;
      readonly version: string;
      /** Real path of the installed package root. */
      readonly root: string;
      readonly plugin: FrameworkPluginV1;
      readonly description: FrameworkPluginDescriptionV1;
      readonly catalogIdentity: FrameworkPluginCatalogIdentityV1;
    }
  | { readonly ok: false; readonly refusal: FrameworkPluginRefusalV1 };

/** Test seam: how the installed package is reached. Production always uses the installed peers. */
export interface FrameworkPluginAccessV1 {
  /** Import the plugin package by its literal specifier. */
  readonly importPlugin: (frameworkId: FrameworkIdV1) => Promise<unknown>;
  /** Resolve `<package>/package.json` through the package's `exports` to an absolute path. */
  readonly resolvePackageJson: (frameworkId: FrameworkIdV1) => string;
  /** Resolve the module file the literal import loads (the package's "import" entry) to an absolute path. */
  readonly resolveEntry: (frameworkId: FrameworkIdV1) => string;
  readonly readFile: (path: string) => Uint8Array;
  readonly realpath: (path: string) => string;
  /** Real directories the plugin must resolve under: Core's own install tree. */
  readonly allowedRoots: () => readonly string[];
  readonly loadCatalogIdentities: () => Promise<CatalogFrameworkPluginIdentitiesLoadV1>;
}

export interface FrameworkPluginLoadOptionsV1 {
  readonly access?: FrameworkPluginAccessV1;
  /** Import budget in milliseconds (default {@link FRAMEWORK_PLUGIN_DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}

function importInstalledPlugin(frameworkId: FrameworkIdV1): Promise<unknown> {
  switch (frameworkId) {
    case "ecc":
      return import("@aihq/framework-ecc");
    case "superpowers":
      return import("@aihq/framework-superpowers");
  }
}

/** The same resolver, from the same module, as the literal import above. */
function resolveInstalledEntry(frameworkId: FrameworkIdV1): string {
  switch (frameworkId) {
    case "ecc":
      return fileURLToPath(import.meta.resolve("@aihq/framework-ecc"));
    case "superpowers":
      return fileURLToPath(import.meta.resolve("@aihq/framework-superpowers"));
  }
}

const requireFromCore = createRequire(import.meta.url);

const installedPluginAccess: FrameworkPluginAccessV1 = {
  importPlugin: importInstalledPlugin,
  resolvePackageJson: (frameworkId) =>
    requireFromCore.resolve(`${FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId]}/package.json`),
  resolveEntry: resolveInstalledEntry,
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync(path),
  allowedRoots: allowedPluginRoots,
  loadCatalogIdentities: () => loadFrameworkPluginIdentitiesV1(),
};

export function frameworkPluginInstallCommand(frameworkId: FrameworkIdV1): string {
  return `npm install -g @aihq/core ${FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId]}`;
}

export function frameworkPluginProjectInstallCommand(frameworkId: FrameworkIdV1): string {
  return `npm install @aihq/core ${FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId]}`;
}

function installAdvice(frameworkId: FrameworkIdV1): string {
  return `Install it with: ${frameworkPluginInstallCommand(frameworkId)} (in a project: ${frameworkPluginProjectInstallCommand(frameworkId)}).`;
}

function messageOf(error: unknown): string {
  return sanitizeLabel(error instanceof Error ? error.message : String(error), 240);
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function refusal(
  frameworkId: FrameworkIdV1,
  reason: FrameworkPluginRefusalReasonV1,
  detail: string,
): { readonly ok: false; readonly refusal: FrameworkPluginRefusalV1 } {
  return {
    ok: false,
    refusal: Object.freeze({
      reason,
      frameworkId,
      packageName: FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId],
      detail,
    }),
  };
}

function incompatible(frameworkId: FrameworkIdV1, problem: string) {
  const name = FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId];
  return refusal(
    frameworkId,
    "framework-plugin-incompatible",
    `the installed ${name} ${problem}; this @aihq/core needs a ${name} that implements framework plugin contract ${FRAMEWORK_PLUGIN_CONTRACT_VERSION} against framework host API ${FRAMEWORK_HOST_API_VERSION}. ${installAdvice(frameworkId)}`,
  );
}

/** Only a package that is genuinely absent is unavailable; anything else is installed but broken. */
function isAbsent(error: unknown, name: string): boolean {
  const code = codeOf(error);
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`'${name}/package.json'`) || message.includes(`'${name}'`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(sanitizeLabel(value, 60));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined ? "missing" : typeof value;
}

const TIMED_OUT = Symbol("framework-plugin-import-timed-out");

async function importWithTimeout(
  load: () => Promise<unknown>,
  timeoutMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<typeof TIMED_OUT>((resolveExpiry) => {
      timer = setTimeout(() => resolveExpiry(TIMED_OUT), timeoutMs);
    });
    const pending = Promise.resolve().then(load);
    // A rejection arriving after the budget expired must not become unhandled.
    pending.catch(() => {});
    return await Promise.race([pending, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function functionMember(record: Record<string, unknown>, name: string): boolean {
  return typeof record[name] === "function";
}

/** Structural problems with the export, in reading order. Reading may throw (getters); callers catch. */
function contractProblems(
  frameworkId: FrameworkIdV1,
  version: string,
  candidate: unknown,
): string[] {
  if (!isRecord(candidate)) return ["does not export aihFrameworkPluginV1 as an object"];
  const problems: string[] = [];
  if (candidate.contractVersion !== FRAMEWORK_PLUGIN_CONTRACT_VERSION) {
    problems.push(`declares contract version ${show(candidate.contractVersion)}`);
  }
  if (candidate.hostApiVersion !== FRAMEWORK_HOST_API_VERSION) {
    problems.push(`was built against framework host API ${show(candidate.hostApiVersion)}`);
  }
  if (candidate.frameworkId !== frameworkId) {
    problems.push(`declares framework ${show(candidate.frameworkId)}`);
  }
  if (candidate.packageName !== FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId]) {
    problems.push(`declares package name ${show(candidate.packageName)}`);
  }
  if (candidate.packageVersion !== version) {
    problems.push(
      `declares version ${show(candidate.packageVersion)} but its package.json is ${version}`,
    );
  }
  for (const name of ["describe", "identifyComponents", "hookInventory", "planHookControls"]) {
    if (!functionMember(candidate, name)) problems.push(`does not implement ${name}()`);
  }
  const commands = candidate.commands;
  for (const path of FRAMEWORK_PLUGIN_COMMANDS[frameworkId]) {
    const command = isRecord(commands) ? commands[path] : undefined;
    if (!isRecord(command) || !functionMember(command, "execute")) {
      problems.push(`does not implement the "${path}" command`);
    }
  }
  const hooks: ReadonlyArray<readonly [string, string]> = [
    ["policyDelivery", "prepare"],
    ["uninstall", "remove"],
    ["prune", "plan"],
    ["doctor", "checks"],
    ["report", "panels"],
  ];
  for (const [hook, member] of hooks) {
    const value = candidate[hook];
    if (value !== undefined && (!isRecord(value) || !functionMember(value, member))) {
      problems.push(`provides an incomplete ${hook} hook`);
    }
  }
  if (candidate.receipts !== undefined) {
    const receipts = candidate.receipts;
    const valid =
      Array.isArray(receipts) &&
      receipts.every(
        (receipt) =>
          isRecord(receipt) && typeof receipt.id === "string" && typeof receipt.path === "string",
      );
    if (!valid) problems.push("declares malformed receipts");
  }
  return problems;
}

const PORTABLE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,240}$/;

const DescriptionSchema = z
  .object({
    frameworkId: z.string(),
    displayName: z.string().min(1).max(80),
    upstream: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    supportedHosts: z
      .array(z.enum(SUPPORTED_CLIS))
      .min(1)
      .refine((hosts) => new Set(hosts).size === hosts.length, "duplicate host"),
    catalogSubpath: z.string(),
    descriptorSections: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)).max(32),
    environment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(16),
    ownedArtifacts: z
      .array(
        z
          .object({
            host: z.enum(SUPPORTED_CLIS),
            path: z.string().regex(PORTABLE_RELATIVE_PATH),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

function descriptionProblem(
  frameworkId: FrameworkIdV1,
  description: unknown,
): string | FrameworkPluginDescriptionV1 {
  const parsed = DescriptionSchema.safeParse(description);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    return `returns a malformed describe() result${where}`;
  }
  if (parsed.data.frameworkId !== frameworkId) {
    return `describe() names framework ${show(parsed.data.frameworkId)}`;
  }
  if (parsed.data.catalogSubpath !== frameworkDescriptorSubpathV1(frameworkId)) {
    return `describe() names Catalog subpath ${show(parsed.data.catalogSubpath)}`;
  }
  return Object.freeze({ ...parsed.data, frameworkId }) as FrameworkPluginDescriptionV1;
}

function underAllowedRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path.startsWith(root.endsWith(sep) ? root : root + sep));
}

/**
 * Load the installed framework plugin for `frameworkId` and verify it against
 * contract 1, this Core's host API, its own package.json and, when Catalog is
 * installed, Catalog's identity record. Never throws.
 */
export async function loadFrameworkPluginV1(
  frameworkId: FrameworkIdV1,
  options: FrameworkPluginLoadOptionsV1 = {},
): Promise<FrameworkPluginLoadV1> {
  const access = options.access ?? installedPluginAccess;
  const timeoutMs = options.timeoutMs ?? FRAMEWORK_PLUGIN_DEFAULT_TIMEOUT_MS;
  const name = FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId];

  let manifestPath: string;
  try {
    manifestPath = access.resolvePackageJson(frameworkId);
  } catch (error) {
    if (isAbsent(error, name)) {
      return refusal(
        frameworkId,
        "framework-plugin-unavailable",
        `${name} is not installed next to @aihq/core. ${installAdvice(frameworkId)}`,
      );
    }
    return incompatible(
      frameworkId,
      codeOf(error) === "ERR_PACKAGE_PATH_NOT_EXPORTED"
        ? "does not export ./package.json"
        : `could not be resolved (${messageOf(error)})`,
    );
  }

  let root: string;
  try {
    const realManifest = access.realpath(manifestPath);
    root = dirname(realManifest);
    if (!underAllowedRoot(realManifest, access.allowedRoots())) {
      return incompatible(
        frameworkId,
        `resolves outside @aihq/core's own install tree (${sanitizeLabel(realManifest, 200)})`,
      );
    }
  } catch (error) {
    return incompatible(frameworkId, `failed the install-tree check (${messageOf(error)})`);
  }

  let version: string;
  try {
    const manifest: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(access.readFile(manifestPath)),
    );
    const record = isRecord(manifest) ? manifest : {};
    if (record.name !== name) {
      return incompatible(frameworkId, `package.json names ${show(record.name)}`);
    }
    if (
      typeof record.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.version)
    ) {
      return incompatible(
        frameworkId,
        `package.json has no exact version (${show(record.version)})`,
      );
    }
    version = record.version;
  } catch (error) {
    return incompatible(frameworkId, `package.json could not be read (${messageOf(error)})`);
  }

  let entry: string;
  try {
    entry = access.realpath(access.resolveEntry(frameworkId));
  } catch (error) {
    return incompatible(
      frameworkId,
      `${version} entry point could not be resolved (${messageOf(error)})`,
    );
  }
  if (!underAllowedRoot(entry, [root])) {
    return incompatible(
      frameworkId,
      `${version} entry point resolves outside its own package directory (${sanitizeLabel(entry, 200)})`,
    );
  }

  let namespace: unknown;
  try {
    namespace = await importWithTimeout(() => access.importPlugin(frameworkId), timeoutMs);
  } catch (error) {
    return incompatible(frameworkId, `${version} could not be loaded (${messageOf(error)})`);
  }
  if (namespace === TIMED_OUT) {
    return incompatible(frameworkId, `${version} did not finish loading within ${timeoutMs}ms`);
  }

  let plugin: FrameworkPluginV1;
  let description: FrameworkPluginDescriptionV1;
  try {
    const candidate = isRecord(namespace) ? namespace.aihFrameworkPluginV1 : undefined;
    const problems = contractProblems(frameworkId, version, candidate);
    if (problems.length > 0) {
      return incompatible(frameworkId, `${version} ${problems.slice(0, 3).join("; ")}`);
    }
    plugin = candidate as FrameworkPluginV1;
    const described = descriptionProblem(frameworkId, plugin.describe());
    if (typeof described === "string") return incompatible(frameworkId, `${version} ${described}`);
    description = described;
  } catch (error) {
    return incompatible(frameworkId, `${version} failed its contract check (${messageOf(error)})`);
  }

  let catalogIdentity: FrameworkPluginCatalogIdentityV1;
  const identities = await access.loadCatalogIdentities();
  if (!identities.ok) {
    if (identities.refusal.reason !== "catalog-package-unavailable") {
      return incompatible(
        frameworkId,
        `${version} cannot be confirmed against Catalog (${sanitizeLabel(catalogPackageRefusalMessage(identities.refusal), 400)})`,
      );
    }
    catalogIdentity = Object.freeze({ state: "catalog-not-installed" });
  } else {
    const catalogVersion = identities.catalogVersion ?? "unknown";
    const record = identities.entries.find((entry) => entry.frameworkId === frameworkId);
    if (record === undefined) {
      return incompatible(
        frameworkId,
        `${version} has no identity record in @aihq/catalog ${catalogVersion}`,
      );
    }
    if (record.version !== version) {
      return incompatible(
        frameworkId,
        `${version} does not equal @aihq/catalog ${catalogVersion}'s identity record ${record.packageName} ${record.version}`,
      );
    }
    if (record.contractVersion !== FRAMEWORK_PLUGIN_CONTRACT_VERSION) {
      return incompatible(
        frameworkId,
        `${version} is recorded by @aihq/catalog ${catalogVersion} for contract ${record.contractVersion}`,
      );
    }
    if (
      record.upstream.repository !== description.upstream.repository ||
      record.upstream.commit !== description.upstream.commit
    ) {
      return incompatible(
        frameworkId,
        `${version} supports ${description.upstream.repository}@${description.upstream.commit} but @aihq/catalog ${catalogVersion} records ${record.upstream.repository}@${record.upstream.commit}`,
      );
    }
    catalogIdentity = Object.freeze({
      state: "matched",
      catalogVersion: identities.catalogVersion,
      sha256: identities.sha256,
    });
  }

  return {
    ok: true,
    frameworkId,
    packageName: name,
    version,
    root,
    plugin,
    description,
    catalogIdentity,
  };
}

/** `reason: detail`, the form every report prints a plugin refusal in. */
export function frameworkPluginRefusalMessage(refusal: FrameworkPluginRefusalV1): string {
  return `${refusal.reason}: ${refusal.detail}`;
}

/** The refusal, for a command whose contract is to fail when its plugin cannot load. */
export class FrameworkPluginRefusalError extends AihError {
  readonly refusal: FrameworkPluginRefusalV1;

  constructor(refusal: FrameworkPluginRefusalV1) {
    super(frameworkPluginRefusalMessage(refusal), "AIH_FRAMEWORK_PLUGIN");
    this.refusal = refusal;
  }
}
