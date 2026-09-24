import { readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCandidateCatalogV1 } from "../../src/catalog-package/candidate-catalog.js";
import {
  CANDIDATE_DESCRIPTOR_PIN,
  candidateDescriptorBytes,
  candidateDirectory,
  candidateListingDigest,
  candidatePackageFiles,
  candidateTarball,
  packageEntries,
  sha256,
} from "./candidate-catalog-fixture.js";

const requireFromTest = createRequire(import.meta.url);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../fixtures/packages/aihq-catalog-0.3.0-f60735e.tgz", import.meta.url),
);
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(files = candidatePackageFiles()) {
  const root = candidateDirectory(files);
  temporary.push(root);
  return root;
}

function tarball(bytes: Buffer): string {
  const root = directory({});
  const path = join(root, "candidate.tgz");
  writeFileSync(path, bytes);
  return path;
}

/** Fresh module state: activation is once per process, as in a preparation tool run. */
async function fresh() {
  vi.resetModules();
  return {
    candidate: await import("../../src/catalog-package/candidate-catalog.js"),
    descriptors: await import("../../src/catalog-package/framework-descriptors.js"),
    loader: await import("../../src/catalog-package/load-catalog-package.js"),
    materials: await import("../../src/catalog-package/core-materials.js"),
  };
}

describe("openCandidateCatalogV1", () => {
  it("opens an npm pack tarball by the sha256 of its bytes", () => {
    const digest = sha256(readFileSync(FIXTURE));
    expect(openCandidateCatalogV1(FIXTURE, digest)).toEqual({
      sha256: digest,
      digestOf: "tarball",
      version: "0.3.0",
    });
  });

  it("opens an extracted package directory by the sha256 of its canonical file listing", () => {
    const files = candidatePackageFiles();
    expect(openCandidateCatalogV1(directory(files), candidateListingDigest(files))).toEqual({
      sha256: candidateListingDigest(files),
      digestOf: "directory-listing",
      version: "0.3.0",
    });
  });

  it("refuses a malformed digest, a mismatch, and a missing path", () => {
    const files = candidatePackageFiles();
    const root = directory(files);
    expect(() => openCandidateCatalogV1(root, "A".repeat(64))).toThrow(/64 lowercase hex/);
    expect(() => openCandidateCatalogV1(root, "0".repeat(64))).toThrow(
      new RegExp(`directory listing sha256 ${candidateListingDigest(files)} does not match`),
    );
    expect(() => openCandidateCatalogV1(FIXTURE, "0".repeat(64))).toThrow(
      /tarball sha256 [0-9a-f]{64} does not match/,
    );
    expect(() => openCandidateCatalogV1(join(root, "absent.tgz"), "0".repeat(64))).toThrow(
      /does not exist/,
    );
  });

  it.each([
    ["an entry outside package/", [["other/package.json", "{}"]] as const, /outside package\//],
    [
      "a symbolic link entry",
      [...packageEntries(candidatePackageFiles()), ["package/link", "", "2"]] as const,
      /unsupported tar entry type 2/,
    ],
    [
      "an unsafe path",
      [...packageEntries(candidatePackageFiles()), ["package/../x.json", "x"]] as const,
      /unsafe path/,
    ],
    [
      "a repeated entry",
      [...packageEntries(candidatePackageFiles()), ["package/package.json", "{}"]] as const,
      /repeats package\.json/,
    ],
    [
      "a package that is not @aihq/catalog",
      packageEntries(
        candidatePackageFiles({
          "package.json": JSON.stringify({ name: "other", version: "0.3.0" }),
        }),
      ),
      /not an @aihq\/catalog package/,
    ],
    [
      "a package without a manifest",
      packageEntries(candidatePackageFiles({ "package.json": undefined })),
      /has no package\.json/,
    ],
  ])("refuses a tarball with %s", (_label, entries, reason) => {
    const bytes = candidateTarball(entries);
    expect(() => openCandidateCatalogV1(tarball(bytes), sha256(bytes))).toThrow(reason);
  });

  it("refuses bytes that are not a gzip'd tar, and a file that is not a .tgz", () => {
    const bytes = Buffer.from("not a tarball");
    expect(() => openCandidateCatalogV1(tarball(bytes), sha256(bytes))).toThrow(/not a gzip/);
    const root = directory({ "candidate.zip": "x" });
    expect(() => openCandidateCatalogV1(join(root, "candidate.zip"), sha256("x"))).toThrow(
      /\.tgz tarball or a package directory/,
    );
  });

  it("refuses a symbolic link inside a candidate directory", () => {
    const root = directory();
    try {
      symlinkSync("package.json", join(root, "link.json"));
    } catch {
      return; // This host cannot create symbolic links; the tarball case covers the rule.
    }
    expect(() => openCandidateCatalogV1(root, "0".repeat(64))).toThrow(/symbolic link link\.json/);
  });
});

describe("an activated candidate Catalog", () => {
  it("serves every Catalog load, and its named digest stands in for Core's anchors", async () => {
    const { candidate, descriptors, loader } = await fresh();
    const files = candidatePackageFiles();
    const opened = candidate.openCandidateCatalogV1(
      directory(files),
      candidateListingDigest(files),
    );
    candidate.activateCandidateCatalogV1(opened);
    expect(loader.candidateCatalogActiveV1()).toBe(true);
    expect(
      descriptors.loadFrameworkDescriptorSectionV1<{ pinnedSha: string }>(
        "superpowers",
        "vendorLock",
      ).pinnedSha,
    ).toBe(CANDIDATE_DESCRIPTOR_PIN);
    expect(candidate.activeCandidateCatalogUseV1()).toEqual({
      sha256: candidateListingDigest(files),
      digestOf: "directory-listing",
      version: "0.3.0",
      files: [
        {
          path: "defaults/catalog-framework-superpowers-v1.json",
          sha256: sha256(candidateDescriptorBytes),
        },
        { path: "package.json", sha256: sha256(files["package.json"] as string) },
      ],
    });
  });

  it("never falls back to the installed Catalog for anything the candidate lacks", async () => {
    const { candidate, loader, materials } = await fresh();
    const files = candidatePackageFiles();
    candidate.activateCandidateCatalogV1(
      candidate.openCandidateCatalogV1(directory(files), candidateListingDigest(files)),
    );
    expect(() => materials.loadCatalogCoreMaterialV1("scanner")).toThrow(
      /does not export \.\/catalog-scanner-evidence\.json/,
    );
    const loaded = await loader.loadCatalogPackageV1(["readCatalogContentV1Result"], []);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.refusal.detail).toMatch(/candidate Catalog is data only/);
  });

  it("refuses activation after the installed Catalog was reached, and a second activation", async () => {
    const files = candidatePackageFiles();
    const root = directory(files);
    const first = await fresh();
    first.descriptors.loadFrameworkDescriptorSectionV1("superpowers", "vendorLock");
    expect(() =>
      first.candidate.activateCandidateCatalogV1(
        first.candidate.openCandidateCatalogV1(root, candidateListingDigest(files)),
      ),
    ).toThrow(/installed Catalog was already loaded in this process/);
    const second = await fresh();
    const opened = second.candidate.openCandidateCatalogV1(root, candidateListingDigest(files));
    second.candidate.activateCandidateCatalogV1(opened);
    expect(() => second.candidate.activateCandidateCatalogV1(opened)).toThrow(
      /already active in this process/,
    );
  });

  it("refuses to activate anything openCandidateCatalogV1 did not verify", async () => {
    const { candidate } = await fresh();
    expect(() =>
      candidate.activateCandidateCatalogV1({
        sha256: "0".repeat(64),
        digestOf: "tarball",
        version: "0.3.0",
      }),
    ).toThrow(/was not opened and verified/);
  });
});

describe("runtime ignores candidate Catalogs", () => {
  it("keeps the installed Catalog and Core's anchors when a candidate is only opened", async () => {
    const { candidate, descriptors, loader } = await fresh();
    const files = candidatePackageFiles();
    candidate.openCandidateCatalogV1(directory(files), candidateListingDigest(files));
    const installed = JSON.parse(
      readFileSync(
        requireFromTest.resolve("@aihq/catalog/catalog-framework-superpowers.json"),
        "utf8",
      ),
    ) as { sections: { vendorLock: { pinnedSha: string } } };
    expect(loader.candidateCatalogActiveV1()).toBe(false);
    expect(candidate.activeCandidateCatalogUseV1()).toBeUndefined();
    expect(
      descriptors.loadFrameworkDescriptorSectionV1<{ pinnedSha: string }>(
        "superpowers",
        "vendorLock",
      ).pinnedSha,
    ).toBe(installed.sections.vendorLock.pinnedSha);
  });

  it("is reachable only from the internal preparation tools", () => {
    const sources: string[] = [];
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        if (statSync(child).isDirectory()) walk(child);
        else if (child.endsWith(".ts")) sources.push(child);
      }
    };
    walk(join(repository, "src"));
    const referencing = (pattern: RegExp) =>
      sources
        .filter((path) => pattern.test(readFileSync(path, "utf8")))
        .map((path) => relative(repository, path).replaceAll("\\", "/"))
        .sort();
    expect(referencing(/candidate-catalog\.js"/)).toEqual([
      "src/internals/prepare-packaged-workbench-source-data.ts",
      "src/internals/prepare-workbench-catalog-qualification.ts",
    ]);
    expect(referencing(/substituteCatalogPackageAccessV1/)).toEqual([
      "src/catalog-package/candidate-catalog.ts",
      "src/catalog-package/load-catalog-package.ts",
    ]);
    expect(referencing(/--candidate-catalog/)).toEqual([
      "src/internals/prepare-packaged-workbench-source-data.ts",
      "src/internals/prepare-workbench-catalog-qualification.ts",
    ]);
  });
});
