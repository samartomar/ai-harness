import { createHash } from "node:crypto";
import {
  AihError,
  type FrameworkDescriptorBytesV1,
  type FrameworkHookHostControlNoneV1,
  parseNativeStrictJsonObjectV1,
  SUPPORTED_CLIS,
  z,
} from "@aihq/core/framework-host";
import { PACKAGE_NAME, PACKAGE_VERSION, UPSTREAM } from "./identity.js";

/**
 * This plugin's own schema for the ECC framework descriptor Core loads from
 * Catalog (C1 `./catalog-framework-ecc.json`, format
 * `aih-catalog-framework-descriptor` version 1). Core validates the envelope it
 * carries; the plugin validates every section it reads, when it reads it, and
 * refuses anything it cannot accept. Sections the plugin does not read are
 * ignored.
 *
 * Sections read:
 * - `vendorLock` (every operation): the pinned ECC source identity;
 * - `hookControlInventory`: the hook inventory, ECC's profiles and each hook's control;
 * - `moduleGraph`, `profileGraph`: ECC's install modules and profiles;
 * - `installPreview`: the source-free install preview for dry runs;
 * - `profileEvidence` (profile install and update only): the ECC profile and
 *   its evidence documents (`profile/descriptor-evidence.ts`).
 */

export const DESCRIPTOR_FORMAT = "aih-catalog-framework-descriptor";
export const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;

export const ECC_DESCRIPTOR_SECTIONS = Object.freeze([
  "vendorLock",
  "hookControlInventory",
  "moduleGraph",
  "profileGraph",
  "installPreview",
  "profileEvidence",
] as const);
export type EccDescriptorSection = (typeof ECC_DESCRIPTOR_SECTIONS)[number];

export class EccDescriptorError extends AihError {
  constructor(problem: string) {
    super(`ecc descriptor refused: ${problem}`, "AIH_FRAMEWORK_DESCRIPTOR");
  }
}

export interface EccDescriptor {
  readonly source: { readonly owner: string; readonly repo: string; readonly commit: string };
  /** Lowercase SHA-256 of the descriptor bytes Core loaded. */
  readonly sha256: string;
  readonly sections: Readonly<Record<string, unknown>>;
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined ? "missing" : typeof value;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EccDescriptorError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Validate the descriptor bytes Core loaded and read the pinned ECC source identity. */
export function readEccDescriptor(descriptor: FrameworkDescriptorBytesV1): EccDescriptor {
  if (descriptor.frameworkId !== "ecc") {
    throw new EccDescriptorError(`the bytes are for framework ${show(descriptor.frameworkId)}`);
  }
  const bytes = descriptor.bytes;
  if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new EccDescriptorError(`the descriptor exceeds ${MAX_DESCRIPTOR_BYTES} bytes`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256) {
    throw new EccDescriptorError(
      `the descriptor digest ${digest} does not match ${show(descriptor.sha256)} Core loaded`,
    );
  }
  let document: Record<string, unknown>;
  try {
    document = parseNativeStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "ecc descriptor",
    );
  } catch (error) {
    throw new EccDescriptorError(`the descriptor is not strict JSON (${(error as Error).message})`);
  }
  const extra = Object.keys(document).find(
    (key) => !["format", "version", "frameworkId", "sections"].includes(key),
  );
  if (extra !== undefined) throw new EccDescriptorError(`the descriptor has unknown key ${extra}`);
  if (document.format !== DESCRIPTOR_FORMAT) {
    throw new EccDescriptorError(`the descriptor format is ${show(document.format)}`);
  }
  if (document.version !== 1) {
    throw new EccDescriptorError(`the descriptor version is ${show(document.version)}`);
  }
  if (document.frameworkId !== "ecc") {
    throw new EccDescriptorError(`the descriptor names framework ${show(document.frameworkId)}`);
  }
  const sections = object(document.sections, "sections");
  const lock = object(sections.vendorLock, "sections.vendorLock");
  if (lock.id !== "ecc") throw new EccDescriptorError(`vendorLock.id is ${show(lock.id)}`);
  const owner = lock.owner;
  const repo = lock.repo;
  const commit = lock.pinnedSha;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof commit !== "string" ||
    `${owner}/${repo}` !== UPSTREAM.repository ||
    commit !== UPSTREAM.commit
  ) {
    throw new EccDescriptorError(
      `Catalog pins ${show(owner)}/${show(repo)}@${show(commit)}, but ${PACKAGE_NAME} ${PACKAGE_VERSION} supports ${UPSTREAM.repository}@${UPSTREAM.commit}`,
    );
  }
  return Object.freeze({
    source: Object.freeze({ owner, repo, commit }),
    sha256: digest,
    sections: Object.freeze({ ...sections }),
  });
}

/** One required section, or a refusal naming it. The caller validates its shape. */
export function eccDescriptorSectionOf(
  descriptor: EccDescriptor,
  section: EccDescriptorSection,
): unknown {
  const value = descriptor.sections[section];
  if (value === undefined) {
    throw new EccDescriptorError(`sections.${section} is missing`);
  }
  return value;
}

const HookProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/**
 * Where a hook is declared on one host, recorded from the pinned tree. The
 * host is a host aih targets or the id of a host aih does not control (for
 * example `muse`); the latter is kept, never refused (see {@link eccHostControl}).
 */
const HookDeclarationSchema = z
  .object({
    host: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    sourcePath: z.string().regex(/^[A-Za-z0-9._/-]{1,240}$/),
    event: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
    execution: z.enum(["process", "in-process", "declarative"]),
  })
  .strict();

/**
 * How a hook is turned off upstream:
 * - `claude-settings-env`: ECC's hook runtime skips it when `ECC_DISABLED_HOOKS`
 *   in the Claude settings environment lists it (the default for a row that
 *   declares no control and is disable-eligible);
 * - `none`: ECC has no switch for it (for example its OpenCode plugin), so a
 *   disable is recorded and labelled `unenforced` with a next route.
 */
const HookControlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude-settings-env") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const HookControlInventorySchema = z
  .object({
    provenance: z
      .object({
        repository: z.string(),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sources: z
          .array(
            z
              .object({
                path: z.string().regex(/^[A-Za-z0-9._/-]{1,240}$/),
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
              })
              .strict(),
          )
          .min(1)
          .max(64),
      })
      .strict(),
    profiles: z
      .array(z.object({ id: HookProfileIdSchema, label: z.string().min(1).max(40) }).strict())
      .min(1)
      .max(8),
    hooks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9:-]{0,99}$/),
            event: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
            profiles: z.array(HookProfileIdSchema).min(1).max(8),
            disableEligible: z.boolean(),
            declarations: z.array(HookDeclarationSchema).min(1).max(16).optional(),
            control: HookControlSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

export type EccHookControlInventory = z.infer<typeof HookControlInventorySchema>;
export type EccHookRow = EccHookControlInventory["hooks"][number];

/** ECC's own Claude hook file: the declaration of a row that records none. */
export const ECC_CLAUDE_HOOK_SOURCE = "hooks/hooks.json";

/** A row's declarations, defaulting to ECC's Claude `hooks/hooks.json`. */
export function eccHookDeclarations(hook: EccHookRow): NonNullable<EccHookRow["declarations"]> {
  return (
    hook.declarations ?? [
      {
        host: "claude",
        sourcePath: ECC_CLAUDE_HOOK_SOURCE,
        event: hook.event,
        execution: "process",
      },
    ]
  );
}

/**
 * For a declared host aih does not control: `hostControl: none`, labelled
 * `unenforced` with that host's own controls as the next route. Undefined for
 * a host aih targets.
 */
export function eccHostControl(host: string): FrameworkHookHostControlNoneV1 | undefined {
  if ((SUPPORTED_CLIS as readonly string[]).includes(host)) return undefined;
  return Object.freeze({
    kind: "none" as const,
    enforcement: "unenforced" as const,
    nextRoute: `aih does not control ${host}; use ${host}'s own plugin or hook controls to turn ECC hooks off there`,
  });
}

/** A row's control, defaulting to ECC's Claude settings switch for an eligible hook. */
export function eccHookControl(hook: EccHookRow): NonNullable<EccHookRow["control"]> {
  return hook.control ?? { kind: hook.disableEligible ? "claude-settings-env" : "none" };
}

/**
 * The hook inventory Catalog recorded from the pinned ECC tree. Nothing here is
 * specific to one ECC revision: the rows, profiles and eligibility are data. The
 * plugin checks that the data is self-consistent and bound to the pinned source:
 * provenance names the pinned repository and commit, its content digest is the
 * digest of its own source list, ids are unique, every row's profiles are
 * declared, and a claude-settings-env control is only on a disable-eligible row
 * declared for Claude.
 */
export function readEccHookControlInventory(descriptor: EccDescriptor): EccHookControlInventory {
  const parsed = HookControlInventorySchema.safeParse(
    eccDescriptorSectionOf(descriptor, "hookControlInventory"),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EccDescriptorError(
      `hookControlInventory is malformed${issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`}`,
    );
  }
  const inventory = parsed.data;
  const provenance = inventory.provenance;
  if (
    provenance.repository !== UPSTREAM.repository ||
    provenance.commit !== descriptor.source.commit
  ) {
    throw new EccDescriptorError(
      `hook provenance ${show(provenance.repository)}@${show(provenance.commit)} is not the pinned source`,
    );
  }
  const content = createHash("sha256")
    .update(JSON.stringify(provenance.sources.map(({ path, sha256 }) => [path, sha256])))
    .digest("hex");
  if (content !== provenance.contentSha256) {
    throw new EccDescriptorError(
      `hook provenance content digest ${provenance.contentSha256} is not the digest ${content} of its sources`,
    );
  }
  const profileIds = inventory.profiles.map((profile) => profile.id);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new EccDescriptorError("hook profiles repeat");
  }
  const ids = new Set<string>();
  for (const hook of inventory.hooks) {
    if (ids.has(hook.id)) throw new EccDescriptorError(`hook id ${hook.id} repeats`);
    ids.add(hook.id);
    const unknown = hook.profiles.find((profile) => !profileIds.includes(profile));
    if (unknown !== undefined) {
      throw new EccDescriptorError(`hook ${hook.id} names undeclared profile ${unknown}`);
    }
    if (
      eccHookControl(hook).kind === "claude-settings-env" &&
      (!hook.disableEligible ||
        !eccHookDeclarations(hook).some((declaration) => declaration.host === "claude"))
    ) {
      throw new EccDescriptorError(
        `hook ${hook.id} has ECC's Claude settings switch but is not a disable-eligible Claude hook`,
      );
    }
  }
  return inventory;
}
