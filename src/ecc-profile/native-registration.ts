import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { removeManagedBlock, upsertTextBlock } from "../internals/envfile.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { type Action, type Plan, plan, remove, type WriteAction } from "../internals/plan.js";
import { beginMarker, endMarker } from "../internals/render.js";
import { existingMcpTomlNames } from "../mcp/render.js";
import {
  buildEccMcpProfileProjection,
  buildSerena161ReceiptProjection,
  CONTEXT7_SUBJECT_SHA256,
  ECC_MCP_DISABLED,
  type EccMcpProjection,
  SERENA_RUNTIME_PIN,
} from "./mcp-profile.js";

const MAX_RUNTIME_FILE_BYTES = 128 * 1024 * 1024;

export const SERENA_RUNTIME_PYPROJECT_SHA256 =
  "755b08fb0271d68f7e8fcc9eb6e823b95d3688a6cb1d3f693c13cde2cade7897";
export const SERENA_RUNTIME_UV_LOCK_SHA256 =
  "cd73b07cbc10dc932021f741033a88219b86272b05223d06d9820dc6109309b4";
export const SERENA_DEPENDENCY_LOCK_SHA256 =
  "623c83ede4efc2b1afc8534d60638871556d95cd685db218714379cfdba0104e";

/** Append-only identities that newer packages may use to recover older registrations. */
const TRUSTED_SERENA_RUNTIME_LOCKS = [
  {
    package: "serena-agent==1.6.1",
    pyprojectSha256: "25dbee035cd2c3ce2e65110eda0cc20f066ec37aea37210fab9569b81ca6a5ba",
    uvLockSha256: "ba888b113354c146cc8ecd925e6821d4284ebfad984a8544163be2803295f460",
    aggregateSha256: "1eaf5dcffef9426f9024d03e6875ccbaf2a6857cbcfecf22127a7d1876ebf5b0",
  },
  {
    package: SERENA_RUNTIME_PIN.package,
    pyprojectSha256: SERENA_RUNTIME_PYPROJECT_SHA256,
    uvLockSha256: SERENA_RUNTIME_UV_LOCK_SHA256,
    aggregateSha256: SERENA_DEPENDENCY_LOCK_SHA256,
  },
] as const;

const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "Stop",
] as const;

const CODEX_EVENTS = CLAUDE_EVENTS.filter(
  (event) => event !== "PostToolUseFailure" && event !== "Notification",
);

interface RuntimeFileIdentity {
  path: string;
  sha256: string;
}

interface NativeCommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout: number;
  statusMessage: string;
}

interface NativeHookGroup {
  hooks: [NativeCommandHook];
}

interface NativeHooks {
  description: string;
  hooks: Record<string, [NativeHookGroup]>;
}

export interface NativeEccRegistrationInput {
  root: string;
  stateRoot: string;
  executable: string;
  cliScript: string;
  /** Override only for hermetic package-layout tests; production discovers the packaged lock. */
  serenaRuntimeRoot?: string;
}

export interface NativeEccRegistration {
  version: 1;
  root: string;
  stateRoot: string;
  runtime: {
    executable: RuntimeFileIdentity;
    cliScript: RuntimeFileIdentity;
    serena: {
      root: string;
      pyproject: RuntimeFileIdentity;
      uvLock: RuntimeFileIdentity;
      aggregateSha256: string;
    };
  };
  hooks: { claude: NativeHooks; codex: NativeHooks };
  mcp: {
    claude: { mcpServers: Record<string, unknown> };
    codexToml: string;
    disabled: typeof ECC_MCP_DISABLED;
    serenaConfig: string;
    provenance: EccMcpProjection["provenance"];
  };
}

export interface NativeRegistrationFile {
  destination: ".claude/settings.json" | ".mcp.json" | ".codex/hooks.json" | ".codex/config.toml";
  ownership: "json-array-children" | "json-object-children" | "toml-block";
  content: string;
  normalizedSha256: string;
}

export const NATIVE_ECC_REGISTRATION_RECEIPT = ".aih/ecc-profile/native-registration-v1.json";
export const NATIVE_ECC_REGISTRATION_SCOPE = "ecc-native-registration";
const NATIVE_REGISTRATION_SCOPE = NATIVE_ECC_REGISTRATION_SCOPE;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

interface RegistrationReceipt {
  version: 1;
  root: string;
  stateRoot: string;
  runtime: NativeEccRegistration["runtime"];
  files: NativeRegistrationFile[];
}

const runtimeIdentitySchema = z
  .object({ path: z.string().min(1).max(4_096), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const registrationFileSchema = z
  .object({
    destination: z.enum([
      ".claude/settings.json",
      ".mcp.json",
      ".codex/hooks.json",
      ".codex/config.toml",
    ]),
    ownership: z.enum(["json-array-children", "json-object-children", "toml-block"]),
    content: z.string().max(MAX_CONFIG_BYTES),
    normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const registrationReceiptSchema = z
  .object({
    version: z.literal(1),
    root: z.string().min(1).max(4_096),
    stateRoot: z.string().min(1).max(4_096),
    runtime: z
      .object({
        executable: runtimeIdentitySchema,
        cliScript: runtimeIdentitySchema,
        serena: z
          .object({
            root: z.string().min(1).max(4_096),
            pyproject: runtimeIdentitySchema,
            uvLock: runtimeIdentitySchema,
            aggregateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      })
      .strict(),
    files: z.array(registrationFileSchema).length(4),
  })
  .strict();

interface CurrentFile {
  contents: string;
  sha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`${label} must be a real directory`);
  return realpathSync(value);
}

function safeFutureDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const destination = resolve(value);
  let cursor = destination;
  for (;;) {
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`${label} has a non-directory or linked ancestor`);
      }
      const canonicalParent = realpathSync(cursor);
      return resolve(canonicalParent, relative(cursor, destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`${label} has no accessible directory ancestor`);
      cursor = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function runtimeFile(value: string, label: string): RuntimeFileIdentity {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error(`${label} must be a regular non-linked file`);
  const canonical = realpathSync(value);
  const opened = readRegularFileWithStats(canonical, { maxBytes: MAX_RUNTIME_FILE_BYTES });
  if (!opened || opened.stats.nlink > 1)
    throw new Error(`${label} must be an unambiguous regular file`);
  return { path: canonical, sha256: sha256(opened.contents) };
}

function posixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function windowsCommandArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function packagedSerenaRuntimeRoot(): string {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleRoot, "serena-runtime"),
    resolve(moduleRoot, "../src/ecc-profile/serena-runtime"),
  ];
  for (const candidate of candidates) {
    try {
      return canonicalDirectory(candidate, "packaged Serena runtime root");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("packaged Serena runtime lock is missing");
}

function serenaRuntimeIdentity(rootInput?: string): NativeEccRegistration["runtime"]["serena"] {
  const root = canonicalDirectory(
    rootInput ?? packagedSerenaRuntimeRoot(),
    "Serena runtime lock root",
  );
  const pyproject = runtimeFile(resolve(root, "pyproject.toml"), "Serena runtime pyproject");
  const uvLock = runtimeFile(resolve(root, "uv.lock"), "Serena runtime uv.lock");
  if (pyproject.sha256 !== SERENA_RUNTIME_PYPROJECT_SHA256) {
    throw new Error("Serena runtime pyproject does not match the authenticated package pin");
  }
  if (uvLock.sha256 !== SERENA_RUNTIME_UV_LOCK_SHA256) {
    throw new Error("Serena runtime uv.lock does not match the authenticated dependency closure");
  }
  const aggregateSha256 = sha256(`${pyproject.sha256}\0${uvLock.sha256}`);
  if (aggregateSha256 !== SERENA_DEPENDENCY_LOCK_SHA256) {
    throw new Error("Serena runtime dependency-lock aggregate is invalid");
  }
  return { root, pyproject, uvLock, aggregateSha256 };
}

function assertTrustedSerenaReceiptIdentity(
  value: NativeEccRegistration["runtime"]["serena"],
  projectRoot: string,
  stateRoot: string,
): (typeof TRUSTED_SERENA_RUNTIME_LOCKS)[number] {
  if (
    !isAbsolute(value.root) ||
    contains(projectRoot, value.root) ||
    contains(value.root, projectRoot) ||
    contains(stateRoot, value.root) ||
    contains(value.root, stateRoot) ||
    value.pyproject.path !== resolve(value.root, "pyproject.toml") ||
    value.uvLock.path !== resolve(value.root, "uv.lock")
  ) {
    throw new Error("native registration ownership receipt has an invalid Serena runtime root");
  }
  const trusted = TRUSTED_SERENA_RUNTIME_LOCKS.find(
    (identity) =>
      identity.pyprojectSha256 === value.pyproject.sha256 &&
      identity.uvLockSha256 === value.uvLock.sha256 &&
      identity.aggregateSha256 === value.aggregateSha256,
  );
  if (
    trusted === undefined ||
    sha256(`${value.pyproject.sha256}\0${value.uvLock.sha256}`) !== value.aggregateSha256
  ) {
    throw new Error("native registration ownership receipt has an unauthenticated Serena runtime");
  }
  return trusted;
}

function hooksFor(
  client: "claude" | "codex",
  runtime: NativeEccRegistration["runtime"],
  root: string,
  stateRoot: string,
): NativeHooks {
  const args = [
    runtime.cliScript.path,
    "hook",
    "--client",
    client,
    "--root",
    root,
    "--state-root",
    stateRoot,
  ];
  const command = [runtime.executable.path, ...args].map(posixShellArg).join(" ");
  const commandWindows = [runtime.executable.path, ...args].map(windowsCommandArg).join(" ");
  const handler: NativeCommandHook =
    client === "claude"
      ? {
          type: "command",
          command,
          timeout: 30,
          statusMessage: "Running AIH ECC profile policies",
        }
      : {
          type: "command",
          command,
          commandWindows,
          timeout: 30,
          statusMessage: "Running AIH ECC profile policies",
        };
  const events = client === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS;
  return {
    description: "AIH-owned ECC composite hook dispatcher.",
    hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ ...handler }] }]])),
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildNativeEccRegistration(
  input: NativeEccRegistrationInput,
): NativeEccRegistration {
  if (!isAbsolute(input.root)) throw new Error("registration root must be absolute");
  if (!isAbsolute(input.stateRoot)) throw new Error("registration state root must be absolute");
  const root = canonicalDirectory(input.root, "registration root");
  const stateRoot = safeFutureDirectory(input.stateRoot, "registration state root");
  if (contains(root, stateRoot) || contains(stateRoot, root)) {
    throw new Error("registration state root must be outside and disjoint from the project root");
  }
  const executable = runtimeFile(input.executable, "runtime executable");
  const cliScript = runtimeFile(input.cliScript, "runtime CLI script");
  if (executable.path.toLowerCase() === cliScript.path.toLowerCase()) {
    throw new Error("runtime executable and CLI script must be distinct and unambiguous");
  }
  const serena = serenaRuntimeIdentity(input.serenaRuntimeRoot);
  const runtime = { executable, cliScript, serena };
  for (const identity of [
    runtime.executable,
    runtime.cliScript,
    runtime.serena.pyproject,
    runtime.serena.uvLock,
  ]) {
    if (contains(root, identity.path)) {
      throw new Error("native registration runtime files must be outside the project root");
    }
  }
  return registrationFromIdentities(root, stateRoot, runtime);
}

function registrationFromIdentities(
  root: string,
  stateRoot: string,
  runtime: NativeEccRegistration["runtime"],
  serenaPackage: (typeof TRUSTED_SERENA_RUNTIME_LOCKS)[number]["package"] = SERENA_RUNTIME_PIN.package,
): NativeEccRegistration {
  const mcpInput = {
    canonicalWorktree: root,
    serenaHome: resolve(stateRoot, "serena"),
    wrapperCommand: runtime.executable.path,
    wrapperArgsPrefix: [runtime.cliScript.path],
    wrapperSha256: runtime.cliScript.sha256,
    serenaDependencyLockSha256: runtime.serena.aggregateSha256,
    serenaRuntimeRoot: runtime.serena.root,
    context7Attestation: {
      endpoint: "https://mcp.context7.com/mcp",
      subjectSha256: CONTEXT7_SUBJECT_SHA256,
      reviewedAt: "2026-08-03T00:00:00.000Z",
    },
  } as const;
  const buildProjection =
    serenaPackage === SERENA_RUNTIME_PIN.package
      ? buildEccMcpProfileProjection
      : buildSerena161ReceiptProjection;
  const claudeMcp = buildProjection({ ...mcpInput, client: "claude" });
  const codexMcp = buildProjection({ ...mcpInput, client: "codex" });
  if (claudeMcp.native.kind !== "claude-json" || codexMcp.native.kind !== "codex-toml") {
    throw new Error("native MCP projection returned an unexpected client shape");
  }
  const parsedClaude = JSON.parse(claudeMcp.native.body) as { mcpServers: Record<string, unknown> };
  return {
    version: 1,
    root,
    stateRoot,
    runtime,
    hooks: {
      claude: hooksFor("claude", runtime, root, stateRoot),
      codex: hooksFor("codex", runtime, root, stateRoot),
    },
    mcp: {
      claude: parsedClaude,
      codexToml: codexMcp.native.body,
      disabled: ECC_MCP_DISABLED,
      serenaConfig: claudeMcp.serenaConfig,
      provenance: claudeMcp.provenance,
    },
  };
}

export function nativeRegistrationFiles(
  registration: NativeEccRegistration,
): NativeRegistrationFile[] {
  const fragments = [
    {
      destination: ".claude/settings.json" as const,
      ownership: "json-array-children" as const,
      content: stableJson({ hooks: registration.hooks.claude.hooks }),
    },
    {
      destination: ".mcp.json" as const,
      ownership: "json-object-children" as const,
      content: stableJson(registration.mcp.claude),
    },
    {
      destination: ".codex/hooks.json" as const,
      ownership: "json-array-children" as const,
      content: stableJson({ hooks: registration.hooks.codex.hooks }),
    },
    {
      destination: ".codex/config.toml" as const,
      ownership: "toml-block" as const,
      content: registration.mcp.codexToml,
    },
  ];
  return fragments.map((file) => ({ ...file, normalizedSha256: sha256(file.content) }));
}

function readCurrent(
  root: string,
  destination: string,
  maxBytes = MAX_CONFIG_BYTES,
): CurrentFile | undefined {
  const inspected = inspectContainedRelativePath(root, destination);
  if (inspected.state === "absent") return undefined;
  if (inspected.state === "unsafe" || inspected.kind !== "file") {
    throw new Error(`native registration destination is unsafe: ${destination}`);
  }
  const opened = readRegularFileWithStats(inspected.realPath, { maxBytes });
  if (!opened || opened.stats.nlink > 1) {
    throw new Error(
      `native registration destination is not an unambiguous regular file: ${destination}`,
    );
  }
  return { contents: opened.contents.toString("utf8"), sha256: sha256(opened.contents) };
}

function writePinned(
  destination: string,
  contents: string,
  current: CurrentFile | undefined,
  describe: string,
): WriteAction {
  return {
    kind: "write",
    path: destination,
    describe,
    contents,
    mode: 0o644,
    expect: current === undefined ? { absent: true } : { sha256: current.sha256 },
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseObject(contents: string, destination: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`native registration JSON is malformed: ${destination}`);
  }
  if (!plainObject(value))
    throw new Error(`native registration JSON must be an object: ${destination}`);
  return value;
}

function fragmentRoot(file: NativeRegistrationFile): [string, Record<string, unknown>] {
  const parsed = parseObject(file.content, file.destination);
  const entries = Object.entries(parsed);
  if (entries.length !== 1 || !plainObject(entries[0]?.[1])) {
    throw new Error(`native registration fragment is malformed: ${file.destination}`);
  }
  return [entries[0]?.[0] ?? "", entries[0]?.[1] as Record<string, unknown>];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeJsonFragment(current: CurrentFile | undefined, file: NativeRegistrationFile): string {
  const root = current === undefined ? {} : parseObject(current.contents, file.destination);
  const [parentKey, managedChildren] = fragmentRoot(file);
  const existingParent = root[parentKey];
  if (existingParent !== undefined && !plainObject(existingParent)) {
    throw new Error(`native registration ownership conflicts at ${file.destination}#${parentKey}`);
  }
  const parent = { ...(existingParent as Record<string, unknown> | undefined) };
  for (const [childKey, managedValue] of Object.entries(managedChildren)) {
    const existing = parent[childKey];
    if (file.ownership === "json-object-children") {
      if (existing !== undefined) {
        throw new Error(
          `native registration ownership conflicts at ${file.destination}#${childKey}`,
        );
      }
      parent[childKey] = managedValue;
      continue;
    }
    if (!Array.isArray(managedValue) || (existing !== undefined && !Array.isArray(existing))) {
      throw new Error(
        `native registration hook array conflicts at ${file.destination}#${childKey}`,
      );
    }
    const existingArray = (existing ?? []) as unknown[];
    if (managedValue.some((item) => existingArray.some((candidate) => sameJson(candidate, item)))) {
      throw new Error(
        `native registration hook ownership is ambiguous at ${file.destination}#${childKey}`,
      );
    }
    parent[childKey] = [...existingArray, ...managedValue];
  }
  return stableJson({ ...root, [parentKey]: parent });
}

function removeJsonFragment(current: CurrentFile, file: NativeRegistrationFile): string {
  const root = parseObject(current.contents, file.destination);
  const [parentKey, managedChildren] = fragmentRoot(file);
  const existingParent = root[parentKey];
  if (!plainObject(existingParent)) {
    throw new Error(`modified native registration managed content: ${file.destination}`);
  }
  const parent = { ...existingParent };
  for (const [childKey, managedValue] of Object.entries(managedChildren)) {
    const existing = parent[childKey];
    if (file.ownership === "json-object-children") {
      if (!sameJson(existing, managedValue)) {
        throw new Error(
          `modified native registration managed content: ${file.destination}#${childKey}`,
        );
      }
      delete parent[childKey];
      continue;
    }
    if (!Array.isArray(existing) || !Array.isArray(managedValue)) {
      throw new Error(`modified native registration managed hook: ${file.destination}#${childKey}`);
    }
    const retained = [...existing];
    for (const managed of managedValue) {
      const indexes = retained
        .map((candidate, index) => (sameJson(candidate, managed) ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) {
        throw new Error(
          `modified native registration managed hook: ${file.destination}#${childKey}`,
        );
      }
      retained.splice(indexes[0] ?? 0, 1);
    }
    if (retained.length === 0) delete parent[childKey];
    else parent[childKey] = retained;
  }
  const next = { ...root };
  if (Object.keys(parent).length === 0) delete next[parentKey];
  else next[parentKey] = parent;
  return Object.keys(next).length === 0 ? "" : stableJson(next);
}

function installedContent(current: CurrentFile | undefined, file: NativeRegistrationFile): string {
  if (file.ownership === "toml-block") {
    const existing = current?.contents ?? "";
    if (existing.includes(beginMarker(NATIVE_REGISTRATION_SCOPE))) {
      throw new Error(`native registration TOML ownership is ambiguous: ${file.destination}`);
    }
    const conflicts = tomlMcpOwnershipConflicts(existing, file);
    if (conflicts.length > 0) {
      throw new Error(
        `native registration TOML MCP ownership conflicts at ${file.destination}: ${conflicts.join(", ")}`,
      );
    }
    return upsertTextBlock(existing, NATIVE_REGISTRATION_SCOPE, file.content);
  }
  return mergeJsonFragment(current, file);
}

function tomlMcpOwnershipConflicts(existing: string, file: NativeRegistrationFile): string[] {
  const existingNames = existingMcpTomlNames(existing, NATIVE_REGISTRATION_SCOPE);
  const managedNames = existingMcpTomlNames(file.content, NATIVE_REGISTRATION_SCOPE);
  return [...managedNames].filter((name) => existingNames.has(name)).sort();
}

function assertInstalled(current: CurrentFile | undefined, file: NativeRegistrationFile): void {
  if (current === undefined)
    throw new Error(`missing native registration destination: ${file.destination}`);
  if (file.ownership === "toml-block") {
    const conflicts = tomlMcpOwnershipConflicts(current.contents, file);
    if (conflicts.length > 0) {
      throw new Error(
        `native registration TOML MCP ownership conflicts at ${file.destination}: ${conflicts.join(", ")}`,
      );
    }
    const begin = beginMarker(NATIVE_REGISTRATION_SCOPE);
    const endToken = endMarker(NATIVE_REGISTRATION_SCOPE);
    const expected = `${begin}\n${file.content}\n${endToken}`;
    const start = current.contents.indexOf(begin);
    const end = current.contents.indexOf(endToken, start);
    if (
      start < 0 ||
      end < 0 ||
      current.contents.indexOf(begin, start + begin.length) >= 0 ||
      current.contents.slice(start, end + endToken.length).replace(/\r\n/g, "\n") !== expected
    ) {
      throw new Error(`modified native registration TOML block: ${file.destination}`);
    }
    return;
  }
  const removed = removeJsonFragment(current, file);
  const remerged = mergeJsonFragment(
    removed.length === 0 ? undefined : { contents: removed, sha256: sha256(removed) },
    file,
  );
  if (
    !sameJson(
      parseObject(remerged, file.destination),
      parseObject(current.contents, file.destination),
    )
  ) {
    throw new Error(`modified native registration JSON: ${file.destination}`);
  }
}

function receiptFor(
  registration: NativeEccRegistration,
  files: NativeRegistrationFile[],
): RegistrationReceipt {
  return {
    version: 1,
    root: registration.root,
    stateRoot: registration.stateRoot,
    runtime: registration.runtime,
    files,
  };
}

function parseReceipt(
  root: string,
): { receipt: RegistrationReceipt; current: CurrentFile } | undefined {
  const current = readCurrent(root, NATIVE_ECC_REGISTRATION_RECEIPT, MAX_CONFIG_BYTES);
  if (current === undefined) return undefined;
  const receipt = registrationReceiptSchema.parse(
    parseObject(current.contents, NATIVE_ECC_REGISTRATION_RECEIPT),
  ) as RegistrationReceipt;
  if (receipt.root !== realpathSync(root)) {
    throw new Error("native registration ownership receipt is malformed or foreign");
  }
  if (!isAbsolute(receipt.stateRoot)) {
    throw new Error("native registration ownership receipt has a relative state root");
  }
  if (contains(receipt.root, receipt.stateRoot) || contains(receipt.stateRoot, receipt.root)) {
    throw new Error("native registration ownership receipt has a conflicting state root");
  }
  const runtimePaths = [
    receipt.runtime.executable.path,
    receipt.runtime.cliScript.path,
    receipt.runtime.serena.pyproject.path,
    receipt.runtime.serena.uvLock.path,
  ];
  if (
    runtimePaths.some(
      (runtimePath) => !isAbsolute(runtimePath) || contains(receipt.root, runtimePath),
    ) ||
    new Set(runtimePaths.map((runtimePath) => runtimePath.toLowerCase())).size !==
      runtimePaths.length
  ) {
    throw new Error("native registration ownership receipt has ambiguous runtime paths");
  }
  const trustedSerena = assertTrustedSerenaReceiptIdentity(
    receipt.runtime.serena,
    receipt.root,
    receipt.stateRoot,
  );
  const expectedOwnership = new Map<string, NativeRegistrationFile["ownership"]>([
    [".claude/settings.json", "json-array-children"],
    [".mcp.json", "json-object-children"],
    [".codex/hooks.json", "json-array-children"],
    [".codex/config.toml", "toml-block"],
  ]);
  if (
    new Set(receipt.files.map((file) => file.destination)).size !== receipt.files.length ||
    receipt.files.some((file) => expectedOwnership.get(file.destination) !== file.ownership)
  ) {
    throw new Error("native registration ownership receipt has ambiguous file ownership");
  }
  for (const file of receipt.files) {
    if (sha256(file.content) !== file.normalizedSha256)
      throw new Error("native registration receipt content hash is invalid");
  }
  const expectedFiles = nativeRegistrationFiles(
    registrationFromIdentities(
      receipt.root,
      receipt.stateRoot,
      receipt.runtime,
      trustedSerena.package,
    ),
  );
  if (!sameJson(receipt.files, expectedFiles)) {
    throw new Error("native registration receipt contradicts the reviewed native policy");
  }
  return { receipt, current };
}

function sameRegistration(
  receipt: RegistrationReceipt,
  registration: NativeEccRegistration,
  files: NativeRegistrationFile[],
): boolean {
  return (
    receipt.root === registration.root &&
    receipt.stateRoot === registration.stateRoot &&
    sameJson(receipt.runtime, registration.runtime) &&
    sameJson(receipt.files, files)
  );
}

export function planNativeEccRegistration(
  root: string,
  registration: NativeEccRegistration,
  operation: "install" | "update" | "repair" | "rollback" | "uninstall",
): Plan {
  const canonicalRoot = canonicalDirectory(root, "native registration root");
  if (registration.root !== canonicalRoot)
    throw new Error("native registration belongs to a foreign root");
  const files = nativeRegistrationFiles(registration);
  const found = parseReceipt(root);
  if (operation === "install") {
    if (found !== undefined) {
      if (!sameRegistration(found.receipt, registration, files))
        throw new Error("native registration receipt contradicts the requested registration");
      for (const file of files) assertInstalled(readCurrent(root, file.destination), file);
      return plan("ecc-profile: native registration install");
    }
    const actions: Action[] = [];
    for (const file of files) {
      const current = readCurrent(root, file.destination);
      const installed = installedContent(current, file);
      actions.push(
        writePinned(
          file.destination,
          installed,
          current,
          `register ECC profile in ${file.destination}`,
        ),
      );
    }
    const receipt = stableJson(receiptFor(registration, files));
    actions.push(
      writePinned(
        NATIVE_ECC_REGISTRATION_RECEIPT,
        receipt,
        undefined,
        "record native ECC registration ownership",
      ),
    );
    return plan("ecc-profile: native registration install", ...actions);
  }
  if (operation === "update") {
    if (found === undefined)
      throw new Error("native registration update requires an ownership receipt");
    if (sameRegistration(found.receipt, registration, files)) {
      for (const file of files) assertInstalled(readCurrent(root, file.destination), file);
      return plan("ecc-profile: native registration update");
    }
    const previous = new Map(found.receipt.files.map((file) => [file.destination, file]));
    const actions: Action[] = [];
    for (const file of files) {
      const current = readCurrent(root, file.destination);
      const prior = previous.get(file.destination);
      let base = current;
      if (prior !== undefined) {
        assertInstalled(current, prior);
        if (!current)
          throw new Error(`missing native registration destination: ${file.destination}`);
        const stripped =
          prior.ownership === "toml-block"
            ? removeManagedBlock(current.contents, NATIVE_REGISTRATION_SCOPE)
            : removeJsonFragment(current, prior);
        base = stripped.length === 0 ? undefined : { contents: stripped, sha256: sha256(stripped) };
      }
      const installed = installedContent(base, file);
      actions.push(
        writePinned(
          file.destination,
          installed,
          current,
          `update ECC registration in ${file.destination}`,
        ),
      );
      previous.delete(file.destination);
    }
    if (previous.size > 0)
      throw new Error(
        "native registration update cannot silently omit a previously managed destination",
      );
    actions.push(
      writePinned(
        NATIVE_ECC_REGISTRATION_RECEIPT,
        stableJson(receiptFor(registration, files)),
        found.current,
        "update native ECC registration ownership",
      ),
    );
    return plan("ecc-profile: native registration update", ...actions);
  }
  if (operation === "repair" || operation === "rollback") {
    if (found === undefined)
      throw new Error(`native registration ${operation} requires an ownership receipt`);
    const executable = runtimeFile(
      found.receipt.runtime.executable.path,
      "installed runtime executable",
    );
    const cliScript = runtimeFile(
      found.receipt.runtime.cliScript.path,
      "installed runtime CLI script",
    );
    const serena = serenaRuntimeIdentity(found.receipt.runtime.serena.root);
    if (
      !sameJson(
        { executable, cliScript, serena },
        {
          executable: found.receipt.runtime.executable,
          cliScript: found.receipt.runtime.cliScript,
          serena: found.receipt.runtime.serena,
        },
      )
    ) {
      throw new Error(
        "installed native registration runtime bytes contradict the ownership receipt; run update",
      );
    }
    const actions: Action[] = [];
    for (const file of found.receipt.files) {
      const current = readCurrent(root, file.destination);
      if (current === undefined) {
        actions.push(
          writePinned(
            file.destination,
            installedContent(undefined, file),
            undefined,
            `repair native ECC registration ${file.destination}`,
          ),
        );
      } else {
        assertInstalled(current, file);
      }
    }
    return plan(`ecc-profile: native registration ${operation}`, ...actions);
  }
  if (found === undefined) return plan("ecc-profile: native registration uninstall");
  if (!sameRegistration(found.receipt, registration, files))
    throw new Error("native registration receipt contradicts the requested registration");
  const actions: Action[] = [];
  for (const file of files) {
    const current = readCurrent(root, file.destination);
    assertInstalled(current, file);
    if (!current) continue;
    const stripped =
      file.ownership === "toml-block"
        ? removeManagedBlock(current.contents, NATIVE_REGISTRATION_SCOPE)
        : removeJsonFragment(current, file);
    actions.push(
      stripped.trim().length === 0
        ? remove(file.destination, `unregister ECC profile from ${file.destination}`, {
            expect: { sha256: current.sha256 },
          })
        : writePinned(
            file.destination,
            stripped,
            current,
            `unregister ECC profile from ${file.destination}`,
          ),
    );
  }
  actions.push(
    remove(NATIVE_ECC_REGISTRATION_RECEIPT, "remove native ECC registration receipt", {
      expect: { sha256: found.current.sha256 },
    }),
  );
  return plan("ecc-profile: native registration uninstall", ...actions);
}

export function planInstalledNativeEccRegistration(
  root: string,
  operation: "repair" | "rollback" | "uninstall",
): Plan {
  const found = parseReceipt(root);
  if (operation === "uninstall" && found === undefined) {
    return plan("ecc-profile: native registration uninstall");
  }
  if (found === undefined)
    throw new Error(`native registration ${operation} requires an ownership receipt`);
  // Installed operations use the authenticated receipt fragments, never current package rendering.
  return planInstalledRegistrationFromReceipt(root, found, operation);
}

function planInstalledRegistrationFromReceipt(
  root: string,
  found: { receipt: RegistrationReceipt; current: CurrentFile },
  operation: "repair" | "rollback" | "uninstall",
): Plan {
  if (operation === "repair" || operation === "rollback") {
    const executable = runtimeFile(
      found.receipt.runtime.executable.path,
      "installed runtime executable",
    );
    const cliScript = runtimeFile(
      found.receipt.runtime.cliScript.path,
      "installed runtime CLI script",
    );
    const serena = serenaRuntimeIdentity(found.receipt.runtime.serena.root);
    if (
      !sameJson(
        { executable, cliScript, serena },
        {
          executable: found.receipt.runtime.executable,
          cliScript: found.receipt.runtime.cliScript,
          serena: found.receipt.runtime.serena,
        },
      )
    ) {
      throw new Error(
        "installed native registration runtime bytes contradict the ownership receipt; run update",
      );
    }
    const actions: Action[] = [];
    for (const file of found.receipt.files) {
      const current = readCurrent(root, file.destination);
      if (current === undefined) {
        actions.push(
          writePinned(
            file.destination,
            installedContent(undefined, file),
            undefined,
            `repair native ECC registration ${file.destination}`,
          ),
        );
      } else assertInstalled(current, file);
    }
    return plan(`ecc-profile: native registration ${operation}`, ...actions);
  }
  const actions: Action[] = [];
  for (const file of found.receipt.files) {
    const current = readCurrent(root, file.destination);
    assertInstalled(current, file);
    if (!current) continue;
    const stripped =
      file.ownership === "toml-block"
        ? removeManagedBlock(current.contents, NATIVE_REGISTRATION_SCOPE)
        : removeJsonFragment(current, file);
    actions.push(
      stripped.trim().length === 0
        ? remove(file.destination, `unregister ECC profile from ${file.destination}`, {
            expect: { sha256: current.sha256 },
          })
        : writePinned(
            file.destination,
            stripped,
            current,
            `unregister ECC profile from ${file.destination}`,
          ),
    );
  }
  actions.push(
    remove(NATIVE_ECC_REGISTRATION_RECEIPT, "remove native ECC registration receipt", {
      expect: { sha256: found.current.sha256 },
    }),
  );
  return plan("ecc-profile: native registration uninstall", ...actions);
}
