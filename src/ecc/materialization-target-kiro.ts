import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { type BaselineTreeHash, hashComponentTree } from "../baseline-evidence/hash.js";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { EccComponentId } from "./components.js";
import {
  assertComponentSourcePath,
  assertEccMaterializationEvidenceBinding,
  assertMaterializedComponentId,
  assertOwnedRelativePath,
  destinationIdentity,
  displaySafe,
  ECC_KIRO_RUNTIME_COMPONENT_ID,
  type EccComponentProvenance,
  eccMaterializationAuthorizationSchema,
  MAX_MATERIALIZED_COMPONENTS,
  MAX_MATERIALIZED_FILE_BYTES,
  MAX_MATERIALIZED_FILES_PER_COMPONENT,
} from "./materialization-receipt.js";
import type { EccEffectiveSelectionComponent } from "./materialization-selection.js";
import { eccComponentSourcePaths } from "./materialize.js";

const SHA40 = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const ProvenanceSchema = z
  .object({
    repository: z.string().min(1).max(240).regex(REPOSITORY),
    commit: z.string().regex(SHA40),
    componentPath: z.string().min(1).max(1_024),
  })
  .strict();

const SelectedComponentSchema = z
  .object({
    id: z.string().min(3).max(160),
    authorization: eccMaterializationAuthorizationSchema,
    provenance: ProvenanceSchema,
  })
  .strict();

const HeldComponentSchema = z
  .object({
    componentId: z.string().min(3).max(160),
    routeCode: z.string().min(1).max(160),
    codes: z.array(z.string().min(1).max(160)).max(256),
    details: z.array(z.string().max(2_048)).max(256),
  })
  .strict();

const KiroProjectionRequestSchema = z
  .object({
    sourceRoot: z.string().min(1).max(4_096),
    components: z.array(SelectedComponentSchema).max(MAX_MATERIALIZED_COMPONENTS),
    evidence: z
      .object({
        authorizations: z
          .array(eccMaterializationAuthorizationSchema)
          .max(MAX_MATERIALIZED_COMPONENTS),
        held: z.array(HeldComponentSchema).max(MAX_MATERIALIZED_COMPONENTS),
      })
      .strict(),
  })
  .strict();

type ParsedComponent = z.infer<typeof SelectedComponentSchema>;
type ParsedRequest = z.infer<typeof KiroProjectionRequestSchema>;

export interface EccVerifiedKiroFile {
  path: string;
  kind: "copy-file";
  contents: Buffer;
  contentAuthorization: BaselineAuthorization;
  contentSourcePath: string;
}

export interface EccVerifiedKiroComponent extends EccEffectiveSelectionComponent {
  files: EccVerifiedKiroFile[];
}

export interface EccVerifiedKiroMaterialization {
  components: EccVerifiedKiroComponent[];
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw new Error(`governed Kiro materialization refused: ${message}`);
}

function parseRequest(request: unknown): ParsedRequest {
  const result = KiroProjectionRequestSchema.safeParse(request);
  if (!result.success) {
    return fail("unknown or malformed request fields");
  }
  return result.data;
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertSourceRoot(sourceRoot: string): void {
  if (!isAbsolute(sourceRoot)) fail("source root must be absolute");
  const inspected = inspectContainedRelativePath(sourceRoot, ".");
  if (inspected.state !== "present" || inspected.kind !== "directory") {
    fail("source root must be a real directory");
  }
}

function assertSelectedIdentity(component: ParsedComponent): void {
  const id = assertMaterializedComponentId(component.id);
  assertComponentSourcePath(component.provenance.componentPath);
  if (component.authorization.componentId !== id) {
    fail("selected authorization does not identify the selected component");
  }
  if (!sameRepository(component.authorization.source, component.provenance.repository)) {
    fail("selected authorization repository does not match provenance");
  }
  if (component.authorization.pinnedSha !== component.provenance.commit) {
    fail("selected authorization pin does not match provenance");
  }
}

function sameAuthorization(left: BaselineAuthorization, right: BaselineAuthorization): boolean {
  const leftAcceptance = left.acceptance;
  const rightAcceptance = right.acceptance;
  const acceptanceMatches =
    leftAcceptance === undefined && rightAcceptance === undefined
      ? true
      : leftAcceptance !== undefined && rightAcceptance !== undefined
        ? leftAcceptance.decisionId === rightAcceptance.decisionId &&
          leftAcceptance.recordSha256 === rightAcceptance.recordSha256 &&
          leftAcceptance.acceptedFindingCodes.length ===
            rightAcceptance.acceptedFindingCodes.length &&
          leftAcceptance.acceptedFindingCodes.every(
            (code, index) => code === rightAcceptance.acceptedFindingCodes[index],
          )
        : false;
  return (
    left.componentId === right.componentId &&
    left.source === right.source &&
    left.pinnedSha === right.pinnedSha &&
    left.treeSha256 === right.treeSha256 &&
    left.tier === right.tier &&
    left.issuer === right.issuer &&
    left.evidenceSha256 === right.evidenceSha256 &&
    left.effective === right.effective &&
    acceptanceMatches
  );
}

function assertCurrentSelectedEvidence(request: ParsedRequest, component: ParsedComponent): void {
  const held = request.evidence.held.filter((entry) => entry.componentId === component.id);
  const authorized = request.evidence.authorizations.filter(
    (entry) => entry.componentId === component.id,
  );
  if (held.length > 0 || authorized.length !== 1) {
    fail("selected component requires exactly one current unheld authorization");
  }
  if (
    !sameAuthorization(
      authorized[0] as BaselineAuthorization,
      component.authorization as BaselineAuthorization,
    )
  ) {
    fail("selected component authorization differs from current evidence");
  }
}

function runtimeAuthorization(request: ParsedRequest): BaselineAuthorization {
  const held = request.evidence.held.filter(
    (entry) => entry.componentId === ECC_KIRO_RUNTIME_COMPONENT_ID,
  );
  const authorized = request.evidence.authorizations.filter(
    (entry) => entry.componentId === ECC_KIRO_RUNTIME_COMPONENT_ID,
  );
  if (held.length > 0 || authorized.length !== 1) {
    fail("exactly one unheld runtime:ecc-kiro authorization is required");
  }
  return authorized[0] as BaselineAuthorization;
}

function assertCommonEvidenceIdentity(
  selected: BaselineAuthorization,
  runtime: BaselineAuthorization,
  provenance: EccComponentProvenance,
): void {
  if (
    !sameRepository(runtime.source, provenance.repository) ||
    !sameRepository(runtime.source, selected.source)
  ) {
    fail("selected and runtime evidence binding repositories do not match");
  }
  if (runtime.pinnedSha !== provenance.commit || runtime.pinnedSha !== selected.pinnedSha) {
    fail("selected and runtime evidence binding pins do not match");
  }
  if (runtime.evidenceSha256 !== selected.evidenceSha256) {
    fail("selected and runtime evidence binding verification digest does not match");
  }
  if (runtime.tier !== selected.tier) {
    fail("selected and runtime evidence binding tiers do not match");
  }
  if (runtime.issuer !== selected.issuer) {
    fail("selected and runtime evidence binding issuers do not match");
  }
}

function assertSupportedComponent(component: ParsedComponent): void {
  if (component.id === "baseline:rules") {
    if (component.provenance.componentPath !== "rules") {
      fail("baseline:rules provenance does not match the selected component");
    }
    return;
  }
  if (component.id.startsWith("skill:")) {
    const expected = `skills/${component.id.slice("skill:".length)}`;
    if (component.provenance.componentPath !== expected) {
      fail("skill provenance does not match the selected component");
    }
    return;
  }
  fail(`unsupported Kiro component ${displaySafe(component.id)}`);
}

function selectedTree(sourceRoot: string, component: ParsedComponent): BaselineTreeHash {
  let paths: string[];
  try {
    paths = eccComponentSourcePaths(component.id as EccComponentId);
  } catch {
    return fail("unsupported Kiro component");
  }
  let actual: BaselineTreeHash;
  try {
    actual = hashComponentTree(sourceRoot, paths);
  } catch {
    return fail("selected component tree could not be revalidated");
  }
  if (actual.treeSha256 !== component.authorization.treeSha256) {
    fail("selected component tree does not match its authorization");
  }
  return actual;
}

function runtimeTree(sourceRoot: string, authorization: BaselineAuthorization): BaselineTreeHash {
  let actual: BaselineTreeHash;
  try {
    actual = hashComponentTree(sourceRoot, [".kiro"]);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (actual.treeSha256 !== authorization.treeSha256) {
    fail("runtime Kiro tree does not match its authorization");
  }
  return actual;
}

function inspectDirectDirectory(sourceRoot: string, relative: string) {
  const inspected = inspectContainedRelativePath(sourceRoot, relative);
  if (inspected.state !== "present" || inspected.kind !== "directory") {
    fail("Kiro source directory is missing or unsafe");
  }
  try {
    return readdirSync(inspected.realPath, { withFileTypes: true }).sort((left, right) =>
      byCodeUnit(left.name, right.name),
    );
  } catch {
    return fail("Kiro source directory is unreadable");
  }
}

function expectedFile(runtime: BaselineTreeHash, path: string) {
  return runtime.files.find((file) => file.path === path);
}

function readExactRuntimeFile(sourceRoot: string, runtime: BaselineTreeHash, path: string): Buffer {
  const normalized = assertOwnedRelativePath(path);
  const expected = expectedFile(runtime, normalized);
  if (expected === undefined) fail("projected Kiro file is absent from runtime evidence");
  const inspected = inspectContainedRelativePath(sourceRoot, normalized);
  if (inspected.state !== "present" || inspected.kind !== "file" || inspected.stats.nlink !== 1) {
    fail("projected Kiro file is not a safe regular file");
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_MATERIALIZED_FILE_BYTES,
  });
  if (opened === undefined || opened.stats.nlink !== 1) {
    fail("projected Kiro file is unreadable or unsupported");
  }
  const digest = createHash("sha256").update(opened.contents).digest("hex");
  if (opened.contents.byteLength !== expected.bytes || digest !== expected.sha256) {
    fail("projected Kiro file changed after runtime verification");
  }
  return Buffer.from(opened.contents);
}

function projectedFile(
  sourceRoot: string,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
  path: string,
): EccVerifiedKiroFile {
  return {
    path,
    kind: "copy-file",
    contents: readExactRuntimeFile(sourceRoot, runtimeTreeHash, path),
    contentAuthorization: runtime,
    contentSourcePath: path,
  };
}

function skillFiles(
  sourceRoot: string,
  id: string,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
): EccVerifiedKiroFile[] {
  const name = id.slice("skill:".length);
  const relative = `.kiro/skills/${name}`;
  const entries = inspectDirectDirectory(sourceRoot, relative);
  if (entries.length !== 1 || entries[0]?.name !== "SKILL.md" || !entries[0].isFile()) {
    fail("Kiro skill must contain exactly one direct regular SKILL.md file");
  }
  return [projectedFile(sourceRoot, runtimeTreeHash, runtime, `${relative}/SKILL.md`)];
}

function steeringFiles(
  sourceRoot: string,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
): EccVerifiedKiroFile[] {
  const relative = ".kiro/steering";
  const entries = inspectDirectDirectory(sourceRoot, relative);
  if (
    entries.length === 0 ||
    entries.length > MAX_MATERIALIZED_FILES_PER_COMPONENT ||
    entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".md"))
  ) {
    fail("unsupported direct Kiro steering shape");
  }
  return entries.map((entry) =>
    projectedFile(sourceRoot, runtimeTreeHash, runtime, `${relative}/${entry.name}`),
  );
}

function componentFiles(
  sourceRoot: string,
  component: ParsedComponent,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
): EccVerifiedKiroFile[] {
  if (component.id === "baseline:rules") {
    return steeringFiles(sourceRoot, runtimeTreeHash, runtime);
  }
  if (component.id.startsWith("skill:")) {
    return skillFiles(sourceRoot, component.id, runtimeTreeHash, runtime);
  }
  return fail(`unsupported Kiro component ${displaySafe(component.id)}`);
}

export function foldedKiroProjectionCollision(
  paths: readonly string[],
): { first: string; second: string } | undefined {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const first = seen.get(destinationIdentity(path));
    if (first !== undefined) return { first, second: path };
    seen.set(destinationIdentity(path), path);
  }
  return undefined;
}

export function resolveVerifiedKiroMaterialization(
  request: unknown,
): EccVerifiedKiroMaterialization {
  const parsed = parseRequest(request);
  assertSourceRoot(parsed.sourceRoot);
  if (parsed.components.length === 0) return { components: [] };
  if (
    new Set(parsed.components.map((component) => component.id)).size !== parsed.components.length
  ) {
    fail("duplicate selected component id");
  }
  const runtime = runtimeAuthorization(parsed);
  const runtimeTreeHash = runtimeTree(parsed.sourceRoot, runtime);

  const selectedIds = new Set<string>();
  const components: EccVerifiedKiroComponent[] = [];
  for (const component of [...parsed.components].sort((left, right) =>
    byCodeUnit(left.id, right.id),
  )) {
    if (selectedIds.has(component.id)) fail("duplicate selected component id");
    selectedIds.add(component.id);
    assertSelectedIdentity(component);
    assertCurrentSelectedEvidence(parsed, component);
    assertSupportedComponent(component);
    assertCommonEvidenceIdentity(
      component.authorization as BaselineAuthorization,
      runtime,
      component.provenance,
    );
    selectedTree(parsed.sourceRoot, component);
    const files = componentFiles(parsed.sourceRoot, component, runtimeTreeHash, runtime);
    for (const file of files) {
      assertEccMaterializationEvidenceBinding({
        id: component.id,
        authorization: component.authorization,
        provenance: component.provenance,
        path: file.path,
        operation: file.kind,
        contentAuthorization: file.contentAuthorization,
        contentSourcePath: file.contentSourcePath,
      });
    }
    components.push({
      id: component.id as EccComponentId,
      authorization: component.authorization as BaselineAuthorization,
      provenance: component.provenance,
      files,
    });
  }

  const collision = foldedKiroProjectionCollision(
    components.flatMap((component) => component.files.map((file) => file.path)),
  );
  if (collision !== undefined) fail("projected Kiro destination collision");

  const after = runtimeTree(parsed.sourceRoot, runtime);
  if (after.treeSha256 !== runtimeTreeHash.treeSha256) {
    fail("runtime Kiro tree changed during projection");
  }
  return { components };
}
