import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBoundedGithubSourceArchiveV1 } from "../../src/internals/bounded-github-source-archive.js";

const repository = "example/repository";
const commit = "a".repeat(40);
const temporaryRoots: string[] = [];

type Entry = Readonly<{ name: string; type?: "0" | "2"; link?: string }>;

function write(target: Buffer, offset: number, width: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), width), "ascii");
}
function writeOctal(target: Buffer, offset: number, width: number, value: number): void {
  write(target, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`);
}
function tarEntry(entry: Entry): Buffer {
  const header = Buffer.alloc(512);
  write(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  write(header, 156, 1, entry.type ?? "0");
  write(header, 157, 100, entry.link ?? "");
  write(header, 257, 6, "ustar");
  write(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  return header;
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
});
