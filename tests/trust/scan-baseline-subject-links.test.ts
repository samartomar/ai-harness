import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baselineVetAnnexSubjectFilesV1,
  scanSubjectDigestV1,
} from "../../src/trust/scan-subject-files.js";
import { BASELINE, VECTOR_FILES } from "./fakes/baseline-annex-vector.js";

// ---------------------------------------------------------------------------
// The baseline subject F is what Scan's batch snapshot received (Scan
// src/baseline/batch-v1.ts at eca8231, the batch's `snapshotAnalyzerSource(
// sourceRoot, {})` :782, the "relative" link rule): the top-level `.git` is
// left out before the walk (`topLevelNames` :510-514), a link must hold a
// relative target (:606-614) that resolves through real directories to a real
// file or directory inside the snapshot (:615-624), a directory link may not
// name a directory holding a link (:625-626), and a directory link is recorded
// but never copied (D26, :669-674), so it contributes nothing. The same rule
// is at 3bd0ffb :587-610. Digests are literals computed by hand with plain
// node:crypto over the subject-files-v1 framing.
// ---------------------------------------------------------------------------

/** F = { SKILL.md, src/a.js, src/link.js } with src/link.js -> a.js, by hand. */
const WITH_FILE_LINK = {
  subjectTreeSha256: "a6ac5e4e9e7228895e223b2b7179f03fbe3fc7796fcd439b30f22232e3904d7e",
  analyzedFileCount: 3,
} as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-subject-links-"));
  for (const [path, body] of Object.entries(VECTOR_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function link(target: string, path: string, type: "file" | "dir" = "file"): void {
  symlinkSync(target, join(root, ...path.split("/")), type);
}

function subject(detectorId = "detector.semgrep") {
  return scanSubjectDigestV1(baselineVetAnnexSubjectFilesV1(detectorId, root));
}

describe("the baseline subject leaves the top-level .git out before the walk", () => {
  it.each(["detector.semgrep", "detector.skillspector", "detector.cisco"])(
    "accepts a broken link inside .git for %s: the snapshot never visits it",
    (detectorId) => {
      link("missing-object", ".git/dangling");
      expect(subject(detectorId)).toEqual(BASELINE);
    },
  );
});

describe("the baseline subject takes the links Scan's snapshot takes", () => {
  it("keys a relative file link by its path and hashes its target", () => {
    link("a.js", "src/link.js");
    expect(subject()).toEqual(WITH_FILE_LINK);
  });

  it("counts nothing for a directory link (D26)", () => {
    link("src", "lib", "dir");
    expect(subject()).toEqual(BASELINE);
  });
});

describe("the baseline subject refuses the links Scan's snapshot refuses", () => {
  it.each([
    [
      "an absolute link to a file inside the root",
      () => link(join(root, "src", "a.js"), "src/abs.js"),
      "symbolic link src/abs.js has an absolute target; Scan's baseline snapshot takes only a relative one",
    ],
    [
      "a link to a link",
      () => {
        link("a.js", "src/b.js");
        link("b.js", "src/c.js");
      },
      "symbolic link src/c.js names symbolic link src/b.js; Scan's baseline snapshot takes only a link to a real file or directory",
    ],
    [
      "a link through a directory link",
      () => {
        link("src", "lib", "dir");
        link("lib/a.js", "x.js");
      },
      "symbolic link x.js resolves through symbolic link lib; Scan's baseline snapshot takes only a link through real directories",
    ],
    [
      "a file link into .git",
      () => link("../.git/HEAD", "src/head"),
      "symbolic link src/head names .git/HEAD, inside the top-level .git that Scan's baseline snapshot leaves out",
    ],
    [
      "a broken link outside .git",
      () => link("gone.js", "src/gone-link.js"),
      "symbolic link src/gone-link.js is broken",
    ],
    [
      "a link that leaves the root",
      () => link("../../outside.js", "src/up.js"),
      "symbolic link src/up.js leaves the source root",
    ],
    [
      "a directory link naming a directory that holds a link",
      () => {
        link("a.js", "src/link.js");
        link("src", "lib", "dir");
      },
      "directory link lib names src, a directory that holds a symbolic link; Scan's baseline snapshot refuses it as a cycle",
    ],
  ])("refuses %s", (_label, arrange, message) => {
    arrange();
    expect(() => subject()).toThrow(message);
  });
});
