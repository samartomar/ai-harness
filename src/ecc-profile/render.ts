import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type EccProfile,
  eccProfileSchema,
  type ResolvedEntry,
  type ResolvedSkill,
  resolveEccProfile,
} from "./index.js";
import {
  type ClaudeRolePolicy,
  claudeRolePolicy,
  claudeRoleTools,
  normalizeCodexRoleBody,
  normalizeCodexRoleDescription,
  normalizeCodexSkillBody,
  normalizeCodexWorkflowBody,
  normalizeCodexWorkflowDescription,
  type SkillTransport,
  skillProjectionPolicies,
  type WorkflowTransport,
  workflowProjectionPolicies,
} from "./projection-policy.js";
import {
  acquireProjectionSourceClosure,
  type ProjectionSourceTrust,
  TRUSTED_PROJECTED_SOURCE,
  type VerifiedProjectedSource,
  type VerifiedProjectionSourceClosure,
} from "./source-closure.js";

export { PROJECTED_SOURCE_LIMITS, type ProjectionSourceTrust } from "./source-closure.js";

type CapabilityOwner = ResolvedEntry["owner"];
type MergeStrategy = "replace" | "toml-merge";
type OutputMode = "100644" | "100755";

export interface ProjectedEntry extends ResolvedEntry {
  destination: string;
}

export interface ProjectedRole extends ProjectedEntry {
  policy: ClaudeRolePolicy;
}

export interface ProjectedSkill extends ResolvedSkill {
  destination: string;
  transport: SkillTransport;
  unavailableReason?: string;
  fallback?: string;
}

export interface ProjectedWorkflow extends ProjectedEntry {
  transport: WorkflowTransport;
  unavailableReason?: string;
  fallback?: string;
}

export interface ClientProjection {
  client: "claude" | "codex";
  skills: ProjectedSkill[];
  roles: ProjectedRole[];
  workflows: ProjectedWorkflow[];
}

interface PinnedFileProvenance {
  kind: "pinned-file";
  sourcePin: string;
  path: string;
  rawSha256: string;
  fileType: "regular";
  mode: OutputMode;
}

interface DerivedProvenance {
  kind: "derived";
  sourcePin: string;
  derivation: "codex-agent-registry";
  aggregateSha256: string;
  inputs: Array<{ path: string; rawSha256: string }>;
}

export interface RenderedProjectionFile {
  provenance: PinnedFileProvenance | DerivedProvenance;
  normalizedSha256: string;
  destination: string;
  owner: "aih";
  capabilityOwner: CapabilityOwner;
  mergeStrategy: MergeStrategy;
  previousHash: null;
  mode: OutputMode;
  content: string;
}

export interface EccProjection {
  version: 1;
  source: EccProfile["source"];
  sourceClosure: {
    id: string;
    aggregateSha256: string;
    fileCount: number;
    totalBytes: number;
  };
  clients: {
    claude: ClientProjection;
    codex: ClientProjection;
  };
  files: RenderedProjectionFile[];
}

interface MarkdownSource {
  attributes: Record<string, unknown>;
  description: string;
  body: string;
}

const ADAPTATIONS: Record<string, { description: string; body: string }> = {
  "/auto-update": {
    description: "Preview an exact-pin ECC profile update through the AIH lifecycle.",
    body: [
      "# Auto Update",
      "",
      "AIH-owned adaptation: require an immutable candidate pin, review the source and normalized diff, verify ownership, and produce a rollback-capable preview.",
      "",
      "Never follow moving main, overwrite operator-owned configuration, or publish merely because the update workflow was invoked.",
    ].join("\n"),
  },
  "/hookify": {
    description: "Design an AIH composite-hook capability without activating an upstream registry.",
    body: [
      "# Hookify",
      "",
      "AIH-owned adaptation: translate the requested behavior into one client-native normalizer and one AIH composite-dispatcher handler proposal.",
      "",
      "Do not create raw Claude Hookify state, register hooks, or mutate unmanaged client settings in this workflow.",
    ].join("\n"),
  },
  "/hookify-configure": {
    description: "Configure only AIH-owned composite-hook profile intent.",
    body: [
      "# Hookify Configure",
      "",
      "AIH-owned adaptation: change only the AIH profile manifest intent for a known composite-hook handler.",
      "",
      "Do not edit an unmanaged hook registry or treat upstream hook configuration as active ownership.",
    ].join("\n"),
  },
  "/project-init": {
    description:
      "Plan project initialization and route apply through the AIH projection lifecycle.",
    body: [
      "# Project Init",
      "",
      "AIH-owned adaptation: preserve the upstream planning workflow, but route every projected change through preview, ownership checks, and the later AIH lifecycle apply boundary.",
      "",
      "Planning is available here; direct project mutation or client activation is not.",
    ].join("\n"),
  },
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(bytes: Uint8Array, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  const normalized = decoded
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "");
  if (normalized.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  return `${normalized}\n`;
}

function parseMarkdownSource(
  content: string,
  label: string,
  expectedName?: string,
): MarkdownSource {
  const lines = content.split("\n");
  if (lines[0] !== "---") throw new Error(`${label} is missing YAML frontmatter`);
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new Error(`${label} has unterminated YAML frontmatter`);
  const parsed = parseYaml(lines.slice(1, closing).join("\n"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} frontmatter must be a mapping`);
  const attributes = parsed as Record<string, unknown>;
  if (typeof attributes.description !== "string" || attributes.description.trim() === "")
    throw new Error(`${label} must declare a description`);
  if (expectedName && attributes.name !== expectedName)
    throw new Error(`${label} declares an ambiguous identity`);
  const body = `${lines
    .slice(closing + 1)
    .join("\n")
    .trim()}\n`;
  if (body.trim() === "") throw new Error(`${label} has no instruction body`);
  return {
    attributes,
    description: attributes.description.replace(/\s+/g, " ").trim(),
    body,
  };
}

function pinnedRenderedFile(
  sourcePin: string,
  source: VerifiedProjectedSource,
  destination: string,
  content: string,
  capabilityOwner: CapabilityOwner,
  options: { mode?: OutputMode; mergeStrategy?: MergeStrategy } = {},
): RenderedProjectionFile {
  return {
    provenance: {
      kind: "pinned-file",
      sourcePin,
      path: source.path,
      rawSha256: source.rawSha256,
      fileType: source.fileType,
      mode: source.mode,
    },
    normalizedSha256: sha256(content),
    destination,
    owner: "aih",
    capabilityOwner,
    mergeStrategy: options.mergeStrategy ?? "replace",
    previousHash: null,
    mode: options.mode ?? source.mode,
    content,
  };
}

function derivedRenderedFile(
  sourcePin: string,
  sources: readonly VerifiedProjectedSource[],
  destination: string,
  content: string,
): RenderedProjectionFile {
  const inputs = sources
    .map((source) => ({ path: source.path, rawSha256: source.rawSha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    provenance: {
      kind: "derived",
      sourcePin,
      derivation: "codex-agent-registry",
      aggregateSha256: sha256(
        inputs.map((input) => `${input.path}\0${input.rawSha256}`).join("\n"),
      ),
      inputs,
    },
    normalizedSha256: sha256(content),
    destination,
    owner: "aih",
    capabilityOwner: "upstream",
    mergeStrategy: "toml-merge",
    previousHash: null,
    mode: "100644",
    content,
  };
}

function adaptationMarkdown(id: string): string {
  const adaptation = ADAPTATIONS[id];
  if (!adaptation) throw new Error(`missing AIH workflow adaptation: ${id}`);
  return [
    "---",
    `description: ${JSON.stringify(adaptation.description)}`,
    "argument-hint: [workflow arguments]",
    "---",
    "",
    adaptation.body,
    "",
  ].join("\n");
}

function unavailableCodexWorkflow(id: string, reason: string, fallback: string): string {
  return [
    "---",
    `name: ecc-workflow-${id.slice(1)}`,
    `description: ${JSON.stringify(`${id} is retained but unavailable in this projection.`)}`,
    "---",
    "",
    `# Workflow ${id}`,
    "",
    "## Unavailable in this projection",
    "",
    reason,
    "",
    "## Actionable fallback",
    "",
    fallback,
    "",
  ].join("\n");
}

function codexWorkflowSkill(id: string, description: string, body: string): string {
  return [
    "---",
    `name: ecc-workflow-${id.slice(1)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# Workflow ${id}`,
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

function projectedSkillMarkdown(id: string, description: string, body: string): string {
  return [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

function unavailableSkillMarkdown(id: string, reason: string, fallback: string): string {
  return [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(`${id} is retained but unavailable in this projection.`)}`,
    "---",
    "",
    `# Skill ${id}`,
    "",
    "## Unavailable in this projection",
    "",
    reason,
    "",
    "## Actionable fallback",
    "",
    fallback,
    "",
  ].join("\n");
}

function claudeRoleMarkdown(
  id: string,
  description: string,
  body: string,
  policy: ClaudeRolePolicy,
): string {
  return [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(description)}`,
    "model: inherit",
    "tools:",
    ...claudeRoleTools(policy).map((tool) => `  - ${tool}`),
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function codexRoleConfig(body: string): string {
  return [`developer_instructions = ${JSON.stringify(body.trim())}`, ""].join("\n");
}

function codexAgentsConfig(roles: readonly { id: string; description: string }[]): string {
  const lines = [
    "#:schema https://developers.openai.com/codex/config-schema.json",
    "",
    "# AIH-owned ECC role projection. Lifecycle merge is implemented in a later slice.",
  ];
  for (const role of roles) {
    lines.push(
      "",
      `[agents.${role.id}]`,
      `description = ${JSON.stringify(role.description)}`,
      `config_file = ${JSON.stringify(`agents/${role.id}.toml`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function assertProjectionFiles(files: RenderedProjectionFile[]): RenderedProjectionFile[] {
  const ordered = [...files].sort((left, right) =>
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
  );
  const destinations = ordered.map((file) => file.destination.toLowerCase());
  if (new Set(destinations).size !== destinations.length)
    throw new Error("ambiguous case-insensitive projection destination");
  return ordered;
}

function requireSource(
  closure: VerifiedProjectionSourceClosure,
  sourcePath: string,
): VerifiedProjectedSource {
  const source = closure.files.get(sourcePath);
  if (!source) throw new Error(`authenticated source closure omitted consumed path: ${sourcePath}`);
  return source;
}

async function renderWithTrust(
  profileInput: unknown,
  evidence: unknown,
  options: { sourceRoot: string; evidenceRoot: string },
  trust: ProjectionSourceTrust,
): Promise<EccProjection> {
  const resolved = await resolveEccProfile(profileInput, evidence, options);
  const profile = eccProfileSchema.parse(profileInput);
  const closure = acquireProjectionSourceClosure(profile, resolved, options, trust);
  const files: RenderedProjectionFile[] = [];
  const consumed = new Set<string>();
  const sourcePin = resolved.source.commit;

  const claudeSkills: ProjectedSkill[] = [];
  const codexSkills: ProjectedSkill[] = [];
  const skillPolicies = skillProjectionPolicies(resolved.skills);
  for (const skill of resolved.skills) {
    const sourceFiles = [...closure.files.values()].filter((source) =>
      source.path.startsWith(`${skill.sourcePath}/`),
    );
    const primaryPath = posix.join(skill.sourcePath, "SKILL.md");
    const primary = sourceFiles.find((source) => source.path === primaryPath);
    if (!primary) throw new Error(`selected skill is missing SKILL.md: ${skill.id}`);
    const primaryParsed = parseMarkdownSource(
      normalizeText(primary.contents, primary.path),
      primary.path,
      skill.id,
    );
    const policy = skillPolicies.get(skill.id);
    if (!policy) throw new Error(`missing reviewed skill policy: ${skill.id}`);
    const claudeDestination = `.claude/skills/${skill.id}`;
    const codexDestination = `.agents/skills/${skill.id}`;
    claudeSkills.push({
      ...skill,
      destination: claudeDestination,
      transport: policy.claude.transport,
      ...(policy.claude.unavailableReason
        ? { unavailableReason: policy.claude.unavailableReason }
        : {}),
      ...(policy.claude.fallback ? { fallback: policy.claude.fallback } : {}),
    });
    codexSkills.push({
      ...skill,
      destination: codexDestination,
      transport: policy.codex.transport,
      ...(policy.codex.unavailableReason
        ? { unavailableReason: policy.codex.unavailableReason }
        : {}),
      ...(policy.codex.fallback ? { fallback: policy.codex.fallback } : {}),
    });
    for (const source of sourceFiles) {
      consumed.add(source.path);
      const relativePath = posix.relative(skill.sourcePath, source.path);
      const content = normalizeText(source.contents, source.path);
      const primarySource = source.path === primaryPath;
      const claudeContent =
        policy.claude.transport === "unavailable" && primarySource
          ? unavailableSkillMarkdown(
              skill.id,
              policy.claude.unavailableReason ?? "The capability is unavailable.",
              policy.claude.fallback ?? "State the limitation and stop.",
            )
          : content;
      let codexContent = content;
      if (policy.codex.transport === "unavailable" && primarySource) {
        codexContent = unavailableSkillMarkdown(
          skill.id,
          policy.codex.unavailableReason ?? "The capability is unavailable.",
          policy.codex.fallback ?? "State the limitation and stop.",
        );
      } else if (policy.codex.transport === "normalized" && primarySource) {
        codexContent = projectedSkillMarkdown(
          skill.id,
          normalizeCodexSkillBody(skill.id, primaryParsed.description).replace(/\s+/g, " ").trim(),
          normalizeCodexSkillBody(skill.id, primaryParsed.body),
        );
      } else if (policy.codex.transport === "normalized" && source.path.endsWith(".md")) {
        codexContent = normalizeCodexSkillBody(skill.id, content);
      }
      files.push(
        pinnedRenderedFile(
          sourcePin,
          source,
          posix.join(claudeDestination, relativePath),
          claudeContent,
          skill.owner,
        ),
        pinnedRenderedFile(
          sourcePin,
          source,
          posix.join(codexDestination, relativePath),
          codexContent,
          skill.owner,
        ),
      );
    }
  }

  const rolePolicies = claudeRolePolicy(resolved.roles);
  const claudeRoles: ProjectedRole[] = [];
  const codexRoles: ProjectedRole[] = [];
  const roleDescriptions: { id: string; description: string }[] = [];
  const roleSources: VerifiedProjectedSource[] = [];
  for (const role of resolved.roles) {
    const source = requireSource(closure, role.sourcePath);
    consumed.add(source.path);
    const normalized = normalizeText(source.contents, source.path);
    const parsed = parseMarkdownSource(normalized, source.path, role.id);
    const policy = rolePolicies.get(role.id);
    if (!policy) throw new Error(`missing reviewed role policy: ${role.id}`);
    const claudeDestination = `.claude/agents/${role.id}.md`;
    const codexDestination = `.codex/agents/${role.id}.toml`;
    claudeRoles.push({ ...role, destination: claudeDestination, policy });
    codexRoles.push({ ...role, destination: codexDestination, policy });
    roleDescriptions.push({
      id: role.id,
      description: normalizeCodexRoleDescription(role.id, parsed.description),
    });
    roleSources.push(source);
    files.push(
      pinnedRenderedFile(
        sourcePin,
        source,
        claudeDestination,
        claudeRoleMarkdown(role.id, parsed.description, parsed.body, policy),
        role.owner,
        { mode: "100644" },
      ),
      pinnedRenderedFile(
        sourcePin,
        source,
        codexDestination,
        codexRoleConfig(normalizeCodexRoleBody(role.id, parsed.body)),
        role.owner,
        { mode: "100644" },
      ),
    );
  }
  files.push(
    derivedRenderedFile(
      sourcePin,
      roleSources,
      ".codex/config.toml",
      codexAgentsConfig(roleDescriptions),
    ),
  );

  const policies = workflowProjectionPolicies(resolved.workflows);
  const workflowIds = resolved.workflows.map((workflow) => workflow.id);
  const claudeWorkflows: ProjectedWorkflow[] = [];
  const codexWorkflows: ProjectedWorkflow[] = [];
  for (const workflow of resolved.workflows) {
    const source = requireSource(closure, workflow.sourcePath);
    consumed.add(source.path);
    const normalized = normalizeText(source.contents, source.path);
    const parsed = parseMarkdownSource(normalized, source.path);
    const policy = policies.get(workflow.id);
    if (!policy) throw new Error(`missing reviewed workflow policy: ${workflow.id}`);
    const workflowName = workflow.id.slice(1);
    const adapted = workflow.owner === "aih-adaptation";
    const codexDescription = normalizeCodexWorkflowDescription(parsed.description, workflowIds);
    const claudeDestination = `.claude/commands/${workflowName}.md`;
    const codexDestination = `.agents/skills/ecc-workflow-${workflowName}/SKILL.md`;
    claudeWorkflows.push({
      ...workflow,
      destination: claudeDestination,
      transport: policy.claude.transport,
    });
    codexWorkflows.push({
      ...workflow,
      destination: codexDestination,
      transport: policy.codex.transport,
      ...(policy.codex.unavailableReason
        ? { unavailableReason: policy.codex.unavailableReason }
        : {}),
      ...(policy.codex.fallback ? { fallback: policy.codex.fallback } : {}),
    });

    let codexContent: string;
    if (adapted) {
      const adaptation = ADAPTATIONS[workflow.id];
      if (!adaptation) throw new Error(`missing AIH workflow adaptation: ${workflow.id}`);
      codexContent = codexWorkflowSkill(workflow.id, adaptation.description, adaptation.body);
    } else if (policy.codex.transport === "unavailable") {
      const { fallback, unavailableReason } = policy.codex;
      if (!fallback || !unavailableReason)
        throw new Error(`unavailable workflow lacks actionable policy: ${workflow.id}`);
      codexContent = unavailableCodexWorkflow(workflow.id, unavailableReason, fallback);
    } else {
      codexContent = codexWorkflowSkill(
        workflow.id,
        codexDescription,
        normalizeCodexWorkflowBody(parsed.body, workflowIds),
      );
    }
    files.push(
      pinnedRenderedFile(
        sourcePin,
        source,
        claudeDestination,
        adapted ? adaptationMarkdown(workflow.id) : normalized,
        workflow.owner,
        { mode: "100644" },
      ),
      pinnedRenderedFile(sourcePin, source, codexDestination, codexContent, workflow.owner, {
        mode: "100644",
      }),
    );
  }

  if (consumed.size !== closure.files.size)
    throw new Error("authenticated projected source closure was not completely consumed");

  return {
    version: 1,
    source: resolved.source,
    sourceClosure: {
      id: closure.id,
      aggregateSha256: closure.aggregateSha256,
      fileCount: closure.fileCount,
      totalBytes: closure.totalBytes,
    },
    clients: {
      claude: {
        client: "claude",
        skills: claudeSkills,
        roles: claudeRoles,
        workflows: claudeWorkflows,
      },
      codex: { client: "codex", skills: codexSkills, roles: codexRoles, workflows: codexWorkflows },
    },
    files: assertProjectionFiles(files),
  };
}

export async function renderEccProjection(
  profile: unknown,
  evidence: unknown,
  options: { sourceRoot: string; evidenceRoot: string },
): Promise<EccProjection> {
  return renderWithTrust(profile, evidence, options, TRUSTED_PROJECTED_SOURCE);
}

/** Internal hermetic-test seam. This module is not exported from the package or CLI. */
export async function renderEccProjectionWithTrust(
  profile: unknown,
  evidence: unknown,
  options: { sourceRoot: string; evidenceRoot: string },
  trust: ProjectionSourceTrust,
): Promise<EccProjection> {
  return renderWithTrust(profile, evidence, options, trust);
}

export function projectionFilesDigest(files: readonly RenderedProjectionFile[]): string {
  return sha256(
    [...files]
      .sort((left, right) =>
        left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
      )
      .map((file) => `${file.destination}\0${file.normalizedSha256}\0${file.mode}`)
      .join("\n"),
  );
}

export function serializeEccProjection(projection: EccProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
