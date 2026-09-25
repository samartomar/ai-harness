import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCandidateCatalogV1 } from "../../src/catalog-package/candidate-catalog.js";
import { sha256 } from "./candidate-catalog-fixture.js";

/** Replace the checked path right after `lstatSync` inspects it (CodeQL js/file-system-race). */
const race = vi.hoisted(() => ({ path: "", swap: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((...input: Parameters<typeof actual.lstatSync>) => {
      const stats = actual.lstatSync(...input);
      if (input[0] === race.path && race.swap !== undefined) {
        const swap = race.swap;
        race.swap = undefined;
        swap();
      }
      return stats;
    }) as typeof actual.lstatSync,
  };
});

const FIXTURE = fileURLToPath(
  new URL("../fixtures/packages/aihq-catalog-0.3.0-f60735e.tgz", import.meta.url),
);
const temporary: string[] = [];

afterEach(() => {
  race.path = "";
  race.swap = undefined;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function candidate(): { path: string; digest: string } {
  const root = mkdtempSync(join(tmpdir(), "aih-candidate-race-"));
  temporary.push(root);
  const path = join(root, "candidate.tgz");
  copyFileSync(FIXTURE, path);
  return { path, digest: sha256(readFileSync(path)) };
}

describe("openCandidateCatalogV1 reads the tarball it checked", () => {
  it("refuses a tarball replaced by a directory after the check", () => {
    const { path, digest } = candidate();
    race.path = path;
    race.swap = () => {
      rmSync(path);
      mkdirSync(path);
    };
    expect(() => openCandidateCatalogV1(path, digest)).toThrow(
      /^Candidate Catalog: .*candidate\.tgz is no longer the regular file that was checked/u,
    );
  });

  it("refuses a tarball replaced by a symbolic link to the same bytes after the check", () => {
    const { path, digest } = candidate();
    const target = `${path}.target`;
    copyFileSync(path, target);
    try {
      symlinkSync(target, `${path}.probe`);
      rmSync(`${path}.probe`);
    } catch {
      return; // This host cannot create symbolic links; the directory case covers the rule.
    }
    race.path = path;
    race.swap = () => {
      rmSync(path);
      symlinkSync(target, path);
    };
    expect(() => openCandidateCatalogV1(path, digest)).toThrow(
      /^Candidate Catalog: .*candidate\.tgz is no longer the regular file that was checked/u,
    );
  });
});
