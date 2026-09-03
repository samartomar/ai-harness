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
    mkdirSync(resolve(root, "scripts/lib/install"), { recursive: true });
    mkdirSync(resolve(root, ".kiro"));
    writeFileSync(resolve(root, "package.json"), '{"name":"ecc-fixture"}\n');
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'const path = require("node:path"); module.exports = require("./helper.js");\n',
    );
    writeFileSync(resolve(root, "scripts/lib/install/helper.js"), "module.exports = {};\n");
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

  it("requires runtime evidence before executing the generator", () => {
    const generate = vi.fn(() => artifact());
    const missingRuntime = { ...evidence(root), components: [] };

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: missingRuntime },
        { generate },
      ),
    ).toThrow("evidence is required");
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires evidence bound to the active catalog pin", () => {
    const generate = vi.fn(() => artifact());
    const wrongOwner = { ...evidence(root), owner: "unexpected-owner" };

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: wrongOwner },
        { generate },
      ),
    ).toThrow("not bound to the active catalog pin");
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires evidence paths to match the catalog closure", () => {
    const generate = vi.fn(() => artifact());
    const mismatchedPaths = evidence(root);
    const runtime = mismatchedPaths.components[0];
    if (runtime === undefined) throw new Error("fixture runtime evidence missing");
    mismatchedPaths.components[0] = {
      ...runtime,
      paths: [...RUNTIME_PATHS].reverse(),
    };

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: mismatchedPaths },
        { generate },
      ),
    ).toThrow("evidence paths do not match");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not execute the generator when the vetted tree drifts", () => {
    const vetted = evidence(root);
    writeFileSync(
      resolve(root, "scripts/lib/install/helper.js"),
      "module.exports = { drift: true };\n",
    );
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
        resolve(root, "scripts/lib/install/helper.js"),
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

  it("rehashes the vetted tree before propagating a generator failure", () => {
    const generate = vi.fn(() => {
      throw new Error("fixture generation failed");
    });

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: evidence(root) },
        { generate },
      ),
    ).toThrow("fixture generation failed");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("fails closed when the generator returns no artifact", () => {
    const generate = vi.fn(() => undefined as never);

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: evidence(root) },
        { generate },
      ),
    ).toThrow("returned no artifact");
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
      resolve(root, "scripts/lib/install/plan.js"),
      `${expression}; module.exports = {};\n`,
    );

    let diagnostic = "";
    try {
      assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    expect(diagnostic).toContain(message);
    expect(diagnostic).not.toContain(root);
    expect(diagnostic).not.toContain(expression);
    expect(diagnostic).not.toMatch(/unvetted-package|process\.env\.MODULE/);
  });

  it("rejects a relative dependency outside the vetted runtime paths", () => {
    writeFileSync(resolve(root, "outside.js"), "module.exports = {};\n");
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'module.exports = require("../../../outside.js");\n',
    );

    expect(() => assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS)).toThrow(
      "outside runtime:ecc-installer",
    );
  });

  it("bounds outside-closure diagnostics and honors the runtime path whitelist", () => {
    const secret = "fixture source must not appear in diagnostics";
    writeFileSync(resolve(root, "outside.js"), `module.exports = ${JSON.stringify(secret)};\n`);
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'module.exports = require("../../../outside.js");\n',
    );

    let message = "";
    try {
      assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^preview generator dependency is outside runtime:ecc-installer: /);
    expect(message).toMatch(/: outside\.js$/);
    expect(message).not.toContain(root);
    expect(message).not.toContain(secret);

    writeFileSync(
      resolve(root, "scripts/lib/install/approved-helper.js"),
      "module.exports = {};\n",
    );
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'module.exports = require("./approved-helper.js");\n',
    );
    expect(() => assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS)).not.toThrow();
  });

  it("rechecks the authorized preview boundary after Scanner evidence", () => {
    writeFileSync(resolve(root, "outside.js"), "module.exports = {};\n");
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'module.exports = require("../../../outside.js");\n',
    );
    const generate = vi.fn(() => artifact());

    expect(() =>
      generateAuthorizedEccInstallPreview(
        { eccRoot: root, catalog: catalog(), evidence: evidence(root) },
        { generate },
      ),
    ).toThrow("outside runtime:ecc-installer");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a missing relative dependency", () => {
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      'module.exports = require("./missing.js");\n',
    );

    let diagnostic = "";
    try {
      assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    expect(diagnostic).toContain("could not resolve preview generator dependency");
    expect(diagnostic).not.toContain(root);
    expect(diagnostic).not.toContain("missing.js");
  });

  it("accepts literal import and export dependencies within the vetted runtime paths", () => {
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      [
        'import "./helper.js";',
        'export * from "./helper.js";',
        'export { default as helper } from "./helper.js";',
      ].join("\n"),
    );

    expect(() => assertPreviewGeneratorDependenciesCovered(root, RUNTIME_PATHS)).not.toThrow();
  });
});
