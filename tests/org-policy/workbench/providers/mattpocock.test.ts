import { expect, it } from "vitest";
import {
  compileMattPocockSkillCollectionV1,
  MATTPOCOCK_SUPPORT_OWNERSHIP_V1,
  mattPocockPinnedSkillCollectionFixtureV1,
  mattPocockPinnedSkillCollectionV1,
  mattpocockCatalogProviderV1,
  prepareMattPocockSnapshotV1,
} from "../../../../src/org-policy/workbench/providers/mattpocock.js";
import snapshot from "../../../../src/org-policy/workbench/providers/mattpocock.snapshot.json";
import { providerContract } from "./contract-helper.js";

providerContract(mattpocockCatalogProviderV1);

type SnapshotObject = Record<string, unknown>;

function copiedSnapshot(): SnapshotObject {
  return structuredClone(snapshot) as SnapshotObject;
}

function entriesOf(value: SnapshotObject): SnapshotObject[] {
  const entries = value.entries;
  if (!Array.isArray(entries)) throw new Error("expected snapshot entries");
  return entries as SnapshotObject[];
}

function upstreamOf(value: SnapshotObject): SnapshotObject {
  const upstream = value.upstream;
  if (typeof upstream !== "object" || upstream === null || Array.isArray(upstream)) {
    throw new Error("expected snapshot upstream");
  }
  return upstream as SnapshotObject;
}

it("uses a single synthetic fixture while the packaged catalog retains every pinned skill", () => {
  expect(mattPocockPinnedSkillCollectionFixtureV1().skills).toHaveLength(1);
  expect(mattPocockPinnedSkillCollectionV1.skills).toHaveLength(25);
  expect(MATTPOCOCK_SUPPORT_OWNERSHIP_V1).toHaveLength(23);
  const output = compileMattPocockSkillCollectionV1(mattPocockPinnedSkillCollectionV1);
  expect(output.declarations).toHaveLength(25);
  expect(output.declarations.some((entry) => entry.declaration.id === "mattpocock/skill:tdd")).toBe(
    true,
  );
  expect(
    mattPocockPinnedSkillCollectionV1.skills
      .find((skill) => skill.id === "diagnosing-bugs")
      ?.files.some(
        (file) => file.path === "skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh",
      ),
  ).toBe(true);
});

it("rejects stale source descriptors before compilation", () => {
  const stale = structuredClone(mattPocockPinnedSkillCollectionV1);
  stale.source.commit = "a".repeat(40);
  expect(() => mattpocockCatalogProviderV1.compile(stale)).toThrow(/exact pinned descriptor/);
});

it("prepares only the exact sealed snapshot structure", () => {
  const corruptedBytes = copiedSnapshot();
  const first = entriesOf(corruptedBytes)[0];
  if (first === undefined) throw new Error("expected snapshot entry");
  first.base64 = "QQ==";
  expect(() => prepareMattPocockSnapshotV1(corruptedBytes)).toThrow(/byte integrity/);

  const orphanSupport = copiedSnapshot();
  const support = entriesOf(orphanSupport).find((entry) => entry.kind === "support");
  if (support === undefined) throw new Error("expected snapshot support");
  support.requiredBy = "skills/engineering/missing/SKILL.md";
  expect(() => prepareMattPocockSnapshotV1(orphanSupport)).toThrow(/support ownership/);

  const duplicateSupport = copiedSnapshot();
  const duplicate = entriesOf(duplicateSupport).find((entry) => entry.kind === "support");
  if (duplicate === undefined) throw new Error("expected snapshot support");
  entriesOf(duplicateSupport).push(structuredClone(duplicate));
  expect(() => prepareMattPocockSnapshotV1(duplicateSupport)).toThrow(/duplicates/);

  const missingLicense = copiedSnapshot();
  missingLicense.entries = entriesOf(missingLicense).filter((entry) => entry.kind !== "license");
  expect(() => prepareMattPocockSnapshotV1(missingLicense)).toThrow(/exactly one LICENSE/);

  const missingSkill = copiedSnapshot();
  missingSkill.entries = entriesOf(missingSkill).filter((entry) => entry.kind !== "skill");
  expect(() => prepareMattPocockSnapshotV1(missingSkill)).toThrow(/packaged entry count/);

  const mismatchedPin = copiedSnapshot();
  upstreamOf(mismatchedPin).pin = "a".repeat(40);
  expect(() => prepareMattPocockSnapshotV1(mismatchedPin)).toThrow(/pin mismatch/);
});

it("deep-freezes the packaged baseline before it is enrolled", () => {
  const skill = mattPocockPinnedSkillCollectionV1.skills[0];
  const file = skill?.files[0];
  expect(Object.isFrozen(mattPocockPinnedSkillCollectionV1)).toBe(true);
  expect(Object.isFrozen(mattPocockPinnedSkillCollectionV1.skills)).toBe(true);
  expect(Object.isFrozen(skill)).toBe(true);
  expect(Object.isFrozen(file)).toBe(true);
});
