import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashComponentTree } from "../../../src/baseline-evidence/hash.js";
import { verifyScannerComponentContainmentV1 } from "../../../src/org-policy/workbench/core/source-data-containment.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-containment-"));
  roots.push(root);
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", "one.md"), "one");
  writeFileSync(join(root, "shared", "two.md"), "two");
  const material = hashComponentTree(root, ["shared"]);
  const request = { id: "runtime:shared", paths: ["shared"], treeSha256: material.treeSha256 };
  const components = material.files.map((file, index) => ({
    componentId: `asset:${index}`,
    paths: [file.path],
    files: [{ path: file.path, digest: `sha256:${file.sha256}` }],
  }));
  return { root, request, components };
}
describe("authenticated component containment joins", () => {
  it("maps several exact file closures to one original component without modifying its identity", () => {
    const { root, request, components } = fixture();
    const original = JSON.stringify(request);
    const result = verifyScannerComponentContainmentV1(root, components, [request]);
    expect(result.map((item) => item.publishedComponentIds)).toEqual([[request.id], [request.id]]);
    expect(JSON.stringify(request)).toBe(original);
  });
  it("rejects source bytes changed after the authenticated request tree was formed", () => {
    const { root, request, components } = fixture();
    writeFileSync(join(root, "shared", "one.md"), "changed after scan request");
    expect(() => verifyScannerComponentContainmentV1(root, components, [request])).toThrow(
      /containment/,
    );
  });
  it.each(["digest", "path", "missing-file", "published-tree", "ambiguous"])(
    "rejects %s before evidence projection",
    (caseName) => {
      const { root, request, components } = fixture();
      const published = [request];
      if (caseName === "digest") components[0]!.files[0]!.digest = `sha256:${"0".repeat(64)}`;
      if (caseName === "path") components[0]!.files[0]!.path = "../outside.md";
      if (caseName === "missing-file") components[0]!.files = [];
      if (caseName === "published-tree") request.treeSha256 = "0".repeat(64);
      if (caseName === "ambiguous") published.push({ ...request, id: "runtime:duplicate" });
      expect(() => verifyScannerComponentContainmentV1(root, components, published)).toThrow(
        /containment/,
      );
    },
  );
});
