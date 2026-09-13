import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import type { Runner } from "../internals/proc.js";
import type { Platform } from "../platform/base.js";
import {
  OPENCODE_SANDBOX_HOME,
  OPENCODE_SANDBOX_PROFILE,
  openCodeSandboxAssertions,
} from "../sandbox/opencode.js";
import {
  evaluateMcpRuntimeObservation,
  type McpRuntimeBindings,
  type McpRuntimeEvaluation,
  type McpRuntimeMaterialRole,
  type McpRuntimeObservationV1,
  type McpRuntimeRestrictionEvaluation,
  parseMcpRuntimeObservation,
} from "./mcp-runtime-evidence.js";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const OPENCODE_CONFIG = "opencode.json";
const OPERATION_CANARY = "marker.txt";
const PROVIDER_PLUGIN = join(".opencode", "plugins", "aih-loopback.js");
const MANAGED_MCP_PACKAGE = join(
  "node_modules",
  "@modelcontextprotocol",
  "server-sequential-thinking",
);

export type RuntimeEvidenceRecordState = McpRuntimeEvaluation["recordState"] | "unavailable";

export interface RuntimeEvidenceResult {
  requested: true;
  targetCli: "opencode";
  source: "local-unsigned-observation";
  recordState: RuntimeEvidenceRecordState;
  reasons: string[];
  observedAt: string | null;
  expiresAt: string | null;
  supported: "verified" | "unverified";
  discovered: "verified" | "unverified";
  exercised: "verified" | "unverified";
  restart: "verified" | "unverified";
  enforcement: "verified" | "unverified";
  operation: { server: string; tool: string } | null;
  restrictions: McpRuntimeRestrictionEvaluation[];
}

export interface OpenCodeRuntimeEvidenceInput {
  root: string;
  evidencePath: unknown;
  now: string;
  platform: Platform;
  targetCli: unknown;
  run: Runner;
}

class BindingError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function safeBytes(path: string, maxBytes: number, reason: string): Buffer {
  const material = readRegularFileWithStats(path, { maxBytes });
  if (!material) throw new BindingError(reason);
  return material.contents;
}

function plain(value: unknown, reason: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new BindingError(reason);
  return value;
}

function text(value: unknown, reason: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new BindingError(reason);
  }
  return value;
}

function canary(value: unknown, reason: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0")
  ) {
    throw new BindingError(reason);
  }
  return value;
}

function parsedJson(bytes: Buffer, reason: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BindingError(reason);
  }
}

function containsPath(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function canonicalFile(
  path: string,
  maxBytes: number,
  reason: string,
): { path: string; bytes: Buffer } {
  if (!isAbsolute(path)) throw new BindingError(reason);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new BindingError(reason);
  }
  if (canonical !== resolve(path)) throw new BindingError(reason);
  return { path: canonical, bytes: safeBytes(canonical, maxBytes, reason) };
}

function material(
  role: McpRuntimeMaterialRole,
  path: string,
  maximum: number,
): NonNullable<McpRuntimeBindings["materials"]>[number] {
  const current = canonicalFile(path, maximum, `current-${role}-unavailable`);
  return { role, path: current.path, sha256: sha256(current.bytes) };
}

function pathList(value: unknown, reason: string): [string, string, string] {
  if (!Array.isArray(value) || value.length !== 3) throw new BindingError(reason);
  return [text(value[0], reason), text(value[1], reason), text(value[2], reason)];
}

function currentVersionEnvironment(root: string): NodeJS.ProcessEnv {
  const canonicalRoot = realpathSync(root);
  openCodeSandboxAssertions(canonicalRoot);
  const profile = plain(
    parsedJson(
      safeBytes(
        join(canonicalRoot, OPENCODE_SANDBOX_PROFILE),
        MAX_CONFIG_BYTES,
        "sandbox-profile-unavailable",
      ),
      "sandbox-profile-malformed",
    ),
    "sandbox-profile-malformed",
  );
  const configured = plain(profile.environment, "sandbox-profile-malformed");
  const environment = Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name,
      text(value, "sandbox-profile-malformed"),
    ]),
  );
  const home = join(canonicalRoot, OPENCODE_SANDBOX_HOME);
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    AIH_ORG_POLICY: text(profile.policy, "sandbox-profile-malformed"),
  };
}

function managedMcpMaterials(canonicalRoot: string): NonNullable<McpRuntimeBindings["materials"]> {
  const packageRoot = join(canonicalRoot, MANAGED_MCP_PACKAGE);
  const manifestMaterial = material(
    "managed-mcp-manifest",
    join(packageRoot, "package.json"),
    MAX_CONFIG_BYTES,
  );
  const manifest = plain(
    parsedJson(
      safeBytes(manifestMaterial.path, MAX_CONFIG_BYTES, "current-managed-mcp-manifest-malformed"),
      "current-managed-mcp-manifest-malformed",
    ),
    "current-managed-mcp-manifest-malformed",
  );
  const bin = manifest.bin;
  const target =
    typeof bin === "string"
      ? bin
      : isPlainObject(bin)
        ? bin["mcp-server-sequential-thinking"]
        : undefined;
  const relativeTarget = text(target, "current-managed-mcp-entry-unavailable");
  if (isAbsolute(relativeTarget)) throw new BindingError("current-managed-mcp-entry-unavailable");
  const resolved = resolve(packageRoot, relativeTarget);
  if (!containsPath(packageRoot, resolved) || resolved === resolve(packageRoot)) {
    throw new BindingError("current-managed-mcp-entry-unavailable");
  }
  return [manifestMaterial, material("managed-mcp-entry", resolved, MAX_SCRIPT_BYTES)];
}

/**
 * Recompute the fixed OpenCode native fixture's bindings from this root's current
 * AIH-owned profile and native configuration. A producer that calls this helper
 * must independently measure `observedVersion` from the returned current executable;
 * the readiness evaluator below does that through its bounded runner seam.
 */
export function currentOpenCodeRuntimeBindings(
  root: string,
  observedVersion: string,
): McpRuntimeBindings {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new BindingError("canonical-root-unavailable");
  }
  try {
    openCodeSandboxAssertions(canonicalRoot);
  } catch {
    throw new BindingError("sandbox-profile-material-unavailable");
  }

  const profilePath = join(canonicalRoot, OPENCODE_SANDBOX_PROFILE);
  const profileFile = canonicalFile(profilePath, MAX_CONFIG_BYTES, "sandbox-profile-unavailable");
  const profile = plain(
    parsedJson(profileFile.bytes, "sandbox-profile-malformed"),
    "sandbox-profile-malformed",
  );
  if (
    profile.client !== "opencode" ||
    resolve(text(profile.root, "sandbox-profile-malformed")) !== canonicalRoot
  ) {
    throw new BindingError("sandbox-profile-root-mismatch");
  }
  const policyPath = text(profile.policy, "sandbox-profile-malformed");
  const bwrapPath = text(profile.bwrapExecutable, "sandbox-profile-malformed");
  const clientPath = text(profile.opencodeExecutable, "sandbox-profile-malformed");
  const seccompPath = text(profile.seccompExecutable, "sandbox-profile-malformed");
  const environment = plain(profile.environment, "sandbox-profile-malformed");

  const configPath = join(canonicalRoot, OPENCODE_CONFIG);
  const configFile = canonicalFile(configPath, MAX_CONFIG_BYTES, "native-config-unavailable");
  let configValue: unknown;
  try {
    configValue = parseJsoncText(configFile.bytes.toString("utf8"));
  } catch {
    throw new BindingError("native-config-malformed");
  }
  const config = plain(configValue, "native-config-malformed");
  const mcp = plain(config.mcp, "fixed-fixture-configuration-unavailable");
  const fixtureServer = plain(mcp.fixture, "fixed-fixture-configuration-unavailable");
  const managedServer = plain(mcp["sequential-thinking"], "managed-mcp-configuration-unavailable");
  if (
    !Array.isArray(managedServer.command) ||
    JSON.stringify(managedServer.command) !==
      JSON.stringify(["npx", "-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"])
  ) {
    throw new BindingError("managed-mcp-configuration-unavailable");
  }
  if (fixtureServer.type !== "local" || fixtureServer.enabled !== true) {
    throw new BindingError("fixed-fixture-configuration-unavailable");
  }
  const [runtimePath, fixturePath, fixtureConfigPath] = pathList(
    fixtureServer.command,
    "fixed-fixture-command-unavailable",
  );
  if (![runtimePath, fixturePath, fixtureConfigPath].every(isAbsolute)) {
    throw new BindingError("fixed-fixture-command-unavailable");
  }
  if (!containsPath(canonicalRoot, fixtureConfigPath)) {
    throw new BindingError("fixed-fixture-config-outside-root");
  }
  const configuredPath = text(environment.PATH, "sandbox-runtime-path-unavailable");
  if (
    !configuredPath
      .split(delimiter)
      .some((entry) => resolve(entry) === dirname(resolve(runtimePath)))
  ) {
    throw new BindingError("mcp-runtime-outside-profile-path");
  }

  const fixtureConfigFile = canonicalFile(
    fixtureConfigPath,
    MAX_CONFIG_BYTES,
    "current-mcp-fixture-config-unavailable",
  );
  const fixtureConfig = plain(
    parsedJson(fixtureConfigFile.bytes, "current-mcp-fixture-config-malformed"),
    "current-mcp-fixture-config-malformed",
  );
  if (
    resolve(text(fixtureConfig.root, "current-mcp-fixture-config-malformed")) !== canonicalRoot ||
    resolve(text(fixtureConfig.policy, "current-mcp-fixture-config-malformed")) !==
      resolve(policyPath)
  ) {
    throw new BindingError("current-mcp-fixture-config-mismatch");
  }
  canary(fixtureConfig.marker, "current-operation-binding-unavailable");
  const expectedCanary = canary(
    safeBytes(
      join(canonicalRoot, OPERATION_CANARY),
      MAX_CONFIG_BYTES,
      "current-operation-canary-unavailable",
    ).toString("utf8"),
    "current-operation-canary-unavailable",
  );

  const runtimeMaterial = material("mcp-runtime", runtimePath, MAX_EXECUTABLE_BYTES);
  const fixtureMaterial = material("mcp-fixture", fixturePath, MAX_SCRIPT_BYTES);
  const managedMaterials = managedMcpMaterials(canonicalRoot);
  const materials: NonNullable<McpRuntimeBindings["materials"]> = [
    { role: "sandbox-profile", path: profileFile.path, sha256: sha256(profileFile.bytes) },
    material("organization-policy", policyPath, MAX_CONFIG_BYTES),
    material("bubblewrap", bwrapPath, MAX_EXECUTABLE_BYTES),
    material("seccomp", seccompPath, MAX_EXECUTABLE_BYTES),
    material("provider-plugin", join(canonicalRoot, PROVIDER_PLUGIN), MAX_SCRIPT_BYTES),
    runtimeMaterial,
    fixtureMaterial,
    {
      role: "mcp-fixture-config",
      path: fixtureConfigFile.path,
      sha256: sha256(fixtureConfigFile.bytes),
    },
    ...managedMaterials,
  ];
  const client = material("mcp-runtime", clientPath, MAX_EXECUTABLE_BYTES);
  return {
    client: {
      targetCli: "opencode",
      executable: client.path,
      version: observedVersion,
      sha256: client.sha256,
    },
    target: { canonicalRoot, configPath: configFile.path, configSha256: sha256(configFile.bytes) },
    policy: {
      approvalPolicy: "operator-approved",
      sandbox: "external-linux",
      networkAccess: false,
    },
    server: {
      name: "fixture",
      fixtureIdentity: `sha256:${fixtureMaterial.sha256}`,
      runtimeIdentity: `sha256:${runtimeMaterial.sha256}`,
    },
    invocation: { tool: "fixture_probe", argumentsSha256: sha256("{}") },
    materials,
    operation: { expectedCanary },
  };
}

function empty(
  state: RuntimeEvidenceRecordState,
  reasons: string[],
  record?: McpRuntimeObservationV1,
): RuntimeEvidenceResult {
  return {
    requested: true,
    targetCli: "opencode",
    source: "local-unsigned-observation",
    recordState: state,
    reasons,
    observedAt: record?.observedAt ?? null,
    expiresAt: record?.expiresAt ?? null,
    supported: "unverified",
    discovered: "unverified",
    exercised: "unverified",
    restart: "unverified",
    enforcement: "unverified",
    operation: record ? { server: record.server.name, tool: record.invocation.tool } : null,
    restrictions: (record?.restrictions ?? []).map(({ id, boundary }) => ({
      id,
      boundary,
      status: "unverified",
    })),
  };
}

function targetSelected(value: unknown): boolean {
  return (
    value === "opencode" || (Array.isArray(value) && value.length === 1 && value[0] === "opencode")
  );
}

/** Evaluate one explicitly selected, unsigned local OpenCode runtime observation. */
function measuredVersion(stdout: string): string | undefined {
  return stdout.match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/)?.[1];
}

export async function evaluateOpenCodeRuntimeEvidence(
  input: OpenCodeRuntimeEvidenceInput,
): Promise<RuntimeEvidenceResult> {
  if (!targetSelected(input.targetCli))
    return empty("unavailable", ["opencode-selection-required"]);
  if (input.platform !== "linux") return empty("unavailable", ["opencode-linux-required"]);
  if (typeof input.evidencePath !== "string" || !isAbsolute(input.evidencePath)) {
    return empty("unavailable", ["observation-file-must-be-absolute"]);
  }
  const recordBytes = readRegularFileWithStats(input.evidencePath, { maxBytes: MAX_RECORD_BYTES });
  if (!recordBytes) return empty("unavailable", ["observation-file-unavailable"]);
  let raw: unknown;
  try {
    raw = JSON.parse(recordBytes.contents.toString("utf8"));
  } catch {
    return empty("invalid", ["malformed-observation"]);
  }
  const record = parseMcpRuntimeObservation(raw);
  if (!record) return empty("invalid", ["malformed-observation"]);
  if (record.client.targetCli !== "opencode") {
    return empty("unavailable", ["unsupported-observation-client"], record);
  }
  let before: McpRuntimeBindings;
  let versionEnvironment: NodeJS.ProcessEnv;
  try {
    before = currentOpenCodeRuntimeBindings(input.root, "0.0.0-current-probe");
    versionEnvironment = currentVersionEnvironment(input.root);
  } catch (error) {
    return empty(
      "unavailable",
      [error instanceof BindingError ? error.reason : "current-material-unavailable"],
      record,
    );
  }
  let versionResult: Awaited<ReturnType<Runner>>;
  try {
    versionResult = await input.run([before.client.executable, "--version"], {
      cwd: before.target.canonicalRoot,
      env: versionEnvironment,
      timeoutMs: 15_000,
      maxBufferBytes: 64 * 1024,
    });
  } catch {
    return empty("unavailable", ["client-version-unavailable"], record);
  }
  const currentVersion =
    !versionResult.spawnError && !versionResult.truncated && versionResult.code === 0
      ? measuredVersion(versionResult.stdout)
      : undefined;
  if (!currentVersion) return empty("unavailable", ["client-version-unavailable"], record);
  let bindings: McpRuntimeBindings;
  try {
    bindings = currentOpenCodeRuntimeBindings(input.root, currentVersion);
  } catch (error) {
    return empty(
      "unavailable",
      [error instanceof BindingError ? error.reason : "current-material-unavailable"],
      record,
    );
  }
  if (
    before.client.executable !== bindings.client.executable ||
    before.client.sha256 !== bindings.client.sha256 ||
    JSON.stringify(before.target) !== JSON.stringify(bindings.target) ||
    JSON.stringify(before.materials) !== JSON.stringify(bindings.materials)
  ) {
    return empty("unavailable", ["current-material-changed-during-evaluation"], record);
  }
  const evaluation = evaluateMcpRuntimeObservation(record, bindings, input.now);
  return {
    requested: true,
    targetCli: "opencode",
    source: "local-unsigned-observation",
    recordState: evaluation.recordState,
    reasons: evaluation.reasons,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    supported: evaluation.supported,
    discovered: evaluation.discovered,
    exercised: evaluation.exercised,
    restart: evaluation.restart,
    enforcement: evaluation.enforcement,
    operation: { server: record.server.name, tool: record.invocation.tool },
    restrictions: evaluation.restrictions,
  };
}
