import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compilePinnedSkillCollectionV1,
  type PinnedSkillCollectionInputV1,
  pinnedSkillCollectionDigestV1,
} from "../../../../src/org-policy/workbench/compilers/pinned-skill-collection.js";

const sha = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const file = (path: string, text: string) => ({
  path,
  bytesBase64: Buffer.from(text, "utf8").toString("base64"),
  sha256: sha(text),
});

function input(): PinnedSkillCollectionInputV1 {
  const skill = file(
    "skills/engineering/example/SKILL.md",
    "---\nname: example\ndescription: Example skill.\n---\nBody\n",
  );
  const support = file("skills/engineering/example/DETAIL.md", "detail\n");
  const license = file("LICENSE", "MIT License\n");
  const value = {
    version: "pinned-skill-collection/v1" as const,
    source: {
      id: "acme-skills",
      repository: "https://example.com/acme/skills",
      commit: "a".repeat(40),
      version: "1.2.3",
    },
    license,
    skills: [{ id: "example", files: [skill, support] }],
  };
  return { ...value, collectionDigest: pinnedSkillCollectionDigestV1(value) };
}

function setFileText(
  target: PinnedSkillCollectionInputV1["skills"][number]["files"][number],
  text: string,
): void {
  const bytes = Buffer.from(text, "utf8");
  target.bytesBase64 = bytes.toString("base64");
  target.sha256 = sha(bytes);
}
function recalculate(value: PinnedSkillCollectionInputV1): void {
  value.collectionDigest = pinnedSkillCollectionDigestV1({
    version: value.version,
    source: value.source,
    license: value.license,
    skills: value.skills,
  });
}

function firstSkillFile(value: PinnedSkillCollectionInputV1) {
  const file = value.skills.at(0)?.files.at(0);
  if (file === undefined) throw new Error("expected fixture skill file");
  return file;
}

function supportFile(value: PinnedSkillCollectionInputV1) {
  const file = value.skills.at(0)?.files.at(1);
  if (file === undefined) throw new Error("expected fixture support file");
  return file;
}

describe("pinned skill collection compiler", () => {
  it("compiles a non-Matt closed collection into data-only record selections", () => {
    const result = compilePinnedSkillCollectionV1(input());
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]?.declaration).toMatchObject({
      id: "acme-skills/skill:example",
      sourceId: "source:acme-skills",
      kind: "skill",
      declaredHostCapabilities: [],
    });
    const detail = Object.values(result.detailBytes)[0];
    expect(detail).toContain("Example skill.");
    expect(detail).toContain("DETAIL.md");
    expect(detail).not.toContain("bytesBase64");
  });

  it("fails closed when a file hash changes after the outer digest is recomputed", () => {
    const changed = input();
    firstSkillFile(changed).sha256 = sha("other");
    recalculate(changed);
    expect(() => compilePinnedSkillCollectionV1(changed)).toThrow(/digest mismatch/);
  });

  it("rejects unsafe, duplicate-entry, and out-of-directory skill resources", () => {
    const unsafe = input();
    supportFile(unsafe).path = "../DETAIL.md";
    recalculate(unsafe);
    expect(() => compilePinnedSkillCollectionV1(unsafe)).toThrow(/safe relative POSIX/);

    const multipleEntries = input();
    supportFile(multipleEntries).path = "skills/engineering/example/nested/SKILL.md";
    recalculate(multipleEntries);
    expect(() => compilePinnedSkillCollectionV1(multipleEntries)).toThrow(/exactly one SKILL\.md/);

    const outside = input();
    supportFile(outside).path = "skills/engineering/other/DETAIL.md";
    recalculate(outside);
    expect(() => compilePinnedSkillCollectionV1(outside)).toThrow(/outside its directory/);
  });

  it("rejects malformed YAML, mismatched names, duplicate identifiers and duplicate paths", () => {
    const malformedYaml = input();
    setFileText(
      firstSkillFile(malformedYaml),
      "---\nname: example\nname: other\ndescription: Example skill.\n---\nBody\n",
    );
    recalculate(malformedYaml);
    expect(() => compilePinnedSkillCollectionV1(malformedYaml)).toThrow(/invalid YAML/);

    const unsupportedTag = input();
    setFileText(
      firstSkillFile(unsupportedTag),
      "---\nname: !foo example\ndescription: Example skill.\n---\nBody\n",
    );
    recalculate(unsupportedTag);
    expect(() => compilePinnedSkillCollectionV1(unsupportedTag)).toThrow(/invalid YAML/);
    const mismatchedName = input();
    setFileText(
      firstSkillFile(mismatchedName),
      "---\nname: other\ndescription: Example skill.\n---\nBody\n",
    );
    recalculate(mismatchedName);
    expect(() => compilePinnedSkillCollectionV1(mismatchedName)).toThrow(
      /mismatched frontmatter name/,
    );

    const duplicateId = input();
    const copiedSkill = structuredClone(duplicateId.skills[0]);
    if (copiedSkill === undefined) throw new Error("expected fixture skill");
    duplicateId.skills.push(copiedSkill);
    recalculate(duplicateId);
    expect(() => compilePinnedSkillCollectionV1(duplicateId)).toThrow(/duplicates skill/);

    const duplicatePath = input();
    duplicatePath.skills[0]?.files.push(structuredClone(supportFile(duplicatePath)));
    recalculate(duplicatePath);
    expect(() => compilePinnedSkillCollectionV1(duplicatePath)).toThrow(/duplicates file/);
  });

  it("rejects missing entries, noncanonical base64, and non-plain inputs", () => {
    const missingEntry = input();
    firstSkillFile(missingEntry).path = "skills/engineering/example/README.md";
    recalculate(missingEntry);
    expect(() => compilePinnedSkillCollectionV1(missingEntry)).toThrow(/exactly one SKILL\.md/);

    const noncanonicalBase64 = input();
    supportFile(noncanonicalBase64).bytesBase64 = "Zg";
    recalculate(noncanonicalBase64);
    expect(() => compilePinnedSkillCollectionV1(noncanonicalBase64)).toThrow(/canonical base64/);

    const nonPlain = Object.assign(Object.create(Date.prototype), input());
    expect(() => compilePinnedSkillCollectionV1(nonPlain)).toThrow(/unsupported object prototype/);
  });
  it("rejects malformed data, unknown fields, and invalid UTF-8", () => {
    const unknown = { ...input(), extra: true };
    expect(() => compilePinnedSkillCollectionV1(unknown)).toThrow();

    const invalidUtf8 = input();
    const bytes = Buffer.from([0xff]);
    firstSkillFile(invalidUtf8).bytesBase64 = bytes.toString("base64");
    firstSkillFile(invalidUtf8).sha256 = sha(bytes);
    recalculate(invalidUtf8);
    expect(() => compilePinnedSkillCollectionV1(invalidUtf8)).toThrow(/UTF-8/);
  });
});
