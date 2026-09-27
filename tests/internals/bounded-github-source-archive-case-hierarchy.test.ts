import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBoundedGithubSourceArchiveV1,
  acquiredGithubSourceTreeEntriesV1,
  assertAcquiredGithubSourceComponentPathsV1,
  assertAcquiredGithubSourceMaterialPathsV1,
  assertAcquiredGithubSourceRootV1,
  forgetAcquiredGithubSourceArchiveV1,
  isKnownAcquiredGithubSourceRootV1,
  readAcquiredGithubSourceFileV1,
} from "../../src/internals/bounded-github-source-archive.js";

const repository = "example/repository";
const commit = "a".repeat(40);
const temporaryRoots: string[] = [];

type Entry = Readonly<{ name: string; type?: "0" | "2" | "x"; link?: string; content?: string }>;

function write(target: Buffer, offset: number, width: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), width), "ascii");
}
function writeOctal(target: Buffer, offset: number, width: number, value: number): void {
  write(target, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`);
}
function tarEntry(entry: Entry): Buffer {
  const header = Buffer.alloc(512);
  const content = Buffer.from(entry.content ?? "");
  write(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  write(header, 156, 1, entry.type ?? "0");
  write(header, 157, 100, entry.link ?? "");
  write(header, 257, 6, "ustar");
  write(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}
function paxPath(path: string): string {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (`${length}`.length + body.length !== length) length = `${length}`.length + body.length;
  return `${length}${body}`;
}
function destination(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-case-hierarchy-"));
  temporaryRoots.push(root);
  return join(root, "checkout");
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const invalidHierarchies: readonly (readonly [string, readonly Entry[]])[] = [
  [
    "a case-variant link under an earlier regular file",
    [{ name: "repository-sha/A" }, { name: "repository-sha/a/linked", type: "2", link: "target" }],
  ],
  [
    "a case-variant regular file above an earlier omitted link",
    [{ name: "repository-sha/a/linked", type: "2", link: "target" }, { name: "repository-sha/A" }],
  ],
];
const invalidArchives: readonly (readonly [string, readonly Entry[], RegExp])[] = [
  ["a parent traversal", [{ name: "repository-sha/../escape", content: "bad" }], /unsafe tar path/],
  [
    "a duplicate path",
    [
      { name: "repository-sha/a", content: "one" },
      { name: "repository-sha/a", content: "two" },
    ],
    /duplicate tar path/,
  ],
  [
    "multiple archive roots",
    [
      { name: "repository-sha/a", content: "one" },
      { name: "another-root/b", content: "two" },
    ],
    /multiple archive roots/,
  ],
  [
    "an absolute link",
    [
      { name: "repository-sha/a", content: "one" },
      { name: "repository-sha/link", type: "2", link: "/outside" },
    ],
    /unsafe tar link/,
  ],
  [
    "an unconsumed PAX path",
    [{ name: "repository-sha/PaxHeader", type: "x", content: paxPath("repository-sha/a") }],
    /unconsumed PAX path extension/,
  ],
  [
    "repeated PAX paths",
    [
      { name: "repository-sha/PaxHeader", type: "x", content: paxPath("repository-sha/a") },
      { name: "repository-sha/PaxHeader2", type: "x", content: paxPath("repository-sha/b") },
    ],
    /repeated PAX path extension/,
  ],
];

describe("bounded archive case-folded link hierarchy", () => {
  it.each(invalidHierarchies)("rejects %s", async (_label, entries) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]))),
      ),
    );
    await expect(
      acquireBoundedGithubSourceArchiveV1({ repository, commit, destination: destination() }),
    ).rejects.toThrow(/overlaps materialized path|overlaps omitted link/);
  });

  it.each(invalidArchives)(
    "rejects %s and removes the partial destination",
    async (_label, entries, error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]))),
        ),
      );
      const target = destination();
      await expect(
        acquireBoundedGithubSourceArchiveV1({ repository, commit, destination: target }),
      ).rejects.toThrow(error);
      expect(existsSync(target)).toBe(false);
    },
  );

  it("binds PAX-renamed source bytes and keeps an omitted link outside component custody", async () => {
    const entries: Entry[] = [
      {
        name: "repository-sha/PaxHeader",
        type: "x",
        content: paxPath("repository-sha/skills/tdd/SKILL.md"),
      },
      { name: "repository-sha/placeholder", content: "# TDD\n" },
      { name: "repository-sha/linked", type: "2", link: "skills/tdd/SKILL.md" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]))),
      ),
    );
    const root = await acquireBoundedGithubSourceArchiveV1({
      repository,
      commit,
      destination: destination(),
    });
    try {
      expect(
        readAcquiredGithubSourceFileV1(root, repository, commit, "skills/tdd/SKILL.md"),
      ).toEqual(Buffer.from("# TDD\n"));
      expect(acquiredGithubSourceTreeEntriesV1(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "file", path: "skills/tdd/SKILL.md" }),
          { type: "symlink", path: "linked", target: "skills/tdd/SKILL.md" },
        ]),
      );
      expect(() => assertAcquiredGithubSourceComponentPathsV1(root, ["linked"])).toThrow(
        "overlaps omitted link",
      );
      expect(
        assertAcquiredGithubSourceMaterialPathsV1(root, repository, commit, [
          "skills/tdd/SKILL.md",
        ]),
      ).toBe(true);
      expect(assertAcquiredGithubSourceMaterialPathsV1(root, repository, commit, ["linked"])).toBe(
        false,
      );
      expect(
        assertAcquiredGithubSourceMaterialPathsV1(root, repository, commit, ["../outside"]),
      ).toBe(false);
      expect(isKnownAcquiredGithubSourceRootV1(root, repository, commit)).toBe(true);
      expect(isKnownAcquiredGithubSourceRootV1(root, repository, "b".repeat(40))).toBe(false);
      expect(
        readAcquiredGithubSourceFileV1(root, repository, commit, "missing.md"),
      ).toBeUndefined();
      expect(assertAcquiredGithubSourceRootV1(root, repository, commit)).toBe(true);
      writeFileSync(join(root, "skills", "tdd", "SKILL.md"), "changed\n");
      expect(assertAcquiredGithubSourceRootV1(root, repository, commit)).toBe(false);
      expect(
        readAcquiredGithubSourceFileV1(root, repository, commit, "skills/tdd/SKILL.md"),
      ).toBeUndefined();
    } finally {
      forgetAcquiredGithubSourceArchiveV1(root);
    }
  });
});
