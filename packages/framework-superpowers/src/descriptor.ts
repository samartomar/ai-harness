import { createHash } from "node:crypto";
import {
  AihError,
  type Cli,
  type FrameworkDescriptorBytesV1,
  type FrameworkEvidenceComponentV1,
  type FrameworkHookDeclarationV1,
  type FrameworkHookExecutionV1,
  type FrameworkHookHostControlNoneV1,
  type FrameworkHookInventoryV1,
  type FrameworkHookV1,
  parseNativeStrictJsonObjectV1,
} from "@aihq/core/framework-host";
import { PACKAGE_NAME, PACKAGE_VERSION, SUPPORTED_HOSTS, UPSTREAM } from "./identity.js";

/**
 * This plugin's own schema for the Superpowers framework descriptor Core loads
 * from Catalog (C1 `./catalog-framework-superpowers.json`). Core validates the
 * envelope it carries; the plugin validates every section it reads and refuses
 * anything it cannot accept. Sections the plugin does not read are ignored.
 *
 * Sections read:
 * - `vendorLock` (every operation): the pinned source identity and the
 *   component definitions the evidence gate verifies;
 * - `hookControlInventory` (hook operations only): the hooks recorded from the
 *   pinned tree, each declaration bound to a recorded source digest.
 */

export const DESCRIPTOR_FORMAT = "aih-catalog-framework-descriptor";
export const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;

export class SuperpowersDescriptorError extends AihError {
  constructor(problem: string) {
    super(`superpowers descriptor refused: ${problem}`, "AIH_FRAMEWORK_DESCRIPTOR");
  }
}

export interface SuperpowersDescriptor {
  readonly source: { readonly owner: string; readonly repo: string; readonly commit: string };
  readonly components: readonly FrameworkEvidenceComponentV1[];
  readonly sections: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined ? "missing" : typeof value;
}

function object(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SuperpowersDescriptorError(`${where} must be an object`);
  }
  return value as Json;
}

function onlyKeys(value: Json, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined)
    throw new SuperpowersDescriptorError(`${where} has unknown key ${extra}`);
}

function list(value: unknown, where: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new SuperpowersDescriptorError(`${where} must be an array of ${min} to ${max} entries`);
  }
  return value;
}

function text(value: unknown, where: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SuperpowersDescriptorError(`${where} is invalid (${show(value)})`);
  }
  return value;
}

/** Bounded single-line text without control characters. */
function visible(value: unknown, where: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new SuperpowersDescriptorError(
      `${where} must be visible text of at most ${max} characters`,
    );
  }
  return value;
}

/** A source-relative POSIX path that cannot escape or alias the source root. */
function sourcePath(value: unknown, where: string): string {
  const path = text(value, where, /^[A-Za-z0-9._\-/]{1,240}$/);
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SuperpowersDescriptorError(`${where} is not a contained source path (${show(path)})`);
  }
  return path;
}

function unique(values: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new SuperpowersDescriptorError(`${where} repeats ${value}`);
    seen.add(value);
  }
}

function components(lock: Json): FrameworkEvidenceComponentV1[] {
  const entries = list(lock.components, "vendorLock.components", 1, 64).map((raw, index) => {
    const where = `vendorLock.components[${index}]`;
    const component = object(raw, where);
    const id = text(component.id, `${where}.id`, /^(?:runtime|skill):[a-z0-9][a-z0-9-]{0,99}$/);
    const paths = list(component.paths, `${where}.paths`, 1, 32).map((path, pathIndex) =>
      sourcePath(path, `${where}.paths[${pathIndex}]`),
    );
    unique(paths, `${where}.paths`);
    return Object.freeze({
      id,
      paths: Object.freeze(paths),
      ...(id.startsWith("skill:") ? { skillContent: true as const } : {}),
    });
  });
  unique(
    entries.map((entry) => entry.id),
    "vendorLock.components",
  );
  return entries;
}

/** Validate the descriptor bytes Core loaded and read the pinned source and its components. */
export function readSuperpowersDescriptor(
  descriptor: FrameworkDescriptorBytesV1,
): SuperpowersDescriptor {
  if (descriptor.frameworkId !== "superpowers") {
    throw new SuperpowersDescriptorError(
      `the bytes are for framework ${show(descriptor.frameworkId)}`,
    );
  }
  const bytes = descriptor.bytes;
  if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new SuperpowersDescriptorError(`the descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256) {
    throw new SuperpowersDescriptorError(
      `the descriptor digest ${digest} does not match ${show(descriptor.sha256)} Core loaded`,
    );
  }
  let document: Json;
  try {
    document = parseNativeStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "superpowers descriptor",
    );
  } catch (error) {
    throw new SuperpowersDescriptorError(
      `the descriptor is not strict JSON (${(error as Error).message})`,
    );
  }
  onlyKeys(document, ["format", "version", "frameworkId", "sections"], "the descriptor");
  if (document.format !== DESCRIPTOR_FORMAT) {
    throw new SuperpowersDescriptorError(`the descriptor format is ${show(document.format)}`);
  }
  if (document.version !== 1) {
    throw new SuperpowersDescriptorError(`the descriptor version is ${show(document.version)}`);
  }
  if (document.frameworkId !== "superpowers") {
    throw new SuperpowersDescriptorError(
      `the descriptor names framework ${show(document.frameworkId)}`,
    );
  }
  const sections = object(document.sections, "sections");
  const lock = object(sections.vendorLock, "sections.vendorLock");
  if (lock.id !== "superpowers") {
    throw new SuperpowersDescriptorError(`vendorLock.id is ${show(lock.id)}`);
  }
  const owner = text(lock.owner, "vendorLock.owner", /^[A-Za-z0-9_.-]{1,100}$/);
  const repo = text(lock.repo, "vendorLock.repo", /^[A-Za-z0-9_.-]{1,100}$/);
  const commit = text(lock.pinnedSha, "vendorLock.pinnedSha", /^[0-9a-f]{40}$/);
  if (`${owner}/${repo}` !== UPSTREAM.repository || commit !== UPSTREAM.commit) {
    throw new SuperpowersDescriptorError(
      `Catalog pins ${owner}/${repo}@${commit}, but ${PACKAGE_NAME} ${PACKAGE_VERSION} supports ${UPSTREAM.repository}@${UPSTREAM.commit}`,
    );
  }
  return Object.freeze({
    source: Object.freeze({ owner, repo, commit }),
    components: Object.freeze(components(lock)),
    sections: Object.freeze({ ...sections }),
  });
}

const EXECUTIONS: readonly FrameworkHookExecutionV1[] = ["process", "in-process", "declarative"];

/** A host id Catalog may record for a host aih does not control (for example `muse`). */
const UNCONTROLLED_HOST = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Where a declaration's host is not one aih targets, the declaration is kept
 * (third-party inventory is never refused for its host) and carries
 * `hostControl: none`: aih does not install or configure that host, so a
 * disable is `unenforced` there, with the host's own controls as next route.
 */
function uncontrolledHost(host: string): FrameworkHookHostControlNoneV1 {
  return Object.freeze({
    kind: "none" as const,
    enforcement: "unenforced" as const,
    nextRoute: `aih does not control ${host}; use ${host}'s own plugin or hook controls to turn Superpowers hooks off there`,
  });
}

function declaration(
  raw: unknown,
  where: string,
  recordedSources: ReadonlySet<string>,
): FrameworkHookDeclarationV1 {
  const entry = object(raw, where);
  onlyKeys(entry, ["host", "sourcePath", "event", "matcher", "command", "execution"], where);
  const host = entry.host;
  if (typeof host !== "string" || !UNCONTROLLED_HOST.test(host)) {
    throw new SuperpowersDescriptorError(`${where}.host is not a host id (${show(host)})`);
  }
  const controlled = (SUPPORTED_HOSTS as readonly string[]).includes(host);
  const path = sourcePath(entry.sourcePath, `${where}.sourcePath`);
  if (!recordedSources.has(path)) {
    throw new SuperpowersDescriptorError(`${where}.sourcePath ${path} has no recorded digest`);
  }
  const execution = entry.execution;
  if (!EXECUTIONS.includes(execution as FrameworkHookExecutionV1)) {
    throw new SuperpowersDescriptorError(`${where}.execution is ${show(execution)}`);
  }
  return Object.freeze({
    host: controlled ? (host as Cli) : host,
    ...(controlled ? {} : { hostControl: uncontrolledHost(host) }),
    sourcePath: path,
    event: text(entry.event, `${where}.event`, /^[A-Za-z][A-Za-z0-9._]{0,127}$/),
    ...(entry.matcher === undefined
      ? {}
      : { matcher: visible(entry.matcher, `${where}.matcher`, 200) }),
    ...(entry.command === undefined
      ? {}
      : { command: visible(entry.command, `${where}.command`, 400) }),
    execution: execution as FrameworkHookExecutionV1,
  });
}

/** Validate and read the hook inventory. Only hook operations need it. */
export function readSuperpowersHookInventory(
  descriptor: SuperpowersDescriptor,
): FrameworkHookInventoryV1 {
  const raw = descriptor.sections.hookControlInventory;
  if (raw === undefined) {
    throw new SuperpowersDescriptorError(
      "sections.hookControlInventory is missing; hook inventory and hook controls need it",
    );
  }
  const inventory = object(raw, "sections.hookControlInventory");
  onlyKeys(inventory, ["provenance", "hooks"], "hookControlInventory");
  const provenance = object(inventory.provenance, "hookControlInventory.provenance");
  onlyKeys(provenance, ["repository", "commit", "component", "sources"], "provenance");
  if (
    provenance.repository !== UPSTREAM.repository ||
    provenance.commit !== descriptor.source.commit
  ) {
    throw new SuperpowersDescriptorError(
      `hook provenance ${show(provenance.repository)}@${show(provenance.commit)} is not the pinned source`,
    );
  }
  if (!descriptor.components.some((component) => component.id === provenance.component)) {
    throw new SuperpowersDescriptorError(
      `hook provenance names component ${show(provenance.component)} outside the pinned components`,
    );
  }
  const sources = list(provenance.sources, "provenance.sources", 1, 64).map((rawSource, index) => {
    const where = `provenance.sources[${index}]`;
    const source = object(rawSource, where);
    onlyKeys(source, ["path", "sha256"], where);
    text(source.sha256, `${where}.sha256`, /^[0-9a-f]{64}$/);
    return sourcePath(source.path, `${where}.path`);
  });
  unique(sources, "provenance.sources");
  const recorded = new Set(sources);
  const hooks = list(inventory.hooks, "hookControlInventory.hooks", 1, 16).map(
    (rawHook, index): FrameworkHookV1 => {
      const where = `hooks[${index}]`;
      const hook = object(rawHook, where);
      onlyKeys(hook, ["id", "event", "summary", "declarations", "upstreamControl"], where);
      const control = object(hook.upstreamControl, `${where}.upstreamControl`);
      onlyKeys(control, ["kind"], `${where}.upstreamControl`);
      if (control.kind !== "none") {
        throw new SuperpowersDescriptorError(
          `${where}.upstreamControl ${show(control.kind)} is not an upstream switch this plugin knows`,
        );
      }
      const declarations = list(hook.declarations, `${where}.declarations`, 1, 32).map(
        (rawDeclaration, declarationIndex) =>
          declaration(rawDeclaration, `${where}.declarations[${declarationIndex}]`, recorded),
      );
      unique(
        declarations.map((entry) => entry.host),
        `${where}.declarations hosts`,
      );
      return Object.freeze({
        id: text(hook.id, `${where}.id`, /^hook:[a-z0-9][a-z0-9-]{0,63}$/),
        event: text(hook.event, `${where}.event`, /^[A-Za-z][A-Za-z0-9]{0,63}$/),
        summary: visible(hook.summary, `${where}.summary`, 400),
        declarations: Object.freeze(declarations),
        upstreamControl: Object.freeze({ kind: "none" as const }),
      });
    },
  );
  unique(
    hooks.map((hook) => hook.id),
    "hookControlInventory.hooks",
  );
  return Object.freeze({
    frameworkId: "superpowers",
    upstream: Object.freeze({ repository: UPSTREAM.repository, commit: descriptor.source.commit }),
    hooks: Object.freeze(hooks),
  });
}
