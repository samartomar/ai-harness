import snapshot from "./ecc-content-metadata.snapshot.json";

export const ECC_CONTENT_METADATA_PROVENANCE = {
  repository: "samartomar/ECC",
  commit: "5caf398a91599029a176ca6d806409b00d1052c4",
} as const;

export interface EccContentMetadataEntry {
  id: string;
  title: string;
  path: string;
  summary: string;
  usageContext: string;
  allowedTools: readonly string[];
  sourceSha256: string;
}

interface EccContentMetadataSnapshot {
  version: 1;
  repository: string;
  commit: string;
  agents: unknown;
  skills: unknown;
}

function fail(message: string): never {
  throw new Error(`invalid source-locked ECC content metadata: ${message}`);
}

function containsControlCharacter(value: string, allowTextWhitespace: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return true;
    if (codePoint === 0x7f) return true;
    if (codePoint < 0x20) {
      const allowed =
        allowTextWhitespace && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d);
      if (!allowed) return true;
    }
  }
  return false;
}

function entries(kind: "agents" | "skills", value: unknown): readonly EccContentMetadataEntry[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${kind} must be a non-empty array`);
  const seen = new Set<string>();
  const parsed = value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return fail(`${kind}[${index}] is not an object`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
      return fail(`${kind}[${index}] has an invalid id`);
    }
    const expectedPath = kind === "agents" ? `agents/${item.id}.md` : `skills/${item.id}/SKILL.md`;
    if (item.path !== expectedPath) fail(`${kind}[${index}] has an unexpected path`);
    if (
      typeof item.title !== "string" ||
      item.title.trim() === "" ||
      item.title.length > 200 ||
      containsControlCharacter(item.title, false)
    ) {
      fail(`${kind}[${index}] has an invalid title`);
    }
    if (
      typeof item.summary !== "string" ||
      item.summary.trim() === "" ||
      item.summary.length > 2_000 ||
      containsControlCharacter(item.summary, true)
    ) {
      fail(`${kind}[${index}] has an invalid summary`);
    }
    if (
      typeof item.usageContext !== "string" ||
      item.usageContext.trim() === "" ||
      item.usageContext.length > 1_500 ||
      containsControlCharacter(item.usageContext, true)
    ) {
      fail(`${kind}[${index}] has an invalid usage context`);
    }
    if (
      !Array.isArray(item.allowedTools) ||
      item.allowedTools.some(
        (tool) => typeof tool !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(tool),
      )
    ) {
      fail(`${kind}[${index}] has invalid allowed tools`);
    }
    if (typeof item.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceSha256)) {
      fail(`${kind}[${index}] has an invalid source digest`);
    }
    if (seen.has(item.id)) fail(`${kind} contains duplicate ${item.id}`);
    seen.add(item.id);
    return Object.freeze({
      id: item.id,
      title: item.title,
      path: expectedPath,
      summary: item.summary,
      usageContext: item.usageContext,
      allowedTools: Object.freeze([...(item.allowedTools as string[])]),
      sourceSha256: item.sourceSha256,
    });
  });
  return Object.freeze(parsed);
}

const source = snapshot as EccContentMetadataSnapshot;
if (source.version !== 1) fail("unsupported version");
if (
  source.repository !== ECC_CONTENT_METADATA_PROVENANCE.repository ||
  source.commit !== ECC_CONTENT_METADATA_PROVENANCE.commit
) {
  fail("provenance mismatch");
}

export const eccAgentContentMetadata = entries("agents", source.agents);
export const eccSkillContentMetadata = entries("skills", source.skills);

const agentsById = new Map(eccAgentContentMetadata.map((item) => [item.id, item]));
const skillsById = new Map(eccSkillContentMetadata.map((item) => [item.id, item]));

export function eccContentMetadata(
  kind: "agent" | "skill",
  id: string,
): EccContentMetadataEntry | undefined {
  return (kind === "agent" ? agentsById : skillsById).get(id);
}
