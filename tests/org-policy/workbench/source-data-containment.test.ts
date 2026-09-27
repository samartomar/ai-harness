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
  it("accepts overlapping published owners with the compiler file digest in compiler-catalog mode", () => {
    const { root, request, components } = fixture();
    const duplicate = { ...request, id: "runtime:duplicate" };
    const published = [request, duplicate];
    expect(
      verifyScannerComponentContainmentV1(root, components, published, "compiler-catalog").map(
        (item) => item.publishedComponentIds,
      ),
    ).toEqual(components.map(() => [duplicate.id, request.id]));
  });
  it("refuses a conflicting published owner's tree digest", () => {
    const { root, request, components } = fixture();
    const published = [
      request,
      { ...request, id: "runtime:duplicate", treeSha256: "0".repeat(64) },
    ];
    expect(() =>
      verifyScannerComponentContainmentV1(root, components, published, "compiler-catalog"),
    ).toThrow(/containment/);
  });
  it("refuses overlap on a file outside the declared compiler input", () => {
    const { root, request, components } = fixture();
    const published = [request, { ...request, id: "runtime:duplicate" }];
    expect(() =>
      verifyScannerComponentContainmentV1(
        root,
        components.slice(0, 1),
        published,
        "compiler-catalog",
      ),
    ).toThrow(/containment/);
  });
  it("refuses overlap when the declared compiler digest differs from both published owners", () => {
    const { root, request, components } = fixture();
    const published = [request, { ...request, id: "runtime:duplicate" }];
    const file = components[0]?.files[0];
    if (!file) throw new Error("fixture");
    file.digest = `sha256:${"0".repeat(64)}`;
    expect(() =>
      verifyScannerComponentContainmentV1(root, components, published, "compiler-catalog"),
    ).toThrow(/containment/);
  });
  it("refuses a declared file with no published owner in compiler-catalog mode", () => {
    const { root, request, components } = fixture();
    const published = [
      {
        ...request,
        paths: ["shared/one.md"],
        treeSha256: hashComponentTree(root, ["shared/one.md"]).treeSha256,
      },
    ];
    expect(() =>
      verifyScannerComponentContainmentV1(root, components, published, "compiler-catalog"),
    ).toThrow(/containment/);
  });
  it("allows an extra published component with separate files", () => {
    const { root, request, components } = fixture();
    writeFileSync(join(root, "extra.md"), "extra");
    const extra = hashComponentTree(root, ["extra.md"]);
    const published = [
      request,
      { id: "runtime:extra", paths: ["extra.md"], treeSha256: extra.treeSha256 },
    ];
    expect(
      verifyScannerComponentContainmentV1(root, components, published, "compiler-catalog").map(
        (item) => item.publishedComponentIds,
      ),
    ).toEqual(components.map(() => [request.id]));
  });
  it("keeps disjoint overlap refusal as the default and explicit mode", () => {
    const { root, request, components } = fixture();
    const published = [request, { ...request, id: "runtime:duplicate" }];
    expect(() => verifyScannerComponentContainmentV1(root, components, published)).toThrow(
      /containment/,
    );
    expect(() =>
      verifyScannerComponentContainmentV1(root, components, published, "disjoint"),
    ).toThrow(/containment/);
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
