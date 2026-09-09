import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";
import { prepareRegisteredScannerCatalogV1 } from "../../src/baseline-evidence/scanner-provider-catalogs.js";
import {
  acquireBoundedGithubSourceArchiveV1,
  assertAcquiredGithubSourceComponentPathsV1,
  assertAcquiredGithubSourceMaterialPathsV1,
  assertAcquiredGithubSourceRootV1,
  BOUNDED_GITHUB_SOURCE_ARCHIVE_LIMITS_V1,
  forgetAcquiredGithubSourceArchiveV1,
  readAcquiredGithubSourceFileV1,
} from "../../src/internals/bounded-github-source-archive.js";
import * as ponytailProvider from "../../src/org-policy/workbench/providers/ponytail.js";

type TarEntry = Readonly<{
  name: string;
  bytes?: Buffer;
  type?: string;
  link?: string;
  declaredSize?: number;
}>;
const injected = vi.hoisted(() => ({
  ponytail: undefined as
    | ReturnType<typeof ponytailProvider.ponytailComponentCollectionFixtureV1>
    | undefined,
}));
vi.mock("../../src/org-policy/workbench/providers/ponytail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ponytailProvider>();
  return {
    ...actual,
    ponytailPinnedComponentCollectionV1: () =>
      injected.ponytail ?? actual.ponytailPinnedComponentCollectionV1(),
  };
});
const repository = "example/repository";
const commit = "a".repeat(40);
const roots: string[] = [];

function writeField(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), length), "ascii");
}
function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  writeField(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}
function tarEntry(entry: TarEntry): Buffer {
  const bytes = entry.bytes ?? Buffer.alloc(0);
  const size = entry.declaredSize ?? bytes.length;
  const header = Buffer.alloc(512);
  writeField(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, entry.type ?? "0");
  writeField(header, 157, 100, entry.link ?? "");
  writeField(header, 257, 6, "ustar");
  writeField(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
function paxPath(path: string): Buffer {
  const body = `path=${path}\n`;
  let record = `0 ${body}`;
  for (;;) {
    const next = `${Buffer.byteLength(record, "utf8")} ${body}`;
    if (next === record) return Buffer.from(next, "utf8");
    record = next;
  }
}
function gzipped(entries: readonly TarEntry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "aih-bounded-archive-"));
  roots.push(value);
  return value;
}
function stubArchive(bytes: Buffer): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  injected.ponytail = undefined;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("bounded GitHub source archive acquisition", () => {
  it("accepts shared declared files across independently identified components", async () => {
    const fixture = ponytailProvider.ponytailComponentCollectionFixtureV1();
    fixture.source.repository = `https://github.com/${repository}`;
    const component = fixture.components[0];
    if (!component) throw new Error("Fixture component missing");
    fixture.components.push({ ...component, id: "skill:shared", label: "Shared fixture file" });
    injected.ponytail = fixture;
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([{ name: "repository-sha/skills/main/SKILL.md", bytes: Buffer.from("x") }]),
    );
    await acquireBoundedGithubSourceArchiveV1({ repository, commit, destination });
    const prepared = prepareRegisteredScannerCatalogV1(destination, "ponytail");
    expect(prepared.coverage?.components).toHaveLength(2);
    expect(prepared.coverage?.components.map((item) => item.paths)).toEqual([
      ["skills/main/SKILL.md"],
      ["skills/main/SKILL.md"],
    ]);
  });

  it("preserves source link identity while hashing only each component's declared files", async () => {
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([
        { name: "repository-sha/one/SKILL.md", bytes: Buffer.from("first") },
        { name: "repository-sha/two/SKILL.md", bytes: Buffer.from("second") },
        { name: "repository-sha/AGENTS.md", type: "2", link: "one/SKILL.md" },
      ]),
    );
    await acquireBoundedGithubSourceArchiveV1({ repository, commit, destination });
    const first = hashComponentTree(destination, ["one"]);
    const second = hashComponentTree(destination, ["two"]);
    expect(first.files.map((file) => file.path)).toEqual(["one/SKILL.md"]);
    expect(second.files.map((file) => file.path)).toEqual(["two/SKILL.md"]);
    expect(first.treeSha256).not.toBe(second.treeSha256);
    const fileEntry = (path: string, text: string) => ({
      type: "file",
      path,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    const literalTree = [
      { type: "symlink", path: "AGENTS.md", target: "one/SKILL.md" },
      { type: "directory", path: "one" },
      fileEntry("one/SKILL.md", "first"),
      { type: "directory", path: "two" },
      fileEntry("two/SKILL.md", "second"),
    ];
    expect(hashSourceTree(destination).treeSha256).toBe(
      createHash("sha256").update(JSON.stringify(literalTree)).digest("hex"),
    );
    writeFileSync(join(destination, "extra.md"), "unpublished");
    expect(() => hashSourceTree(destination)).toThrow(/changed after extraction/);
  });

  it("streams an exact codeload archive with only safe PAX metadata into a private root", async () => {
    const destination = join(root(), "checkout");
    const fetch = stubArchive(
      gzipped([
        { name: "pax_global_header", type: "g", bytes: Buffer.from(`52 comment=${commit}\n`) },
        { name: "PaxHeader", type: "x", bytes: paxPath("repository-sha/README.md") },
        { name: "ignored", bytes: Buffer.from("safe") },
      ]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).resolves.toBe(destination);
    expect(fetch).toHaveBeenCalledWith(
      `https://codeload.github.com/${repository}/tar.gz/${commit}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("safe");
    expect(assertAcquiredGithubSourceRootV1(destination, repository, commit)).toBe(true);
    expect(
      readAcquiredGithubSourceFileV1(destination, repository, commit, "README.md")?.toString(),
    ).toBe("safe");
    forgetAcquiredGithubSourceArchiveV1(destination);
    expect(assertAcquiredGithubSourceRootV1(destination, repository, commit)).toBe(false);
  });

  it("omits an unrelated link but rejects declared material that overlaps it", async () => {
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([
        { name: "repository-sha/skills/main/SKILL.md", bytes: Buffer.from("safe") },
        { name: "repository-sha/AGENTS.md", type: "2", link: "CLAUDE.md" },
      ]),
    );
    await acquireBoundedGithubSourceArchiveV1({ repository, commit, destination });
    expect(assertAcquiredGithubSourceRootV1(destination, repository, commit)).toBe(true);
    expect(
      assertAcquiredGithubSourceMaterialPathsV1(destination, repository, commit, [
        "skills/main/SKILL.md",
      ]),
    ).toBe(true);
    expect(
      assertAcquiredGithubSourceMaterialPathsV1(destination, repository, commit, ["AGENTS.md"]),
    ).toBe(false);
  });

  it("rejects a component directory that contains an omitted link", async () => {
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([
        { name: "repository-sha/skills/main/SKILL.md", bytes: Buffer.from("safe") },
        { name: "repository-sha/skills/linked", type: "2", link: "elsewhere" },
      ]),
    );
    await acquireBoundedGithubSourceArchiveV1({ repository, commit, destination });
    expect(() => assertAcquiredGithubSourceComponentPathsV1(destination, ["skills"])).toThrow(
      /declared component material overlaps omitted link/,
    );
    expect(() => hashComponentTree(destination, ["skills"])).toThrow(
      /declared component material overlaps omitted link/,
    );
  });
  it("rejects a link whose path overlaps already materialized source", async () => {
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([
        { name: "repository-sha/skills/main/SKILL.md", bytes: Buffer.from("safe") },
        { name: "repository-sha/skills", type: "2", link: "other" },
      ]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/link overlaps materialized path/);
  });
  it.each([
    [
      "a regular file below a prior omitted link",
      [
        { name: "repository-sha/alias", type: "2", link: "target" },
        { name: "repository-sha/alias/file", bytes: Buffer.from("unsafe") },
      ],
    ],
    [
      "a regular file above a prior omitted link",
      [
        { name: "repository-sha/alias/file", type: "2", link: "target" },
        { name: "repository-sha/alias", bytes: Buffer.from("unsafe") },
      ],
    ],
    [
      "a link below a prior regular file",
      [
        { name: "repository-sha/alias", bytes: Buffer.from("safe") },
        { name: "repository-sha/alias/file", type: "2", link: "target" },
      ],
    ],
    [
      "a link above a prior explicit directory",
      [
        { name: "repository-sha/alias/file", type: "5" },
        { name: "repository-sha/alias", type: "2", link: "target" },
      ],
    ],
  ])("rejects %s", async (_label, entries) => {
    const destination = join(root(), "checkout");
    stubArchive(gzipped(entries));
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/overlaps materialized path|overlaps omitted link/);
  });

  it("allows an omitted link below a materialized parent directory", async () => {
    const destination = join(root(), "checkout");
    stubArchive(
      gzipped([
        { name: "repository-sha/README.md", bytes: Buffer.from("safe") },
        { name: "repository-sha/alias", type: "5" },
        { name: "repository-sha/alias/link", type: "2", link: "target" },
      ]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).resolves.toBe(destination);
  });
  it("rejects a nested destination beneath a symlinked temporary parent", async () => {
    const parent = root();
    const target = join(parent, "target");
    mkdirSync(join(target, "nested"), { recursive: true });
    const linked = join(parent, "linked");
    symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    const fetch = stubArchive(
      gzipped([{ name: "repository-sha/README.md", bytes: Buffer.from("safe") }]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({
        repository,
        commit,
        destination: join(linked, "nested", "checkout"),
      }),
    ).rejects.toThrow(/destination parent is unsafe/);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(target, "nested", "checkout"))).toBe(false);
  });
  it("preserves a pre-existing destination instead of treating it as owned cleanup", async () => {
    const destination = join(root(), "checkout");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "keep", { flag: "wx" });
    const fetch = stubArchive(
      gzipped([{ name: "repository-sha/README.md", bytes: Buffer.from("safe") }]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/destination already exists/);
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("keep");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects additions after acquisition rather than compiling a changed whole tree", async () => {
    const destination = join(root(), "checkout");
    stubArchive(gzipped([{ name: "repository-sha/README.md", bytes: Buffer.from("safe") }]));
    await acquireBoundedGithubSourceArchiveV1({ repository, commit, destination });
    mkdirSync(join(destination, "unexpected"));
    writeFileSync(join(destination, "unexpected", "added.md"), "changed", { flag: "wx" });
    expect(assertAcquiredGithubSourceRootV1(destination, repository, commit)).toBe(false);
    expect(
      readAcquiredGithubSourceFileV1(destination, repository, commit, "README.md")?.toString(),
    ).toBe("safe");
  });

  it("rejects an advertised compressed archive over the fixed stream limit before reading it", async () => {
    const destination = join(root(), "checkout");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not read", {
            headers: {
              "content-length": String(BOUNDED_GITHUB_SOURCE_ARCHIVE_LIMITS_V1.compressedBytes + 1),
            },
          }),
      ),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/compressed archive exceeds byte limit/);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a PAX path that exceeds the bounded directory depth", async () => {
    const destination = join(root(), "checkout");
    const deepPath = `repository-sha/${Array.from({ length: 65 }, () => "nested").join("/")}/file`;
    stubArchive(
      gzipped([
        { name: "PaxHeader", type: "x", bytes: paxPath(deepPath) },
        { name: "ignored", bytes: Buffer.from("x") },
      ]),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/unsafe tar path/);
    expect(existsSync(destination)).toBe(false);
  });
  it.each([
    ["path traversal", gzipped([{ name: "repository-sha/../escape", bytes: Buffer.from("x") }])],

    [
      "duplicate file",
      gzipped([
        { name: "repository-sha/README.md", bytes: Buffer.from("first") },
        { name: "repository-sha/README.md", bytes: Buffer.from("second") },
      ]),
    ],
    [
      "oversized declared entry",
      gzipped([
        {
          name: "repository-sha/large",
          declaredSize: BOUNDED_GITHUB_SOURCE_ARCHIVE_LIMITS_V1.entryBytes + 1,
        },
      ]),
    ],
  ])("rejects a %s archive before it becomes a source root", async (_label, archive) => {
    const destination = join(root(), "checkout");
    stubArchive(archive);
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination }),
    ).rejects.toThrow(/Bounded GitHub source archive/);
    expect(existsSync(destination)).toBe(false);
    expect(assertAcquiredGithubSourceRootV1(destination, repository, commit)).toBe(false);
  });
});
