import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { resolveExactLocalSource } from "../../src/methodology/source.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-methodology-source-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "provider.md"), "inert source", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("exact local methodology sources", () => {
  it("binds a local checkout to unchanged HEAD and an inert tree hash", async () => {
    const calls: string[][] = [];
    const resolvedCommit = "a".repeat(40);
    const source = await resolveExactLocalSource(
      { repository: "garrytan/gstack", root, resolvedCommit },
      fakeRunner((argv) => {
        calls.push(argv);
        return { stdout: `${resolvedCommit}\n` };
      }),
    );

    expect(source).toMatchObject({ repository: "garrytan/gstack", resolvedCommit });
    expect(source.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([
      ["git", "-C", root, "rev-parse", "--verify", "HEAD"],
      ["git", "-C", root, "rev-parse", "--verify", "HEAD"],
    ]);
  });

  it("refuses a mismatched or changing HEAD before issuing evidence", async () => {
    const resolvedCommit = "a".repeat(40);
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root, resolvedCommit },
        fakeRunner(() => ({ stdout: `${"b".repeat(40)}\n` })),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
  });

  it("refuses unavailable roots and invalid Git output before hashing", async () => {
    const resolvedCommit = "a".repeat(40);
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "inert", "utf8");
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root: join(root, "missing"), resolvedCommit },
        fakeRunner(() => ({ stdout: `${resolvedCommit}\n` })),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root, resolvedCommit },
        fakeRunner(() => ({ stdout: "main\n" })),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root: fileRoot, resolvedCommit },
        fakeRunner(() => ({ stdout: `${resolvedCommit}\n` })),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root, resolvedCommit: "deadbeef" },
        fakeRunner(() => ({ stdout: `${resolvedCommit}\n` })),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
  });

  it("refuses source mutation between inert tree reads", async () => {
    const resolvedCommit = "a".repeat(40);
    let reads = 0;
    await expect(
      resolveExactLocalSource(
        { repository: "garrytan/gstack", root, resolvedCommit },
        fakeRunner(() => {
          reads += 1;
          return { stdout: `${reads === 1 ? resolvedCommit : "b".repeat(40)}\n` };
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_SOURCE_UNRESOLVED" });
  });
});
