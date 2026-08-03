import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertPortableSourcePath,
  checkedPath,
  checkedRoot,
  type EccProfile,
  type ResolvedEntry,
  type ResolvedSkill,
  resolveEccProfile,
} from "./index.js";

type CapabilityOwner = ResolvedEntry["owner"];
type MergeStrategy = "replace" | "toml-merge";

export interface ProjectedEntry extends ResolvedEntry {
  destination: string;
}

export interface ProjectedSkill extends ResolvedSkill {
  destination: string;
}

export interface ClientProjection {
  client: "claude" | "codex";
  skills: ProjectedSkill[];
  roles: ProjectedEntry[];
  workflows: ProjectedEntry[];
}

export interface RenderedProjectionFile {
  sourcePin: string;
  sourcePath: string;
  sourceSha256: string;
  normalizedSha256: string;
  destination: string;
  owner: "aih";
  capabilityOwner: CapabilityOwner;
  mergeStrategy: MergeStrategy;
  previousHash: null;
  content: string;
}

export interface EccProjection {
  version: 1;
  source: EccProfile["source"];
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

interface SourceFile {
  sourcePath: string;
  bytes: Buffer;
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
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${(error as Error).message}`);
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
  if (
    expectedName &&
    attributes.name !== undefined &&
    (typeof attributes.name !== "string" || attributes.name !== expectedName)
  )
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

function readSourceFile(sourceRoot: string, sourcePath: string): SourceFile {
  assertPortableSourcePath(sourcePath);
  const absolute = checkedPath(sourceRoot, sourcePath, "file", "projection source");
  return { sourcePath, bytes: readFileSync(absolute) };
}

function readSourceTree(sourceRoot: string, sourceDirectory: string): SourceFile[] {
  assertPortableSourcePath(sourceDirectory);
  checkedPath(sourceRoot, sourceDirectory, "directory", "projection source");
  const files: SourceFile[] = [];
  const visit = (relativeDirectory: string): void => {
    const directoryPath = relativeDirectory
      ? posix.join(sourceDirectory, relativeDirectory)
      : sourceDirectory;
    const absoluteDirectory = checkedPath(
      sourceRoot,
      directoryPath,
      "directory",
      "projection source",
    );
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name;
      const sourcePath = assertPortableSourcePath(posix.join(sourceDirectory, relativePath));
      if (entry.isSymbolicLink())
        throw new Error(`projection source uses a symbolic link: ${sourcePath}`);
      if (entry.isDirectory()) {
        checkedPath(sourceRoot, sourcePath, "directory", "projection source");
        visit(relativePath);
      } else if (entry.isFile()) {
        const absolute = checkedPath(sourceRoot, sourcePath, "file", "projection source");
        files.push({ sourcePath, bytes: readFileSync(absolute) });
      } else {
        throw new Error(`projection source is not a regular file or directory: ${sourcePath}`);
      }
    }
  };
  visit("");
  return files;
}

function renderedFile(
  sourcePin: string,
  source: SourceFile,
  destination: string,
  content: string,
  capabilityOwner: CapabilityOwner,
  mergeStrategy: MergeStrategy = "replace",
): RenderedProjectionFile {
  assertPortableSourcePath(destination);
  return {
    sourcePin,
    sourcePath: source.sourcePath,
    sourceSha256: sha256(source.bytes),
    normalizedSha256: sha256(content),
    destination,
    owner: "aih",
    capabilityOwner,
    mergeStrategy,
    previousHash: null,
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

function codexWorkflowSkill(id: string, source: MarkdownSource, adapted: boolean): string {
  const workflowName = id.slice(1);
  const adaptation = ADAPTATIONS[id];
  const description = adapted ? adaptation?.description : source.description;
  const body = adapted
    ? adaptation?.body
    : source.body.replaceAll("$ARGUMENTS", "the user's workflow arguments").trimEnd();
  if (!description || !body) throw new Error(`workflow ${id} cannot be projected`);
  return [
    "---",
    `name: ecc-workflow-${workflowName}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# Workflow ${id}`,
    "",
    body,
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

export async function renderEccProjection(
  profile: unknown,
  evidence: unknown,
  options: { sourceRoot: string; evidenceRoot: string },
): Promise<EccProjection> {
  const resolved = await resolveEccProfile(profile, evidence, options);
  const sourceRoot = checkedRoot(options.sourceRoot, "ECC projection source root");
  const files: RenderedProjectionFile[] = [];
  const sourcePin = resolved.source.commit;

  const claudeSkills: ProjectedSkill[] = [];
  const codexSkills: ProjectedSkill[] = [];
  for (const skill of resolved.skills) {
    const sourceFiles = readSourceTree(sourceRoot, skill.sourcePath);
    const primaryPath = posix.join(skill.sourcePath, "SKILL.md");
    const primary = sourceFiles.find((file) => file.sourcePath === primaryPath);
    if (!primary) throw new Error(`selected skill is missing SKILL.md: ${skill.id}`);
    parseMarkdownSource(
      normalizeText(primary.bytes, primary.sourcePath),
      primary.sourcePath,
      skill.id,
    );
    const claudeDestination = `.claude/skills/${skill.id}`;
    const codexDestination = `.agents/skills/${skill.id}`;
    claudeSkills.push({ ...skill, destination: claudeDestination });
    codexSkills.push({ ...skill, destination: codexDestination });
    for (const sourceFile of sourceFiles) {
      const relativePath = posix.relative(skill.sourcePath, sourceFile.sourcePath);
      const content = normalizeText(sourceFile.bytes, sourceFile.sourcePath);
      files.push(
        renderedFile(
          sourcePin,
          sourceFile,
          posix.join(claudeDestination, relativePath),
          content,
          skill.owner,
        ),
        renderedFile(
          sourcePin,
          sourceFile,
          posix.join(codexDestination, relativePath),
          content,
          skill.owner,
        ),
      );
    }
  }

  const claudeRoles: ProjectedEntry[] = [];
  const codexRoles: ProjectedEntry[] = [];
  const roleDescriptions: { id: string; description: string }[] = [];
  const roleSources: SourceFile[] = [];
  for (const role of resolved.roles) {
    const source = readSourceFile(sourceRoot, role.sourcePath);
    const normalized = normalizeText(source.bytes, source.sourcePath);
    const parsed = parseMarkdownSource(normalized, source.sourcePath, role.id);
    const claudeDestination = `.claude/agents/${role.id}.md`;
    const codexDestination = `.codex/agents/${role.id}.toml`;
    claudeRoles.push({ ...role, destination: claudeDestination });
    codexRoles.push({ ...role, destination: codexDestination });
    roleDescriptions.push({ id: role.id, description: parsed.description });
    roleSources.push(source);
    files.push(
      renderedFile(sourcePin, source, claudeDestination, normalized, role.owner),
      renderedFile(sourcePin, source, codexDestination, codexRoleConfig(parsed.body), role.owner),
    );
  }
  const codexConfig = codexAgentsConfig(roleDescriptions);
  const configSource = {
    sourcePath: "agents",
    bytes: Buffer.from(roleSources.map((source) => sha256(source.bytes)).join("\n")),
  };
  files.push(
    renderedFile(
      sourcePin,
      configSource,
      ".codex/config.toml",
      codexConfig,
      "upstream",
      "toml-merge",
    ),
  );

  const claudeWorkflows: ProjectedEntry[] = [];
  const codexWorkflows: ProjectedEntry[] = [];
  for (const workflow of resolved.workflows) {
    const source = readSourceFile(sourceRoot, workflow.sourcePath);
    const normalized = normalizeText(source.bytes, source.sourcePath);
    const parsed = parseMarkdownSource(normalized, source.sourcePath);
    const workflowName = workflow.id.slice(1);
    const adapted = workflow.owner === "aih-adaptation";
    const claudeDestination = `.claude/commands/${workflowName}.md`;
    const codexDestination = `.agents/skills/ecc-workflow-${workflowName}/SKILL.md`;
    claudeWorkflows.push({ ...workflow, destination: claudeDestination });
    codexWorkflows.push({ ...workflow, destination: codexDestination });
    files.push(
      renderedFile(
        sourcePin,
        source,
        claudeDestination,
        adapted ? adaptationMarkdown(workflow.id) : normalized,
        workflow.owner,
      ),
      renderedFile(
        sourcePin,
        source,
        codexDestination,
        codexWorkflowSkill(workflow.id, parsed, adapted),
        workflow.owner,
      ),
    );
  }

  return {
    version: 1,
    source: resolved.source,
    clients: {
      claude: {
        client: "claude",
        skills: claudeSkills,
        roles: claudeRoles,
        workflows: claudeWorkflows,
      },
      codex: {
        client: "codex",
        skills: codexSkills,
        roles: codexRoles,
        workflows: codexWorkflows,
      },
    },
    files: assertProjectionFiles(files),
  };
}

export function serializeEccProjection(projection: EccProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
