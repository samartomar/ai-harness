import { createHash } from "node:crypto";
import { ECC_DECLARABLE_COMPONENT_IDS } from "../ecc/components.js";
import { eccContentMetadata } from "./ecc-content-metadata.js";
import snapshot from "./ecc-skill-catalog.snapshot.json";

/** Exact source tree whose top-level skills inventory is represented below. */
export const ECC_SKILL_CATALOG_PROVENANCE = {
  repository: "samartomar/ECC",
  commit: "5caf398a91599029a176ca6d806409b00d1052c4",
  pathPattern: "skills/*/SKILL.md",
  namesSha256: "b5529d1813454421b115753a05a42fc8592eb3338ad1b3394e4c46892c69c8f9",
} as const;

export interface EccSkillCatalogEntry {
  /** Directory name from the exact upstream skills/<name>/SKILL.md inventory. */
  id: string;
  path: string;
  /** Only an existing policy component may be selected or carry policy semantics. */
  governable: boolean;
  title: string;
  summary: string;
  usageContext: string;
  sourceSha256: string;
}

function fail(message: string): never {
  throw new Error(`invalid source-locked ECC skills inventory: ${message}`);
}

function inventory(value: unknown): readonly EccSkillCatalogEntry[] {
  if (!Array.isArray(value) || value.length !== 286) fail("count mismatch");
  const governed = new Set(
    ECC_DECLARABLE_COMPONENT_IDS.filter((component) => component.startsWith("skill:")).map(
      (component) => component.slice("skill:".length),
    ),
  );
  const names: string[] = [];
  for (const [index, name] of value.entries()) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      fail(`invalid name at ${index}`);
    }
    if (names.includes(name)) fail(`duplicate name ${name}`);
    names.push(name);
  }
  const canonicalNames = [...names].sort();
  const digest = createHash("sha256").update(canonicalNames.join("\n"), "utf8").digest("hex");
  if (digest !== ECC_SKILL_CATALOG_PROVENANCE.namesSha256) fail("canonical names digest mismatch");
  for (const name of governed) if (!names.includes(name)) fail(`governed skill ${name} is absent`);
  return Object.freeze(
    canonicalNames.map((id) => {
      const metadata = eccContentMetadata("skill", id);
      if (metadata === undefined) fail(`skill ${id} has no source-authored metadata`);
      return Object.freeze({
        id,
        path: `skills/${id}/SKILL.md`,
        governable: governed.has(id),
        title: metadata.title,
        summary: metadata.summary,
        usageContext: metadata.usageContext,
        sourceSha256: metadata.sourceSha256,
      });
    }),
  );
}

/** Complete, availability-only inventory; policy authority stays on existing components. */
export const eccSkillCatalogInventory = inventory(snapshot);
