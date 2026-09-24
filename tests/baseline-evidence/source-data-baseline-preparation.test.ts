import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareSourceDataBaselineCoverageV1 } from "../../src/baseline-evidence/source-data-baseline-preparation.js";
import { loadFrameworkDescriptorSectionV1 } from "../../src/catalog-package/framework-descriptors.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-baseline-data-"));
  roots.push(root);
  mkdirSync(join(root, "skills"));
  mkdirSync(join(root, "skills", "one"));
  writeFileSync(join(root, "skills", "one", "SKILL.md"), "# One\n");
  writeFileSync(join(root, "skills", "one", "helper.md"), "Support\n");
  writeFileSync(join(root, "LICENSE"), "Fixture legal context\n");
  const input = {
    version: "pinned-baseline/v1",
    framework: {
      id: "ecc",
      repository: "affaan-m/ECC",
      commit: "a".repeat(40),
      assets: [
        {
          id: "skill:one",
          kind: "skill",
          source: { repository: "affaan-m/ECC", commit: "a".repeat(40), path: "skills/one" },
          sourcePaths: ["skills/one"],
        },
      ],
    },
  };
  return { root, input };
}
const AUTHORITY_REFUSAL = /framework differs from admitted Catalog authority/;

interface PinnedSourcesFixture {
  readonly repository: string;
  readonly commit: string;
  readonly files: Readonly<Record<string, string>>;
}
interface AdmittedFramework {
  readonly repository: string;
  readonly commit: string;
  readonly assets: readonly {
    readonly id: string;
    readonly sourcePaths: readonly string[];
    readonly metadata?: { readonly sourcePath: string; readonly sourceSha256: string };
  }[];
}

/**
 * The admitted Superpowers framework from the installed Catalog, over a source
 * root holding the exact upstream bytes its metadata digests pin. Declared paths
 * no digest pins only need to exist; they get small stand-in files.
 */
function admittedSuperpowers() {
  const framework = loadFrameworkDescriptorSectionV1<{ framework: AdmittedFramework }>(
    "superpowers",
    "componentDefinitions",
  ).framework;
  const pinned = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../fixtures/baseline-evidence/superpowers-b36e0829-pinned-sources.json",
      ),
      "utf8",
    ),
  ) as PinnedSourcesFixture;
  expect([pinned.repository, pinned.commit]).toEqual([framework.repository, framework.commit]);
  const root = mkdtempSync(join(tmpdir(), "aih-baseline-admitted-"));
  roots.push(root);
  for (const [path, content] of Object.entries(pinned.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const path of framework.assets.flatMap((asset) => asset.sourcePaths)) {
    if (existsSync(join(root, path))) continue;
    const name = path.split("/").at(-1) ?? path;
    const file = !name.startsWith(".") && name.includes(".") ? path : `${path}/fixture.txt`;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `stand-in for ${path}\n`);
  }
  return { root, input: { version: "pinned-baseline/v1", framework }, framework };
}

it("prepares the admitted Catalog framework over its pinned bytes and keeps derived assets unmapped", () => {
  const { root, input, framework } = admittedSuperpowers();
  const prepared = prepareSourceDataBaselineCoverageV1(root, input);
  expect(prepared.coverage.source.inputFormat).toBe("pinned-baseline/v1");
  expect(prepared.coverage.pinnedCommit).toBe(framework.commit);
  expect(prepared.coverage.components.map((component) => component.componentId)).toEqual(
    framework.assets.map((asset) => asset.id).sort(),
  );
  // Core-derived profiles have no upstream material; they stay declared but unmapped.
  expect(prepared.coverage.unmappedDerivedAssets).toEqual(["superpowers/profile:methodology"]);
  const derived = prepared.compiled.declarations.find(
    (item) => item.declaration.id === "superpowers/profile:methodology",
  )?.declaration;
  expect(derived?.derivation).toBe("core-derived");
  const skill = prepared.coverage.components.find(
    (component) => component.componentId === "skill:brainstorming",
  );
  const metadata = framework.assets.find((asset) => asset.id === "skill:brainstorming")?.metadata;
  expect(skill?.files).toEqual([
    { path: "skills/brainstorming/SKILL.md", digest: `sha256:${metadata?.sourceSha256}` },
  ]);
  expect(skill?.subject.assetId).toBe("superpowers/skill:brainstorming");
  expect(prepareSourceDataBaselineCoverageV1(root, input).coverageDigest).toBe(
    prepared.coverageDigest,
  );

  // Coverage binds actual bytes: changed runtime material changes the tree identity.
  const runtime = (value: typeof prepared) =>
    value.coverage.components.find(
      (component) => component.componentId === "runtime:superpowers-plugin",
    );
  writeFileSync(join(root, "package.json"), "changed stand-in\n");
  const changed = prepareSourceDataBaselineCoverageV1(root, input);
  expect(runtime(changed)?.componentTreeSha256).not.toBe(runtime(prepared)?.componentTreeSha256);
  expect(changed.coverageDigest).not.toBe(prepared.coverageDigest);
  expect(runtime(changed)?.subject).toEqual(runtime(prepared)?.subject);
});

it("refuses admitted metadata whose pinned upstream bytes changed", () => {
  const { root, input } = admittedSuperpowers();
  writeFileSync(join(root, "skills", "brainstorming", "SKILL.md"), "# Not upstream\n");
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow(
    /metadata file identity mismatch/,
  );
});

// A synthetic framework binds its actual material first and is then refused by
// authority: only the framework the installed Catalog admits can be prepared.
it("binds complete actual material, then refuses a framework the installed Catalog does not admit", () => {
  const { root, input } = fixture();
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow(AUTHORITY_REFUSAL);
});
it.each(["repository", "commit", "missing-primary", "duplicate", "report-claim"])(
  "rejects malformed baseline %s",
  (caseName) => {
    const { root, input } = fixture();
    const asset = input.framework.assets[0];
    if (!asset) throw Error("fixture");
    if (caseName === "repository") asset.source.repository = "other/repo";
    if (caseName === "commit") asset.source.commit = "b".repeat(40);
    if (caseName === "missing-primary") asset.source.path = "other/missing";
    if (caseName === "duplicate") input.framework.assets.push(structuredClone(asset));
    if (caseName === "report-claim") Object.assign(asset, { vet: { verdict: "pass" } });
    expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow();
  },
);

it("normalizes real overlapping closure paths but never hides a nonexistent child", () => {
  const { root, input } = fixture();
  const asset = input.framework.assets[0];
  if (!asset) throw new Error("fixture");
  asset.sourcePaths.push("skills/one/SKILL.md");
  // An existing redundant child passes material binding and reaches the authority check.
  expect(() => prepareSourceDataBaselineCoverageV1(root, input)).toThrow(AUTHORITY_REFUSAL);
  asset.sourcePaths.push("skills/one/missing.md");
  let refusal: unknown;
  try {
    prepareSourceDataBaselineCoverageV1(root, input);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).not.toMatch(AUTHORITY_REFUSAL);
});
