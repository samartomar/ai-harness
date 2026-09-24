import { createHash } from "node:crypto";
import {
  AihError,
  type FrameworkDescriptorBytesV1,
  parseNativeStrictJsonObjectV1,
  z,
} from "@aihq/core/framework-host";
import {
  HOOK_CONTROL_SOURCE_CONTENT_SHA256,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  UPSTREAM,
} from "./identity.js";

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
 * - `hookControlInventory`: the reviewed hook inventory and ECC's profiles;
 * - `moduleGraph`, `profileGraph`: ECC's install modules and profiles;
 * - `installPreview`: the source-free install preview for dry runs.
 */

export const DESCRIPTOR_FORMAT = "aih-catalog-framework-descriptor";
export const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;

export const ECC_DESCRIPTOR_SECTIONS = Object.freeze([
  "vendorLock",
  "hookControlInventory",
  "moduleGraph",
  "profileGraph",
  "installPreview",
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

const HookProfileIdSchema = z.enum(["minimal", "standard", "strict"]);

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
                path: z.string().regex(/^[A-Za-z0-9._\-/]{1,240}$/),
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
      .length(3),
    hooks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9:-]{0,99}$/),
            event: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
            profiles: z.array(HookProfileIdSchema).min(1).max(3),
            disableEligible: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

export type EccHookProfile = z.infer<typeof HookProfileIdSchema>;
export type EccHookControlInventory = z.infer<typeof HookControlInventorySchema>;

/**
 * The reviewed ECC hook inventory. The provenance digest must equal the one
 * this plugin was reviewed against, which binds the 43 rows, the 42
 * disable-eligible ids and their 11/39/42 minimal/standard/strict eligibility
 * to ECC's pinned hook runtime and flag grammar.
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
  if (content !== provenance.contentSha256 || content !== HOOK_CONTROL_SOURCE_CONTENT_SHA256) {
    throw new EccDescriptorError(
      `hook provenance content ${content} is not the reviewed inventory ${HOOK_CONTROL_SOURCE_CONTENT_SHA256}`,
    );
  }
  if (inventory.profiles.map((profile) => profile.id).join(",") !== "minimal,standard,strict") {
    throw new EccDescriptorError(
      "hook profiles must be minimal, standard and strict in that order",
    );
  }
  const ids = new Set(inventory.hooks.map((hook) => hook.id));
  const eligible = inventory.hooks.filter((hook) => hook.disableEligible);
  const count = (profile: EccHookProfile) =>
    eligible.filter((hook) => hook.profiles.includes(profile)).length;
  if (
    inventory.hooks.length !== 43 ||
    ids.size !== 43 ||
    eligible.length !== 42 ||
    count("minimal") !== 11 ||
    count("standard") !== 39 ||
    count("strict") !== 42
  ) {
    throw new EccDescriptorError(
      "the reviewed inventory has 43 distinct rows, 42 disable-eligible ids and 11/39/42 profile eligibility",
    );
  }
  return inventory;
}
