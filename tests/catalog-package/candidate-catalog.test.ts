import { readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCandidateCatalogV1 } from "../../src/catalog-package/candidate-catalog.js";
import {
  CANDIDATE_DESCRIPTOR_PIN,
  candidateDescriptorBytes,
  candidateDirectory,
  candidateListingDigest,
  candidatePackageFiles,
  candidateTar,
  candidateTarball,
  packageEntries,
  paxBody,
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

  describe("pax extended headers and archive framing", () => {
    const files = candidatePackageFiles();
    const open = (bytes: Buffer) => openCandidateCatalogV1(tarball(bytes), sha256(bytes));
    const openTar = (tar: Buffer) => open(gzipSync(tar));
    const withPax = (records: readonly (readonly [string, string])[], size?: number) =>
      candidateTarball([
        ["package/PaxHeader/x", paxBody(records), "x"],
        ["package/truncated", "1", "0", size],
        ...packageEntries(files),
      ]);

    it("reads the pax path, size and mtime records npm pack writes", () => {
      // The ustar name is a truncated stand-in; only the pax path names package.json.
      const bytes = candidateTarball([
        [
          "package/PaxHeader/package.json",
          paxBody([
            ["path", "package/package.json"],
            ["mtime", "499162500"],
            ["size", String(Buffer.byteLength(files["package.json"] as string))],
          ]),
          "x",
        ],
        ["package/truncated-name", files["package.json"] as string],
        ["package/defaults/catalog-framework-superpowers-v1.json", candidateDescriptorBytes],
      ]);
      expect(open(bytes).version).toBe("0.3.0");
    });

    it("refuses a pax size that disagrees with the header size", () => {
      // The reviewer's case: a pax-aware extractor reads "10", the header alone reads "1".
      const bytes = candidateTarball([
        [
          "package/PaxHeader/data.json",
          paxBody([
            ["path", "package/data.json"],
            ["size", "2"],
          ]),
          "x",
        ],
        ["package/data.json", "10", "0", 1],
        ...packageEntries(files),
      ]);
      expect(() => open(bytes)).toThrow(
        "Candidate Catalog: tarball pax size 2 disagrees with the header size 1 of package/data.json",
      );
      expect(() => open(withPax([["size", "0"]], 1))).toThrow(/pax size 0 disagrees/);
    });

    it.each([
      "linkpath",
      "uid",
      "gid",
      "uname",
      "gname",
      "atime",
      "ctime",
      "charset",
      "comment",
      "hdrcharset",
      "SCHILY.xattr.user.x",
      "LIBARCHIVE.xattr.user.x",
      "GNU.sparse.size",
      "GNU.sparse.realsize",
    ])("refuses the unimplemented pax key %s", (key) => {
      expect(() => open(withPax([[key, "1"]]))).toThrow(
        `Candidate Catalog: tarball has unsupported pax key ${JSON.stringify(key)}`,
      );
    });

    it("keeps a byte order mark in a pax key or value instead of decoding it away", () => {
      // The reviewer's case: a BOM-prefixed key must not become an ordinary `path` override.
      expect(() => open(withPax([["\uFEFFpath", "package/package.json"]]))).toThrow(
        `Candidate Catalog: tarball has unsupported pax key ${JSON.stringify("\uFEFFpath")}`,
      );
      expect(() => open(withPax([["\uFEFFsize", "1"]]))).toThrow(/unsupported pax key/);
      expect(() => open(withPax([["path", "\uFEFFpackage/a.json"]]))).toThrow(
        /Candidate Catalog: tarball entry \uFEFFpackage\/a.json is outside package\//u,
      );
      expect(() => open(withPax([["mtime", "\uFEFF1"]]))).toThrow(
        "Candidate Catalog: tarball has a malformed pax record",
      );
    });

    it("reads header numbers byte-exactly: only ASCII octal digits, space and NUL padding", () => {
      const tar = candidateTar(packageEntries(files));
      // Rewrite the first header's size field and re-seal its checksum.
      const withSize = (field: Buffer) => {
        const copy = Buffer.from(tar);
        const size = Buffer.alloc(12);
        field.copy(size);
        size.copy(copy, 124);
        copy.write("        ", 148);
        let sum = 0;
        for (const byte of copy.subarray(0, 512)) sum += byte;
        copy.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        return copy;
      };
      const length = Buffer.byteLength(files["package.json"] as string)
        .toString(8)
        .padStart(7, "0");
      expect(openTar(withSize(Buffer.from(` ${length}\0`, "latin1"))).version).toBe("0.3.0");
      for (const padding of ["\uFEFF", "\u3000", "\u2028", "\t", "\n"])
        expect(() => openTar(withSize(Buffer.from(`${padding}${length}\0`, "utf8")))).toThrow(
          "Candidate Catalog: tarball has a malformed header",
        );
    });

    it("keeps non-ASCII header name bytes instead of decoding them to another spelling", () => {
      expect(() =>
        open(candidateTarball([["package/\uFEFFx.json", "{}"], ...packageEntries(files)])),
      ).toThrow(/Candidate Catalog: unsafe path/);
      // A raw 0xff byte (not UTF-8) in the name: never read as U+FFFD or any other spelling.
      const tar = candidateTar([["package/Zx.json", "{}"], ...packageEntries(files)]);
      tar[8] = 0xff;
      tar.write("        ", 148);
      let sum = 0;
      for (const byte of tar.subarray(0, 512)) sum += byte;
      tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      expect(() => openTar(tar)).toThrow('Candidate Catalog: unsafe path "\u00ffx.json"');
    });

    it("refuses a package.json that is not strict UTF-8 JSON", () => {
      const manifest = Buffer.from(files["package.json"] as string);
      const invalid = Buffer.concat([
        manifest.subarray(0, -1),
        Buffer.from(',"description":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]);
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifest]);
      for (const bytes of [invalid, bom]) {
        const tar = candidateTarball(
          packageEntries(candidatePackageFiles({ "package.json": bytes })),
        );
        expect(() => open(tar)).toThrow("Candidate Catalog: package.json is not JSON");
      }
    });

    it("refuses a repeated pax key", () => {
      expect(() =>
        open(
          withPax([
            ["path", "package/a.json"],
            ["path", "package/b.json"],
          ]),
        ),
      ).toThrow("Candidate Catalog: tarball pax header repeats path");
    });

    it.each([
      ["an empty body", ""],
      ["a length with a leading zero", "019 path=package/a\n"],
      ["a non-decimal length", "x path=package/a\n"],
      ["a length past the body", "99 path=package/a\n"],
      ["a length short of the record", "10 path=package/a\n"],
      ["a record without its newline", "17 path=package/aX"],
      ["a record without '='", "13 pathvalue\n"],
      ["an empty key", "9 =value\n"],
      ["an empty path", "8 path=\n"],
      ["a non-decimal size", "12 size=1e1\n"],
      ["a malformed mtime", "14 mtime=soon\n"],
      [
        "a value that is not UTF-8",
        Buffer.concat([Buffer.from("10 path="), Buffer.from([0xff, 0x0a])]),
      ],
      ["trailing bytes after the last record", `${paxBody([["path", "package/a"]])}junk`],
    ])("refuses a pax header with %s", (_label, body) => {
      const bytes = candidateTarball([
        ["package/PaxHeader/x", body, "x"],
        ["package/a", "1"],
        ...packageEntries(files),
      ]);
      expect(() => open(bytes)).toThrow(
        /Candidate Catalog: tarball has (an empty|a malformed) pax/,
      );
    });

    it("refuses a global pax header, stacked pax headers and a pax header with no entry", () => {
      expect(() =>
        open(
          candidateTarball([
            ["pax_global_header", paxBody([["comment", "x"]]), "g"],
            ...packageEntries(files),
          ]),
        ),
      ).toThrow("Candidate Catalog: tarball has a global pax header");
      expect(() =>
        open(
          candidateTarball([
            ["package/PaxHeader/a", paxBody([["path", "package/a"]]), "x"],
            ["package/PaxHeader/b", paxBody([["path", "package/b"]]), "x"],
            ["package/c", "1"],
            ...packageEntries(files),
          ]),
        ),
      ).toThrow("Candidate Catalog: tarball has a pax header that follows a pax header");
      expect(() =>
        open(
          candidateTarball([
            ...packageEntries(files),
            ["package/PaxHeader/a", paxBody([["path", "package/a"]]), "x"],
          ]),
        ),
      ).toThrow("Candidate Catalog: tarball pax header describes no entry");
    });

    it("refuses data after the end-of-archive marker and a missing or partial marker", () => {
      const entries = packageEntries(files);
      expect(openTar(candidateTar(entries, Buffer.alloc(10240))).version).toBe("0.3.0");
      const trailing = Buffer.alloc(1536);
      trailing[1024] = 1;
      expect(() => openTar(candidateTar(entries, trailing))).toThrow(
        "Candidate Catalog: tarball has data after its end-of-archive marker",
      );
      expect(() => openTar(candidateTar(entries, Buffer.alloc(1024 + 100)))).toThrow(
        "Candidate Catalog: tarball has data after its end-of-archive marker",
      );
      // A second archive appended after the marker is also trailing data.
      expect(() =>
        openTar(Buffer.concat([candidateTar(entries), candidateTar([["package/x", "1"]])])),
      ).toThrow("Candidate Catalog: tarball has data after its end-of-archive marker");
      expect(() => openTar(candidateTar(entries, Buffer.alloc(512)))).toThrow(
        "Candidate Catalog: tarball has an incomplete end-of-archive marker",
      );
      expect(() => openTar(candidateTar(entries, Buffer.alloc(0)))).toThrow(
        "Candidate Catalog: tarball has no end-of-archive marker",
      );
      expect(() => openTar(candidateTar(entries, Buffer.from("partial")))).toThrow(
        "Candidate Catalog: tarball has no end-of-archive marker",
      );
    });
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

  it("records the package.json it interpreted, and refuses exports that remap ./package.json", async () => {
    const { candidate, descriptors } = await fresh();
    const manifest = JSON.stringify({
      name: "@aihq/catalog",
      version: "0.3.0",
      exports: {
        "./catalog-framework-superpowers.json": "./defaults/catalog-framework-superpowers-v1.json",
        "./package.json": "./metadata.json",
      },
    });
    const metadata = JSON.stringify({ name: "@aihq/catalog", version: "0.3.0" });
    const files = candidatePackageFiles({ "package.json": manifest, "metadata.json": metadata });
    const opened = candidate.openCandidateCatalogV1(
      directory(files),
      candidateListingDigest(files),
    );
    candidate.activateCandidateCatalogV1(opened);
    // Nothing read yet: the manifest that decided every export is already on the record.
    expect(candidate.activeCandidateCatalogUseV1()?.files).toEqual([
      { path: "package.json", sha256: sha256(manifest) },
    ]);
    // Like an installed package, a candidate whose exported ./package.json is not its root
    // manifest is refused before any of its files is read.
    expect(() => descriptors.loadFrameworkDescriptorSectionV1("superpowers", "vendorLock")).toThrow(
      /exports \.\/package\.json as aih-candidate-catalog:\/metadata\.json, which is not its root package\.json/,
    );
    expect(candidate.activeCandidateCatalogUseV1()?.files).toEqual([
      { path: "package.json", sha256: sha256(manifest) },
    ]);
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
