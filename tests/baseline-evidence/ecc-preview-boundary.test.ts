import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BaselineCatalog,
  defineBaselineCatalog,
} from "../../src/baseline-evidence/catalog.js";
import {
  assertPreviewGeneratorDependenciesCovered,
  generateAuthorizedEccInstallPreview,
} from "../../src/baseline-evidence/ecc-preview-boundary.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import type { BaselineSourceEvidence } from "../../src/baseline-evidence/schema.js";
import type { EccInstallPreviewArtifact } from "../../src/ecc/install-preview.js";

const PIN = "1234567890abcdef1234567890abcdef12345678";
const RUNTIME_PATHS = ["package.json", "scripts"] as const;
const DIRECT_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "opencode",
  "zed",
] as const;

function artifact(): EccInstallPreviewArtifact {
  const operations: EccInstallPreviewArtifact["operations"] = [
    ...DIRECT_TARGETS.map((target) => ({
      target,
      kind: "exec" as const,
      destination: `runtime/${target}`,
      componentId: "runtime:ecc-installer",
      contingentOn: "evidence-authorization" as const,
    })),
    {
      target: "kiro" as const,
      kind: "exec" as const,
      destination: "runtime/kiro",
      componentId: "runtime:ecc-kiro",
      contingentOn: "evidence-authorization" as const,
    },
  ];
  operations.sort((left, right) =>
    [left.target, left.componentId, left.kind, left.destination, left.source ?? ""]
      .join("\0")
      .localeCompare(
        [right.target, right.componentId, right.kind, right.destination, right.source ?? ""].join(
          "\0",
        ),
      ),
  );
  return {
    schemaVersion: 1,
    source: { owner: "affaan-m", repo: "ECC", pinnedSha: PIN },
    operations,
  };
}

function catalog(): BaselineCatalog {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: PIN,
    components: [
      { id: "runtime:ecc-installer", paths: RUNTIME_PATHS },
      { id: "runtime:ecc-kiro", paths: [".kiro"] },
    ],
  });
}

function evidence(root: string, verdict: "pass" | "blocked" = "pass"): BaselineSourceEvidence {
  return {
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: PIN,
    components: [
      {
        id: "runtime:ecc-installer",
        paths: [...RUNTIME_PATHS],
        treeSha256: hashComponentTree(root, RUNTIME_PATHS).treeSha256,
        verdict,
        analyzers: [{ name: "fixture", version: "1" }],
        findings:
          verdict === "blocked" ? [{ code: "AUTO_EXEC_HOOK", detail: "blocked fixture" }] : [],
      },
    ],
  };
}

describe("ECC install preview execution boundary", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "aih-ecc-preview-boundary-"));
    mkdirSync(resolve(root, "scripts/lib/install-targets"), { recursive: true });
    mkdirSync(resolve(root, ".kiro"));
    writeFileSync(resolve(root, "package.json"), '{"name":"ecc-fixture"}\n');
    writeFileSync(
      resolve(root, "scripts/lib/install-executor.js"),
      'const path = require("node:path"); module.exports = require("./helper.js");\n',
    );
    writeFileSync(resolve(root, "scripts/lib/helper.js"), "module.exports = {};\n");
    writeFileSync(resolve(root, "scripts/lib/install-manifests.js"), "module.exports = {};\n");
    writeFileSync(
      resolve(root, "scripts/lib/install-targets/registry.js"),
      "module.exports = {};\n",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("executes the generator only after passing evidence and an unchanged rehash", () => {
    const generate = vi.fn(() => artifact());

    const result = generateAuthorizedEccInstallPreview(
      { eccRoot: root, catalog: catalog(), evidence: evidence(root) },
      { generate },
    );

    expect(generate).toHaveBeenCalledWith(root, PIN);
    expect(result).toEqual(artifact());
  });

  it("does not execute the generator when runtime authorization is blocked", () => {
    const generate = vi.fn(() => artifact());

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: evidence(root, "blocked") },
        { generate },
      ),
    ).toThrow("must pass");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not execute the generator when the vetted tree drifts", () => {
    const vetted = evidence(root);
    writeFileSync(resolve(root, "scripts/lib/helper.js"), "module.exports = { drift: true };\n");
    const generate = vi.fn(() => artifact());

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: vetted },
        { generate },
      ),
    ).toThrow("changed after vet");
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails when the generator mutates the vetted tree", () => {
    const generate = vi.fn(() => {
      writeFileSync(
        resolve(root, "scripts/lib/helper.js"),
        "module.exports = { mutated: true };\n",
      );
      return artifact();
    });

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: evidence(root) },
        { generate },
      ),
    ).toThrow("changed during preview generation");
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    ['require("unvetted-package")', "unvetted package import"],
    ["require(process.env.MODULE)", "dynamic require"],
    ['require.resolve("unvetted-package")', "unvetted package import"],
    ["require.resolve(process.env.MODULE)", "dynamic require.resolve"],
    ['import("unvetted-package")', "unvetted package import"],
    ["import(process.env.MODULE)", "dynamic import()"],
  ])("rejects an unvetted dependency load: %s", (expression, message) => {
    writeFileSync(
      resolve(root, "scripts/lib/install-executor.js"),
      `${expression}; module.exports = {};\n`,
    );

    expect(() => assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS)).toThrow(message);
  });

  it("rejects a relative dependency outside the vetted runtime paths", () => {
    writeFileSync(resolve(root, "outside.js"), "module.exports = {};\n");
    writeFileSync(
      resolve(root, "scripts/lib/install-executor.js"),
      'module.exports = require("../../outside.js");\n',
    );

    expect(() => assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS)).toThrow(
      "outside runtime:ecc-installer",
    );
  });
});
