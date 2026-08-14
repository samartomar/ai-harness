import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Node, parseTree } from "jsonc-parser";
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
const MAX_KIRO_AGENT_JSON_DEPTH = 100;

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

export interface VerifiedKiroMaterializationProof {
  state: "valid";
  path: string;
  kind: "copy-file";
  contents: Buffer;
  contentAuthorization: BaselineAuthorization;
  contentSourcePath: string;
  componentId: string;
  selectedAuthorization: BaselineAuthorization;
  provenance: EccComponentProvenance;
}

export interface InvalidKiroMaterializationProof {
  state: "invalid";
}

interface VerifiedKiroSnapshot extends Omit<VerifiedKiroMaterializationProof, "state"> {
  byteLength: number;
  sha256: string;
}

const VERIFIED_KIRO_FILES = new WeakMap<object, VerifiedKiroSnapshot>();

function cloneAuthorization(value: BaselineAuthorization): BaselineAuthorization {
  const clone: BaselineAuthorization = {
    ...value,
    ...(value.acceptance === undefined
      ? {}
      : {
          acceptance: {
            ...value.acceptance,
            acceptedFindingCodes: [...value.acceptance.acceptedFindingCodes],
          },
        }),
  };
  if (clone.acceptance !== undefined) {
    Object.freeze(clone.acceptance.acceptedFindingCodes);
    Object.freeze(clone.acceptance);
  }
  return Object.freeze(clone);
}

function cloneProvenance(value: EccComponentProvenance): EccComponentProvenance {
  return Object.freeze({ ...value });
}

function sameProvenance(left: EccComponentProvenance, right: EccComponentProvenance): boolean {
  return (
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.componentPath === right.componentPath
  );
}

function registerVerifiedKiroFile(
  file: EccVerifiedKiroFile,
  component: EccVerifiedKiroComponent,
): void {
  const contents = Buffer.from(file.contents);
  VERIFIED_KIRO_FILES.set(
    file,
    Object.freeze({
      path: file.path,
      kind: file.kind,
      contents,
      byteLength: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
      contentAuthorization: cloneAuthorization(file.contentAuthorization),
      contentSourcePath: file.contentSourcePath,
      componentId: component.id,
      selectedAuthorization: cloneAuthorization(component.authorization),
      provenance: cloneProvenance(component.provenance),
    }),
  );
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Runtime capability check for the generic engine boundary. It invokes no file
 * getters and returns fresh trusted copies from the private snapshot, so the
 * planner never consumes mutable caller fields after admission.
 */
export function verifiedKiroMaterializationProof(
  file: unknown,
  component: Pick<EccEffectiveSelectionComponent, "id" | "authorization" | "provenance">,
): VerifiedKiroMaterializationProof | InvalidKiroMaterializationProof | undefined {
  if (file === null || typeof file !== "object") return undefined;
  const snapshot = VERIFIED_KIRO_FILES.get(file);
  if (snapshot === undefined) return undefined;
  const path = ownDataProperty(file, "path");
  const kind = ownDataProperty(file, "kind");
  const contents = ownDataProperty(file, "contents");
  const contentAuthorization = ownDataProperty(file, "contentAuthorization");
  const contentSourcePath = ownDataProperty(file, "contentSourcePath");
  if (
    path !== snapshot.path ||
    kind !== snapshot.kind ||
    contentSourcePath !== snapshot.contentSourcePath ||
    !Buffer.isBuffer(contents) ||
    contents.byteLength !== snapshot.byteLength ||
    createHash("sha256").update(contents).digest("hex") !== snapshot.sha256 ||
    contentAuthorization === null ||
    typeof contentAuthorization !== "object" ||
    !sameAuthorization(
      contentAuthorization as BaselineAuthorization,
      snapshot.contentAuthorization,
    ) ||
    component.id !== snapshot.componentId ||
    !sameAuthorization(component.authorization, snapshot.selectedAuthorization) ||
    !sameProvenance(component.provenance, snapshot.provenance)
  ) {
    return { state: "invalid" };
  }
  return {
    state: "valid",
    path: snapshot.path,
    kind: snapshot.kind,
    contents: Buffer.from(snapshot.contents),
    contentAuthorization: cloneAuthorization(snapshot.contentAuthorization),
    contentSourcePath: snapshot.contentSourcePath,
    componentId: snapshot.componentId,
    selectedAuthorization: cloneAuthorization(snapshot.selectedAuthorization),
    provenance: cloneProvenance(snapshot.provenance),
  };
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
  if (component.id.startsWith("agent:")) {
    const expected = `agents/${component.id.slice("agent:".length)}.md`;
    if (component.provenance.componentPath !== expected) {
      fail("agent provenance does not match the selected component");
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

function expectedFile(tree: BaselineTreeHash, path: string) {
  return tree.files.find((file) => file.path === path);
}

function readExactVerifiedFile(sourceRoot: string, tree: BaselineTreeHash, path: string): Buffer {
  const normalized = assertOwnedRelativePath(path);
  const expected = expectedFile(tree, normalized);
  if (expected === undefined) fail("projected Kiro file is absent from its evidence tree");
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
    contents: readExactVerifiedFile(sourceRoot, runtimeTreeHash, path),
    contentAuthorization: runtime,
    contentSourcePath: path,
  };
}

function projectedSelectedFile(
  sourceRoot: string,
  selectedTreeHash: BaselineTreeHash,
  selected: BaselineAuthorization,
  sourcePath: string,
  destinationPath: string,
): EccVerifiedKiroFile {
  return {
    path: destinationPath,
    kind: "copy-file",
    contents: readExactVerifiedFile(sourceRoot, selectedTreeHash, sourcePath),
    contentAuthorization: selected,
    contentSourcePath: sourcePath,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertEmptyAgentRuntimeField(
  configuration: Record<string, unknown>,
  field: "hooks" | "mcpServers",
): void {
  if (!Object.hasOwn(configuration, field)) return;
  const value = configuration[field];
  if (!isPlainObject(value) || Object.keys(value).length !== 0) {
    fail(`Kiro agent ${field} configuration is outside governed materialization`);
  }
}

function assertNoDuplicateJsonKeys(text: string): void {
  const root = parseTree(text);
  if (root === undefined) {
    fail("Kiro agent configuration is not valid JSON");
  }
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === "object") {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const name = property.children?.[0]?.value;
        if (typeof name === "string") {
          if (seen.has(name)) {
            fail(`Kiro agent configuration contains duplicate key ${displaySafe(name)}`);
          }
          seen.add(name);
        }
        const value = property.children?.[1];
        if (value !== undefined) pending.push(value);
      }
      continue;
    }
    for (const child of node.children ?? []) pending.push(child);
  }
}

function assertBoundedJsonNesting(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_KIRO_AGENT_JSON_DEPTH) {
        fail("Kiro agent configuration exceeds the JSON nesting boundary");
      }
      continue;
    }
    if (character === "}" || character === "]") depth -= 1;
  }
}

function assertKiroAgentConfiguration(contents: Buffer, name: string): void {
  let text: string;
  let configuration: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    fail("Kiro agent configuration is not valid UTF-8");
  }
  assertBoundedJsonNesting(text);
  try {
    configuration = JSON.parse(text);
  } catch {
    fail("Kiro agent configuration is not valid JSON");
  }
  assertNoDuplicateJsonKeys(text);
  if (!isPlainObject(configuration) || configuration.name !== name) {
    fail("Kiro agent configuration identity does not match the selected component");
  }
  assertEmptyAgentRuntimeField(configuration, "mcpServers");
  assertEmptyAgentRuntimeField(configuration, "hooks");
  if (configuration.includeMcpJson === true || configuration.useLegacyMcpJson === true) {
    fail("Kiro agent MCP inheritance is outside governed materialization");
  }
}

function agentFiles(
  sourceRoot: string,
  component: ParsedComponent,
  selectedTreeHash: BaselineTreeHash,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
): EccVerifiedKiroFile[] {
  const id = component.id;
  const name = id.slice("agent:".length);
  const jsonPath = `.kiro/agents/${name}.json`;
  const markdownSourcePath = `agents/${name}.md`;
  const markdownDestinationPath = `.kiro/agents/${name}.md`;
  if (kiroAgentMappingState(sourceRoot, id) === "absent") {
    fail(`no pinned Kiro agent configuration exists for ${displaySafe(id)}`);
  }
  const json = projectedFile(sourceRoot, runtimeTreeHash, runtime, jsonPath);
  assertKiroAgentConfiguration(json.contents, name);
  return [
    json,
    projectedSelectedFile(
      sourceRoot,
      selectedTreeHash,
      component.authorization as BaselineAuthorization,
      markdownSourcePath,
      markdownDestinationPath,
    ),
  ];
}

export function kiroAgentMappingState(
  sourceRoot: string,
  id: string,
): "present" | "absent" | "unsafe" {
  if (!id.startsWith("agent:")) return "absent";
  const name = id.slice("agent:".length);
  const inspected = inspectContainedRelativePath(sourceRoot, `.kiro/agents/${name}.json`);
  if (inspected.state === "absent") return "absent";
  return inspected.state === "present" && inspected.kind === "file" && inspected.stats.nlink === 1
    ? "present"
    : "unsafe";
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
  selectedTreeHash: BaselineTreeHash,
  runtimeTreeHash: BaselineTreeHash,
  runtime: BaselineAuthorization,
): EccVerifiedKiroFile[] {
  if (component.id === "baseline:rules") {
    return steeringFiles(sourceRoot, runtimeTreeHash, runtime);
  }
  if (component.id.startsWith("skill:")) {
    return skillFiles(sourceRoot, component.id, runtimeTreeHash, runtime);
  }
  if (component.id.startsWith("agent:")) {
    return agentFiles(sourceRoot, component, selectedTreeHash, runtimeTreeHash, runtime);
  }
  return fail(`unsupported Kiro component ${displaySafe(component.id)}`);
}

/**
 * The semantic name Kiro assigns to a direct workspace agent definition.
 * JSON and Markdown are the two evidenced representations of that one name.
 * The lifecycle admits its exact owned pair and refuses any other sibling.
 */
export function kiroAgentSemanticIdentity(path: string): string | undefined {
  return /^\.kiro\/agents\/([^/]+)\.(?:json|md)$/.exec(destinationIdentity(path))?.[1];
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
    const selectedTreeHash = selectedTree(parsed.sourceRoot, component);
    const files = componentFiles(
      parsed.sourceRoot,
      component,
      selectedTreeHash,
      runtimeTreeHash,
      runtime,
    );
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
  for (const component of components) {
    for (const file of component.files) registerVerifiedKiroFile(file, component);
  }
  return { components };
}
