import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { z } from "@aihq/core/framework-host";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^\/?[a-z0-9][a-z0-9._:/-]*$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MANIFEST_PATHS = [
  "manifests/install-components.json",
  "manifests/install-modules.json",
  "manifests/install-profiles.json",
] as const;
const sourcePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const segments = value.split("/");
    const invalid =
      value.includes("\\") ||
      value.includes("\0") ||
      value.includes(":") ||
      value.startsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          WINDOWS_RESERVED.test(segment),
      ) ||
      posix.normalize(value) !== value;
    if (invalid)
      context.addIssue({ code: "custom", message: "hostile or non-portable source path" });
  });
const hashSchema = z.string().regex(SHA256);
const idSchema = z.string().regex(ID);
// Manifest pins are revision evidence: they come from Core-verified descriptor
// bytes and are bound to the pinned evidence and the source files, never to
// values embedded here.
const manifestPinSchema = z.object({ rawSha256: hashSchema, canonicalSha256: hashSchema }).strict();
const manifestPinsSchema = z
  .object({
    "manifests/install-components.json": manifestPinSchema,
    "manifests/install-modules.json": manifestPinSchema,
    "manifests/install-profiles.json": manifestPinSchema,
  })
  .strict();

const reviewReceiptSchema = z
  .object({
    id: z.string().min(1),
    evidencePath: sourcePathSchema,
    sourceCommit: z.string().regex(COMMIT),
    evidenceSha256: hashSchema,
  })
  .strict();
const ownershipSchema = z
  .object({
    sourcePin: z.string().regex(COMMIT),
    sourcePath: sourcePathSchema,
    normalizedHash: hashSchema,
    destination: sourcePathSchema,
    owner: z.literal("aih"),
    mergeStrategy: z.enum(["replace", "json-merge", "jsonc-merge", "toml-merge"]),
    previousHash: hashSchema.nullable(),
  })
  .strict();

export const eccProfileSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        repository: z.literal("affaan-m/ECC"),
        commit: z.string().regex(COMMIT, "source commit must be immutable"),
        package: z.literal("ecc-universal"),
        packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        releaseAncestorCommit: z.string().regex(COMMIT),
        componentPath: sourcePathSchema,
        sourceHash: hashSchema,
        normalizedHash: hashSchema,
        manifestPins: manifestPinsSchema,
        license: z.literal("MIT"),
        reviewReceipt: reviewReceiptSchema,
      })
      .strict(),
    selections: z
      .object({
        baseline: z.tuple([z.literal("core"), z.literal("lang:typescript")]),
        activeSkills: z.array(idSchema).length(23),
        warmReserveSkills: z.array(idSchema),
        coldReserve: z.literal("all-other-pinned-skills"),
      })
      .strict(),
    expected: z
      .object({
        skills: z.number().int().positive(),
        roles: z.number().int().positive(),
        workflows: z.number().int().positive(),
      })
      .strict(),
    profileFlags: z
      .object({
        defaultOn: z.tuple([
          z.literal("continuity"),
          z.literal("mcp-health"),
          z.literal("repository-protection"),
        ]),
        userOptIn: z.tuple([z.literal("learning"), z.literal("personal-observability")]),
        onDemand: z.tuple([z.literal("plan-canvas")]),
      })
      .strict(),
    mcpPolicy: z
      .object({
        selected: z.tuple([
          z.literal("code-review-graph"),
          z.literal("codebase-memory-mcp"),
          z.literal("context7"),
          z.literal("serena"),
        ]),
        disabled: z.tuple([
          z.literal("ecc-memory-mcp"),
          z.literal("github"),
          z.literal("sequential-thinking"),
          z.literal("token-savior"),
        ]),
        activation: z.literal("aih-owned-native-registration"),
      })
      .strict(),
    aihAdaptedWorkflows: z.tuple([
      z.literal("/auto-update"),
      z.literal("/hookify"),
      z.literal("/hookify-configure"),
      z.literal("/project-init"),
    ]),
    localPlannedSkills: z.tuple([z.literal("learn-eval"), z.literal("session-continuity")]),
    repoCuratedSkills: z.tuple([z.literal("aih-betterdoc"), z.literal("decision-partner")]),
    ownership: z.array(ownershipSchema).min(1),
    state: z.object({ schemaVersion: z.literal(1), lifecycle: z.literal("active") }).strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const active = new Set(profile.selections.activeSkills);
    if (
      new Set([...profile.selections.activeSkills, ...profile.selections.warmReserveSkills])
        .size !==
      active.size + profile.selections.warmReserveSkills.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selections"],
        message: "active and warm-reserve skill sets overlap",
      });
    }
    if (new Set(profile.selections.activeSkills).size !== profile.selections.activeSkills.length) {
      context.addIssue({
        code: "custom",
        path: ["selections", "activeSkills"],
        message: "active skills must be unique",
      });
    }
    const destinations = profile.ownership.map((item) => item.destination);
    if (new Set(destinations).size !== destinations.length) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "ambiguous ownership destination",
      });
    }
    for (const [index, item] of profile.ownership.entries()) {
      if (item.sourcePin !== profile.source.commit) {
        context.addIssue({
          code: "custom",
          path: ["ownership", index, "sourcePin"],
          message: "ownership sourcePin contradicts profile source commit",
        });
      }
      if (
        item.sourcePath === profile.source.componentPath &&
        item.normalizedHash !== profile.source.normalizedHash
      ) {
        context.addIssue({
          code: "custom",
          path: ["ownership", index, "normalizedHash"],
          message: "ownership hash contradicts profile source hash",
        });
      }
    }
    if (profile.source.reviewReceipt.sourceCommit !== profile.source.commit) {
      context.addIssue({
        code: "custom",
        path: ["source", "reviewReceipt"],
        message: "review receipt contradicts profile source commit",
      });
    }
  });

export type EccProfile = z.infer<typeof eccProfileSchema>;

/** The ECC workflows aih adapts instead of projecting upstream bodies. */
export const AIH_ADAPTED_WORKFLOWS = [
  "/auto-update",
  "/hookify",
  "/hookify-configure",
  "/project-init",
] as const;

/*
 * The pinned evidence is aih's reduced projection of ECC's install manifests:
 * every supported field is modelled and every object is strict, so an unknown
 * key anywhere is refused rather than stripped or carried into the canonical
 * payload hash.
 */
const moduleSchema = z
  .object({
    id: idSchema,
    kind: z.string().min(1),
    paths: z.array(sourcePathSchema),
    dependencies: z.array(idSchema),
  })
  .strict();
export const eccPinnedEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    source: z
      .object({
        repository: z.literal("affaan-m/ECC"),
        commit: z.string().regex(COMMIT),
        package: z.literal("ecc-universal"),
        packageVersion: z.string(),
        releaseAncestorCommit: z.string().regex(COMMIT),
        license: z.literal("MIT"),
        licensePath: sourcePathSchema,
        manifestHashes: z.record(sourcePathSchema, hashSchema),
        manifestPayloadHashes: z.record(sourcePathSchema, hashSchema),
      })
      .strict(),
    reviewReceipt: reviewReceiptSchema,
    profilesManifest: z
      .object({
        version: z.literal(1),
        profiles: z.record(idSchema, z.object({ modules: z.array(idSchema) }).strict()),
      })
      .strict(),
    componentsManifest: z
      .object({
        version: z.literal(1),
        components: z.array(
          z
            .object({ id: idSchema, family: z.string().min(1), modules: z.array(idSchema) })
            .strict(),
        ),
      })
      .strict(),
    modulesManifest: z.object({ version: z.literal(1), modules: z.array(moduleSchema) }).strict(),
    availableSkillPaths: z.array(sourcePathSchema),
    agentPaths: z.array(sourcePathSchema),
    workflowPaths: z.array(sourcePathSchema),
  })
  .strict();
const evidenceSchema = eccPinnedEvidenceSchema;
type PinnedEvidence = z.infer<typeof evidenceSchema>;

export interface ResolvedEntry {
  id: string;
  sourcePath: string;
  owner: "upstream" | "aih-adaptation";
}
export interface ResolvedSkill extends ResolvedEntry {
  selection: "baseline" | "leaf";
}
export interface ResolvedEccProfile {
  source: EccProfile["source"];
  modules: string[];
  skills: ResolvedSkill[];
  roles: ResolvedEntry[];
  workflows: ResolvedEntry[];
  consumedSourcePaths: string[];
}

function ordered(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function assertUniquePaths(groups: readonly (readonly string[])[]): void {
  const paths = groups.flatMap((group) => [...group]);
  if (new Set(paths).size !== paths.length)
    throw new Error("ambiguous duplicate source path in pinned evidence");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertDerivedIdentities(paths: readonly string[], namespace: "agents" | "commands"): void {
  const pattern = namespace === "agents" ? /^agents\/[^/]+\.md$/ : /^commands\/[^/]+\.md$/;
  if (paths.some((sourcePath) => !pattern.test(sourcePath)))
    throw new Error(`${namespace} source path is outside the expected namespace`);
  const ids = paths.map((sourcePath) => posix.basename(sourcePath, ".md"));
  if (new Set(ids).size !== ids.length)
    throw new Error(`ambiguous derived ${namespace} identity in pinned evidence`);
}

export function assertPortableSourcePath(sourcePath: string): string {
  return sourcePathSchema.parse(sourcePath);
}

export function checkedRoot(rootInput: string, label: string): string {
  if (!isAbsolute(rootInput)) throw new Error(`${label} must be an absolute path`);
  let stat: Stats;
  try {
    stat = lstatSync(rootInput);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} must be a real directory`);
  return realpathSync(rootInput);
}

export function checkedPath(
  root: string,
  sourcePath: string,
  expectedType: "file" | "directory",
  label: string,
): string {
  let current = root;
  for (const segment of sourcePath.split("/")) {
    current = resolve(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(
        `${label} is missing or unreadable: ${sourcePath} (${(error as Error).message})`,
      );
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} uses a symbolic link: ${sourcePath}`);
    const actual = realpathSync(current);
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))
      throw new Error(`${label} escapes its trusted root: ${sourcePath}`);
    current = actual;
  }
  const finalStat = lstatSync(current);
  if (expectedType === "file" && (!finalStat.isFile() || finalStat.nlink > 1))
    throw new Error(`${label} must be a regular non-linked file: ${sourcePath}`);
  if (expectedType === "directory" && !finalStat.isDirectory())
    throw new Error(`${label} must be a directory: ${sourcePath}`);
  return current;
}

function resolveBase(
  profileInput: unknown,
  evidenceInput: unknown,
  verifyEmbeddedPayloads = true,
): ResolvedEccProfile {
  const profile = eccProfileSchema.parse(profileInput);
  const evidence: PinnedEvidence = evidenceSchema.parse(evidenceInput);
  if (
    evidence.source.repository !== profile.source.repository ||
    evidence.source.commit !== profile.source.commit ||
    evidence.source.package !== profile.source.package ||
    evidence.source.packageVersion !== profile.source.packageVersion ||
    evidence.source.releaseAncestorCommit !== profile.source.releaseAncestorCommit ||
    evidence.source.license !== profile.source.license
  )
    throw new Error("pinned evidence contradicts profile source metadata");
  if (
    evidence.reviewReceipt.id !== profile.source.reviewReceipt.id ||
    evidence.reviewReceipt.evidencePath !== profile.source.reviewReceipt.evidencePath ||
    evidence.reviewReceipt.sourceCommit !== profile.source.reviewReceipt.sourceCommit ||
    evidence.reviewReceipt.evidenceSha256 !== profile.source.reviewReceipt.evidenceSha256
  )
    throw new Error("review receipt contradicts pinned evidence");
  if (profile.source.componentPath !== "manifests/install-components.json")
    throw new Error("componentPath contradicts pinned manifest evidence");
  const componentHash = evidence.source.manifestHashes[profile.source.componentPath];
  if (
    ordered(Object.keys(evidence.source.manifestHashes)).join("\n") !==
      ordered(MANIFEST_PATHS).join("\n") ||
    ordered(Object.keys(evidence.source.manifestPayloadHashes)).join("\n") !==
      ordered(MANIFEST_PATHS).join("\n")
  )
    throw new Error("pinned evidence must declare exactly the consumed manifests");
  for (const sourcePath of MANIFEST_PATHS) {
    const pin = profile.source.manifestPins[sourcePath];
    if (
      evidence.source.manifestHashes[sourcePath] !== pin.rawSha256 ||
      evidence.source.manifestPayloadHashes[sourcePath] !== pin.canonicalSha256
    )
      throw new Error(`evidence contradicts trusted manifest pin: ${sourcePath}`);
  }
  if (
    componentHash !== profile.source.sourceHash ||
    componentHash !== profile.source.normalizedHash
  ) {
    throw new Error("profile source hashes contradict pinned component manifest");
  }
  const payloads = {
    "manifests/install-components.json": evidence.componentsManifest,
    "manifests/install-modules.json": evidence.modulesManifest,
    "manifests/install-profiles.json": evidence.profilesManifest,
  } as const;
  for (const [sourcePath, payload] of Object.entries(payloads)) {
    if (
      verifyEmbeddedPayloads &&
      sha256(canonicalJson(payload)) !==
        profile.source.manifestPins[sourcePath as (typeof MANIFEST_PATHS)[number]].canonicalSha256
    )
      throw new Error(`embedded manifest payload hash mismatch: ${sourcePath}`);
  }

  const modules = new Map(evidence.modulesManifest.modules.map((module) => [module.id, module]));
  if (modules.size !== evidence.modulesManifest.modules.length)
    throw new Error("duplicate module id in pinned evidence");
  const core = evidence.profilesManifest.profiles.core;
  const language = evidence.componentsManifest.components.find(
    (component) => component.id === "lang:typescript",
  );
  if (!core || !language)
    throw new Error("pinned manifests omit core or lang:typescript selection");
  const closure = new Set([...core.modules, ...language.modules]);
  for (const id of closure) {
    const module = modules.get(id);
    if (!module) throw new Error(`selected module is missing: ${id}`);
    for (const dependency of module.dependencies) closure.add(dependency);
  }
  const moduleIds = ordered(closure);
  const baselinePaths = ordered(
    new Set(
      moduleIds.flatMap((id) =>
        modules.get(id)?.kind === "skills" ? (modules.get(id)?.paths ?? []) : [],
      ),
    ),
  );
  if (baselinePaths.length !== 117)
    throw new Error(`baseline skill accounting expected 117, received ${baselinePaths.length}`);
  const availableSkillPaths = new Set(evidence.availableSkillPaths);
  if (
    evidence.availableSkillPaths.some(
      (sourcePath) => !/^skills\/[a-z0-9][a-z0-9._-]*$/.test(sourcePath),
    ) ||
    availableSkillPaths.size !== evidence.availableSkillPaths.length
  )
    throw new Error("ambiguous selected skill inventory path");
  const leafPaths = profile.selections.activeSkills.map((id) => {
    const sourcePath = `skills/${id}`;
    if (!availableSkillPaths.has(sourcePath))
      throw new Error(`selected leaf is absent from pinned skill inventory: ${id}`);
    return sourcePath;
  });
  const skillPaths = ordered(new Set([...baselinePaths, ...leafPaths]));
  if (skillPaths.length !== profile.expected.skills)
    throw new Error(
      `skill accounting expected ${profile.expected.skills}, received ${skillPaths.length}`,
    );
  if (evidence.agentPaths.length !== profile.expected.roles)
    throw new Error(
      `role accounting expected ${profile.expected.roles}, received ${evidence.agentPaths.length}`,
    );
  if (evidence.workflowPaths.length !== profile.expected.workflows)
    throw new Error(
      `workflow accounting expected ${profile.expected.workflows}, received ${evidence.workflowPaths.length}`,
    );
  assertDerivedIdentities(evidence.agentPaths, "agents");
  assertDerivedIdentities(evidence.workflowPaths, "commands");
  assertUniquePaths([skillPaths, evidence.agentPaths, evidence.workflowPaths]);

  const adapted = new Set<string>(profile.aihAdaptedWorkflows);
  const skills = skillPaths.map((sourcePath) => ({
    id: posix.basename(sourcePath),
    sourcePath,
    owner: "upstream" as const,
    selection: leafPaths.includes(sourcePath) ? ("leaf" as const) : ("baseline" as const),
  }));
  const roles = ordered(evidence.agentPaths).map((sourcePath) => ({
    id: posix.basename(sourcePath, ".md"),
    sourcePath,
    owner: "upstream" as const,
  }));
  const workflows = ordered(evidence.workflowPaths).map((sourcePath) => {
    const id = `/${posix.basename(sourcePath, ".md")}`;
    return {
      id,
      sourcePath,
      owner: adapted.has(id) ? ("aih-adaptation" as const) : ("upstream" as const),
    };
  });
  const actualAdapted = workflows
    .filter((item) => item.owner === "aih-adaptation")
    .map((item) => item.id);
  if (actualAdapted.length !== profile.aihAdaptedWorkflows.length)
    throw new Error("adapted workflow is missing from pinned evidence");

  const manifestPaths = Object.keys(evidence.source.manifestHashes);
  const modulePaths = moduleIds.flatMap((id) => modules.get(id)?.paths ?? []);
  const consumedSourcePaths = ordered(
    new Set([
      evidence.source.licensePath,
      ...manifestPaths,
      ...modulePaths,
      ...skillPaths,
      ...evidence.agentPaths,
      ...evidence.workflowPaths,
    ]),
  );
  return {
    source: profile.source,
    modules: moduleIds,
    skills,
    roles,
    workflows,
    consumedSourcePaths,
  };
}

export function deriveEccProfile(profile: unknown, evidence: unknown): ResolvedEccProfile {
  return resolveBase(profile, evidence);
}

export async function resolveEccProfile(
  profile: unknown,
  evidence: unknown,
  options: { sourceRoot: string; evidenceRoot: string },
): Promise<ResolvedEccProfile> {
  const parsedProfile = eccProfileSchema.parse(profile);
  const parsedEvidence: PinnedEvidence = evidenceSchema.parse(evidence);
  const derived = resolveBase(parsedProfile, parsedEvidence);
  const sourceRoot = checkedRoot(options.sourceRoot, "ECC source root");
  const evidenceRoot = checkedRoot(options.evidenceRoot, "ECC evidence root");

  const receiptPath = checkedPath(
    evidenceRoot,
    parsedProfile.source.reviewReceipt.evidencePath,
    "file",
    "review receipt",
  );
  const receiptHash = sha256(readFileSync(receiptPath));
  if (receiptHash !== parsedProfile.source.reviewReceipt.evidenceSha256)
    throw new Error("review receipt content hash does not match the trusted profile");

  const filePaths = new Set([
    parsedEvidence.source.licensePath,
    ...MANIFEST_PATHS,
    ...parsedEvidence.agentPaths,
    ...parsedEvidence.workflowPaths,
  ]);
  for (const sourcePath of derived.consumedSourcePaths) {
    checkedPath(
      sourceRoot,
      sourcePath,
      filePaths.has(sourcePath) || posix.extname(sourcePath) !== "" ? "file" : "directory",
      "declared source path",
    );
  }

  const manifests = MANIFEST_PATHS.map((sourcePath) => {
    const manifestPath = checkedPath(sourceRoot, sourcePath, "file", "source manifest");
    const bytes = readFileSync(manifestPath);
    if (sha256(bytes) !== parsedProfile.source.manifestPins[sourcePath].rawSha256)
      throw new Error(`source manifest hash mismatch: ${sourcePath}`);
    return [
      sourcePath,
      reduceUpstreamManifest(sourcePath, JSON.parse(bytes.toString("utf8"))),
    ] as const;
  });
  const manifestByPath = new Map(manifests);
  return resolveBase(
    parsedProfile,
    {
      ...parsedEvidence,
      componentsManifest: manifestByPath.get("manifests/install-components.json"),
      modulesManifest: manifestByPath.get("manifests/install-modules.json"),
      profilesManifest: manifestByPath.get("manifests/install-profiles.json"),
    },
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

/**
 * Project a raw upstream manifest, already authenticated by its raw SHA-256
 * pin, onto the modelled evidence fields. Upstream-only descriptive fields
 * (descriptions, targets, cost, stability) are deliberately not consumed; the
 * strict evidence schema then validates every field that is.
 */
function reduceUpstreamManifest(
  sourcePath: (typeof MANIFEST_PATHS)[number],
  raw: unknown,
): unknown {
  switch (sourcePath) {
    case "manifests/install-profiles.json": {
      const manifest = pick(raw, ["version", "profiles"]);
      if (!isRecord(manifest) || !isRecord(manifest.profiles)) return manifest;
      return {
        ...manifest,
        profiles: Object.fromEntries(
          Object.entries(manifest.profiles).map(([id, entry]) => [id, pick(entry, ["modules"])]),
        ),
      };
    }
    case "manifests/install-components.json": {
      const manifest = pick(raw, ["version", "components"]);
      if (!isRecord(manifest) || !Array.isArray(manifest.components)) return manifest;
      return {
        ...manifest,
        components: manifest.components.map((entry) => pick(entry, ["id", "family", "modules"])),
      };
    }
    case "manifests/install-modules.json": {
      const manifest = pick(raw, ["version", "modules"]);
      if (!isRecord(manifest) || !Array.isArray(manifest.modules)) return manifest;
      return {
        ...manifest,
        modules: manifest.modules.map((entry) =>
          pick(entry, ["id", "kind", "paths", "dependencies"]),
        ),
      };
    }
  }
}

export function serializeResolvedEccProfile(profile: ResolvedEccProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
