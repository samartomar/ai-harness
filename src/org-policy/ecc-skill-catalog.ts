/** Exact source tree whose top-level skills inventory is represented below. */
export const ECC_SKILL_CATALOG_PROVENANCE = {
  repository: "affaan-m/ECC",
  commit: "5064474d4d762dc9640234a41617cccb79185cec",
  pathPattern: "skills/*/SKILL.md",
  namesSha256: "b5529d1813454421b115753a05a42fc8592eb3338ad1b3394e4c46892c69c8f9",
} as const;

export interface EccSkillCatalogEntry {
  /** Directory name from the exact upstream skills/<name>/SKILL.md inventory. */
  id: string;
  path: string;
  /** Exact source intent may be selected; this is not an installability or vet claim. */
  governable: boolean;
  title: string;
  summary: string;
  usageContext: string;
  sourceSha256: string;
}
