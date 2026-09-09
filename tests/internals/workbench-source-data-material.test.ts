import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  restoreSourceCompilerTemplateV1,
  sourceCompilerTemplateV1,
} from "../../src/internals/workbench-source-data-material.js";

const roots: string[] = [];
function fixture(contents = "original source") {
  const root = mkdtempSync(join(tmpdir(), "aih-source-template-"));
  roots.push(root);
  const bytes = Buffer.from(contents);
  writeFileSync(join(root, "SKILL.md"), bytes);
  const input = {
    files: [
      {
        path: "SKILL.md",
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        bytesBase64: bytes.toString("base64"),
      },
    ],
  };
  return { root, input, template: sourceCompilerTemplateV1(input) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("packaged source material reconstruction", () => {
  it.each(["original source", ""])(
    "restores exact original compiler bytes, including empty files (%j)",
    (contents) => {
      const { root, input, template } = fixture(contents);
      expect(restoreSourceCompilerTemplateV1(template, root)).toEqual(input);
    },
  );
  it("rejects changed source bytes of the same length", () => {
    const { root, template } = fixture("original");
    writeFileSync(join(root, "SKILL.md"), "modified");
    expect(() => restoreSourceCompilerTemplateV1(template, root)).toThrow(/identity mismatch/);
  });
  it("rejects file length changes", () => {
    const { root, template } = fixture();
    writeFileSync(join(root, "SKILL.md"), "short");
    expect(() => restoreSourceCompilerTemplateV1(template, root)).toThrow(/bounds/);
  });
  it("rejects traversal and forged original file hashes", () => {
    const { input } = fixture();
    const file = input.files[0];
    if (!file) throw new Error("Missing fixture file");
    file.path = "../SKILL.md";
    expect(() => sourceCompilerTemplateV1(input)).toThrow();
    file.path = "SKILL.md";
    file.sha256 = `sha256:${"0".repeat(64)}`;
    expect(() => sourceCompilerTemplateV1(input)).toThrow(/identity mismatch/);
  });
  it("rejects reserved marker injection and malformed reconstruction references", () => {
    const { root } = fixture();
    expect(() => sourceCompilerTemplateV1({ __aihSourceFileV1: {} })).toThrow(/Reserved/);
    expect(() =>
      restoreSourceCompilerTemplateV1(
        {
          __aihSourceFileV1: { path: "../SKILL.md", sha256: `sha256:${"a".repeat(64)}`, bytes: 0 },
        },
        root,
      ),
    ).toThrow();
  });
});
