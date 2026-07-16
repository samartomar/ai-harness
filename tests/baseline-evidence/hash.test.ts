import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-hash-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const target = join(root, rel);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

describe("hashComponentTree", () => {
  it("is deterministic across declared-root order and reports sorted POSIX paths", () => {
    put("alpha/z.txt", "z");
    put("beta/a.txt", "a");

    const left = hashComponentTree(root, ["beta", "alpha"]);
    const right = hashComponentTree(root, ["alpha", "beta"]);

    expect(left).toEqual(right);
    expect(left.files.map((file) => file.path)).toEqual(["alpha/z.txt", "beta/a.txt"]);
  });

  it("commits to both file bytes and source-relative paths", () => {
    put("one/file.txt", "same bytes");
    put("two/file.txt", "same bytes");
    const one = hashComponentTree(root, ["one"]);
    const two = hashComponentTree(root, ["two"]);
    expect(one.treeSha256).not.toBe(two.treeSha256);

    put("one/file.txt", "changed bytes");
    expect(hashComponentTree(root, ["one"]).treeSha256).not.toBe(one.treeSha256);
  });

  it("rejects source escapes, duplicate normalized roots, and missing paths", () => {
    put("component/file.txt", "ok");
    expect(() => hashComponentTree(root, ["../escape"])).toThrow(/outside|escape|parent/i);
    expect(() => hashComponentTree(root, ["component", "./component"])).toThrow(/duplicate/i);
    expect(() => hashComponentTree(root, ["missing"])).toThrow(/missing|does not exist/i);
  });

  it("fails closed on symlinks and hard-linked files", () => {
    put("component/file.txt", "ok");
    symlinkSync("file.txt", join(root, "component", "link.txt"));
    expect(() => hashComponentTree(root, ["component"])).toThrow(/symbolic|symlink/i);

    rmSync(join(root, "component", "link.txt"));
    linkSync(join(root, "component", "file.txt"), join(root, "component", "hard.txt"));
    expect(() => hashComponentTree(root, ["component"])).toThrow(/hard.link/i);
  });
});

describe("hashSourceTree", () => {
  it("hashes the complete inert working tree while excluding Git metadata", () => {
    put("provider/manifest.json", "{}");
    put(".git/HEAD", "ref: refs/heads/main");
    const first = hashSourceTree(root);

    put(".git/HEAD", "ref: refs/heads/other");
    expect(hashSourceTree(root)).toEqual(first);

    put("provider/manifest.json", "{\"changed\":true}");
    expect(hashSourceTree(root).treeSha256).not.toBe(first.treeSha256);
  });
});
