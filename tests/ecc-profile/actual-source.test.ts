import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectionFilesDigest, renderEccProjection } from "../../src/ecc-profile/render.js";
import { evidence, fixtureDirectory, profile, receipt } from "./render-fixture.js";

const pinnedSourceRoot = process.env.AIH_ECC_PINNED_SOURCE_ROOT;
const projectionReceipt = JSON.parse(
  await readFile(join(fixtureDirectory, "projection-receipt.json"), "utf8"),
) as {
  receiptVersion: 1;
  sourceCommit: string;
  sourceClosureId: string;
  sourceClosureSha256: string;
  projectedFileCount: number;
  projectionSha256: string;
};

async function actualEvidenceRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "aih-ecc-actual-evidence-"));
  const copies = [
    [join(fixtureDirectory, "review-receipt.json"), join(root, ...receipt.evidencePath.split("/"))],
    [
      join(fixtureDirectory, "projected-source-closure.json"),
      join(root, "evidence", "ecc", "projected-source-closure-v1.json"),
    ],
  ] as const;
  for (const [source, destination] of copies) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe.skipIf(!pinnedSourceRoot)("actual pinned ECC projection receipt", () => {
  it("reproduces the authenticated input closure and stable native projection", async () => {
    const evidenceRoot = await actualEvidenceRoot();
    try {
      const projection = await renderEccProjection(profile, evidence, {
        sourceRoot: pinnedSourceRoot ?? "",
        evidenceRoot: evidenceRoot.root,
      });
      const destinations = projection.files.map((file) => file.destination);
      const pinnedInputs = new Set(
        projection.files.flatMap((file) =>
          file.provenance.kind === "pinned-file"
            ? [file.provenance.path]
            : file.provenance.inputs.map((input) => input.path),
        ),
      );

      expect(projection.source.commit).toBe(projectionReceipt.sourceCommit);
      expect(projection.sourceClosure.id).toBe(projectionReceipt.sourceClosureId);
      expect(projection.sourceClosure.aggregateSha256).toBe(projectionReceipt.sourceClosureSha256);
      expect(pinnedInputs.size).toBe(projection.sourceClosure.fileCount);
      expect(new Set(destinations).size).toBe(destinations.length);
      expect(projection.files).toHaveLength(projectionReceipt.projectedFileCount);

      const codexWorkflows = projection.files.filter((file) =>
        file.destination.startsWith(".agents/skills/ecc-workflow-"),
      );
      expect(codexWorkflows).not.toHaveLength(0);
      for (const file of codexWorkflows) {
        expect(file.content, file.destination).not.toMatch(
          /\$ARGUMENTS|\.claude\/|mcp__|AskUserQuestion|subagent_type/,
        );
      }
      const codexRoles = projection.files.filter((file) =>
        file.destination.startsWith(".codex/agents/"),
      );
      for (const file of codexRoles) {
        expect(file.content, file.destination).not.toMatch(/\.claude\/rules|mcp__/);
      }
      expect(projectionFilesDigest(projection.files)).toBe(projectionReceipt.projectionSha256);
    } finally {
      await evidenceRoot.cleanup();
    }
  }, 120_000);
});
