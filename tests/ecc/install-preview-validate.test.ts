import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import type {
  ContingentEccInstallOperation,
  EccInstallPreviewArtifact,
} from "../../src/ecc/install-preview.js";
import { validateEccInstallPreviewArtifact } from "../../src/ecc/install-preview-validate.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-preview-validate-"));
  writeFileSync(join(root, "runtime.js"), "export {};\n", "utf8");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture(): {
  artifact: EccInstallPreviewArtifact;
  catalog: ReturnType<typeof defineBaselineCatalog>;
} {
  const catalog = defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [{ id: "runtime:ecc-installer", paths: ["runtime.js"] }],
  });
  const targets = [
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "gemini",
    "opencode",
    "zed",
  ] as const;
  const operations: ContingentEccInstallOperation[] = targets.map((target) => ({
    target,
    kind: "exec",
    source: "runtime.js",
    destination: `<home>/.${target}`,
    componentId: "runtime:ecc-installer",
    contingentOn: "evidence-authorization",
  }));
  operations.push({
    target: "kiro",
    kind: "exec",
    source: "runtime.js",
    destination: "<project>/.kiro",
    componentId: "runtime:ecc-kiro",
    contingentOn: "evidence-authorization",
  });
  operations.sort((left, right) =>
    [left.target, left.componentId, left.kind, left.destination, left.source]
      .join("\0")
      .localeCompare(
        [right.target, right.componentId, right.kind, right.destination, right.source].join("\0"),
      ),
  );
  return {
    catalog,
    artifact: {
      schemaVersion: 1,
      source: { owner: catalog.owner, repo: catalog.repo, pinnedSha: catalog.pinnedSha },
      operations,
    },
  };
}

describe("ECC install preview structural validation", () => {
  it("accepts sorted, contained, pin-bound runtime metadata", () => {
    const { artifact, catalog } = fixture();
    expect(() => validateEccInstallPreviewArtifact(root, catalog, artifact)).not.toThrow();
  });

  it("fails closed on pin drift and escaping source paths", () => {
    const { artifact, catalog } = fixture();
    expect(() =>
      validateEccInstallPreviewArtifact(root, catalog, {
        ...artifact,
        source: { ...artifact.source, pinnedSha: "b".repeat(40) },
      }),
    ).toThrow(/active catalog pin/);
    const operations = artifact.operations.map((operation, index) =>
      index === 0 ? { ...operation, source: "../outside.js" } : operation,
    );
    expect(() =>
      validateEccInstallPreviewArtifact(root, catalog, { ...artifact, operations }),
    ).toThrow(/escapes the pinned checkout/);
  });
});
