import { createHash } from "node:crypto";
import { AIH_ECC_PROFILE_TEMPLATE } from "./index.js";
import { type NativeEccRegistration, nativeRegistrationFiles } from "./native-registration.js";
import { type ClientProjection, type EccProjection, projectionFilesDigest } from "./render.js";

export type EccParityTransport = "native" | "normalized" | "unavailable";

export interface EccParityMapping {
  id: string;
  sourcePath: string;
  destination: string;
  owner: "upstream" | "aih-adaptation";
  transport: EccParityTransport;
  unavailableReason?: string;
  fallback?: string;
}

export interface EccProfileParityReceipt {
  receiptVersion: 1;
  source: {
    repository: string;
    commit: string;
    reviewReceiptSha256: string;
    sourceClosureId: string;
    sourceClosureSha256: string;
    projectionSha256: string;
  };
  clients: Record<
    "claude" | "codex",
    {
      client: "claude" | "codex";
      skills: EccParityMapping[];
      roles: EccParityMapping[];
      workflows: EccParityMapping[];
    }
  >;
  native: {
    hooks: Record<"claude" | "codex", string[]>;
    mcp: { selected: string[]; disabled: string[] };
    policySha256: string;
    registrationFiles: Array<{
      destination: string;
      ownership: "json-array-children" | "json-object-children" | "toml-block";
      policySha256: string;
    }>;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`ECC parity receipt has an ambiguous duplicate ${label}`);
  }
  return sorted;
}

function mapping(
  entry: {
    id: string;
    sourcePath: string;
    destination: string;
    owner: "upstream" | "aih-adaptation";
    transport?: EccParityTransport;
    unavailableReason?: string;
    fallback?: string;
  },
  transport = entry.transport ?? "normalized",
): EccParityMapping {
  if (transport === "unavailable") {
    if (!entry.unavailableReason?.trim() || !entry.fallback?.trim()) {
      throw new Error(`unavailable ECC parity mapping is not actionable: ${entry.id}`);
    }
  } else if (entry.unavailableReason !== undefined || entry.fallback !== undefined) {
    throw new Error(`available ECC parity mapping has contradictory fallback fields: ${entry.id}`);
  }
  return {
    id: entry.id,
    sourcePath: entry.sourcePath,
    destination: entry.destination,
    owner: entry.owner,
    transport,
    ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    ...(entry.fallback ? { fallback: entry.fallback } : {}),
  };
}

function clientReceipt(client: ClientProjection) {
  const skills = client.skills
    .map((entry) => mapping(entry))
    .sort((a, b) => a.id.localeCompare(b.id));
  const roles = client.roles
    .map((entry) => mapping(entry, "normalized"))
    .sort((a, b) => a.id.localeCompare(b.id));
  const workflows = client.workflows
    .map((entry) => mapping(entry))
    .sort((a, b) => a.id.localeCompare(b.id));
  uniqueSorted(
    skills.map((entry) => entry.id),
    `${client.client} skill identity`,
  );
  uniqueSorted(
    roles.map((entry) => entry.id),
    `${client.client} role identity`,
  );
  uniqueSorted(
    workflows.map((entry) => entry.id),
    `${client.client} workflow identity`,
  );
  uniqueSorted(
    [...skills, ...roles, ...workflows].map((entry) => entry.destination),
    `${client.client} destination`,
  );
  return { client: client.client, skills, roles, workflows };
}

function assertComplete(
  kind: "skill" | "role" | "workflow",
  claude: readonly EccParityMapping[],
  codex: readonly EccParityMapping[],
): void {
  const identity = (entry: EccParityMapping) =>
    JSON.stringify({ id: entry.id, sourcePath: entry.sourcePath, owner: entry.owner });
  const left = claude.map(identity).sort();
  const right = codex.map(identity).sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`ECC parity ${kind} mapping is incomplete or silently omitted`);
  }
}

function assertAdaptationOwnership(clients: ReturnType<typeof clientReceipt>[]): void {
  const expected = [...AIH_ECC_PROFILE_TEMPLATE.aihAdaptedWorkflows].sort();
  for (const client of clients) {
    const actual = client.workflows
      .filter((entry) => entry.owner === "aih-adaptation")
      .map((entry) => entry.id)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`ECC parity workflow ownership contradicts the reviewed adaptations`);
    }
  }
}

function hookEvents(registration: NativeEccRegistration, client: "claude" | "codex"): string[] {
  const hooks = registration.hooks[client].hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    if (groups.length !== 1 || groups[0]?.hooks.length !== 1) {
      throw new Error(`ECC parity native hook mapping is ambiguous: ${client}/${event}`);
    }
  }
  return Object.keys(hooks).sort();
}

function selectedMcpNames(registration: NativeEccRegistration): string[] {
  const claude = Object.keys(registration.mcp.claude.mcpServers).sort();
  const codex = [...registration.mcp.codexToml.matchAll(/^\[mcp_servers\."([a-z0-9-]+)"\]$/gm)]
    .map((match) => match[1] ?? "")
    .sort();
  if (JSON.stringify(claude) !== JSON.stringify(codex)) {
    throw new Error("ECC parity native MCP mappings differ between Claude and Codex");
  }
  uniqueSorted(claude, "selected MCP identity");
  return claude;
}

function policyPathVariants(value: string): string[] {
  return uniqueSorted(
    [
      value,
      value.replace(/\\/g, "/"),
      value.replace(/\\/g, "\\\\"),
      JSON.stringify(value).slice(1, -1),
    ].filter(
      (candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index,
    ),
    "native policy path variant",
  ).sort((left, right) => right.length - left.length);
}

function canonicalPolicyContent(content: string, registration: NativeEccRegistration): string {
  const replacements: Array<readonly [string, string]> = [
    [registration.runtime.serena.pyproject.path, "<serena-pyproject>"],
    [registration.runtime.serena.uvLock.path, "<serena-uv-lock>"],
    [registration.runtime.executable.path, "<aih-executable>"],
    [registration.runtime.cliScript.path, "<aih-cli-script>"],
    [registration.runtime.serena.root, "<serena-runtime-root>"],
    [registration.stateRoot, "<aih-state-root>"],
    [registration.root, "<project-root>"],
  ] as const;
  let canonical = content.replace(/\r\n/g, "\n");
  for (const [value, token] of replacements.sort(
    (left, right) => right[0].length - left[0].length,
  )) {
    for (const variant of policyPathVariants(value))
      canonical = canonical.replaceAll(variant, token);
  }
  return canonical;
}

export function buildEccProfileParityReceipt(
  projection: EccProjection,
  registration: NativeEccRegistration,
): EccProfileParityReceipt {
  const claude = clientReceipt(projection.clients.claude);
  const codex = clientReceipt(projection.clients.codex);
  assertComplete("skill", claude.skills, codex.skills);
  assertComplete("role", claude.roles, codex.roles);
  assertComplete("workflow", claude.workflows, codex.workflows);
  assertAdaptationOwnership([claude, codex]);
  const registrationFiles = nativeRegistrationFiles(registration)
    .map(({ destination, ownership, content }) => ({
      destination,
      ownership,
      policySha256: sha256(canonicalPolicyContent(content, registration)),
    }))
    .sort((left, right) => left.destination.localeCompare(right.destination));
  uniqueSorted(
    registrationFiles.map((entry) => entry.destination),
    "native registration destination",
  );
  return {
    receiptVersion: 1,
    source: {
      repository: projection.source.repository,
      commit: projection.source.commit,
      reviewReceiptSha256: projection.source.reviewReceipt.evidenceSha256,
      sourceClosureId: projection.sourceClosure.id,
      sourceClosureSha256: projection.sourceClosure.aggregateSha256,
      projectionSha256: projectionFilesDigest(projection.files),
    },
    clients: { claude, codex },
    native: {
      hooks: {
        claude: hookEvents(registration, "claude"),
        codex: hookEvents(registration, "codex"),
      },
      mcp: {
        selected: selectedMcpNames(registration),
        disabled: uniqueSorted(registration.mcp.disabled, "disabled MCP identity"),
      },
      policySha256: sha256(
        registrationFiles
          .map((file) => `${file.destination}\0${file.ownership}\0${file.policySha256}`)
          .join("\n"),
      ),
      registrationFiles,
    },
  };
}

export function serializeEccProfileParityReceipt(receipt: EccProfileParityReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function eccProfileParityReceiptDigest(receipt: EccProfileParityReceipt): string {
  return sha256(serializeEccProfileParityReceipt(receipt));
}
