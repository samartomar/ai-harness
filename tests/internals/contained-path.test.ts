import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const interposition = vi.hoisted(() => ({
  armedPath: "",
}));

vi.mock("../../src/internals/fsxn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/internals/fsxn.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    readRegularFileWithStats(path: string, options?: { maxBytes?: number }) {
      const opened = actual.readRegularFileWithStats(path, options);
      if (opened !== undefined && path === interposition.armedPath) {
        interposition.armedPath = "";
        fs.writeFileSync(path, "after\n", "utf8");
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(path, later, later);
      }
      return opened;
    },
  };
});

const { readContainedRegularFile } = await import("../../src/internals/contained-path.js");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-contained-path-"));
});

afterEach(() => {
  interposition.armedPath = "";
  rmSync(root, { recursive: true, force: true });
});

describe("readContainedRegularFile", () => {
  it("returns bytes from a contained regular file", () => {
    writeFileSync(join(root, "settings.json"), '{"safe":true}\n', "utf8");

    expect(readContainedRegularFile(root, "settings.json", { maxBytes: 1024 })).toMatchObject({
      state: "present",
      contents: Buffer.from('{"safe":true}\n'),
    });
  });

  it("refuses an invalid relative path", () => {
    expect(readContainedRegularFile(root, "../outside.json", { maxBytes: 1024 })).toEqual({
      state: "unsafe",
      reason: "invalid-relative",
    });
  });

  it("refuses a symlink instead of following it", () => {
    const outside = join(root, "outside.json");
    const link = join(root, "link.json");
    writeFileSync(outside, '{"outside":true}\n', "utf8");
    try {
      symlinkSync(outside, link);
    } catch {
      return;
    }

    expect(readContainedRegularFile(root, "link.json", { maxBytes: 1024 })).toEqual({
      state: "unsafe",
      reason: "symlink",
    });
  });

  it("refuses bytes when the same regular file changes after its descriptor read", () => {
    const target = join(root, "settings.json");
    writeFileSync(target, "before\n", "utf8");
    const before = lstatSync(target);
    interposition.armedPath = target;

    expect(readContainedRegularFile(root, "settings.json", { maxBytes: 1024 })).toEqual({
      state: "unsafe",
      reason: "changed",
    });

    const after = lstatSync(target);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
  });
});
