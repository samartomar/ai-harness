import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeEccRegistration } from "../../src/ecc-profile/native-registration.js";
import {
  buildEccProfileParityReceipt,
  eccProfileParityReceiptDigest,
} from "../../src/ecc-profile/parity-receipt.js";
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
  parityReceiptSha256: string;
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
      for (const workflow of [
        "multi-backend",
        "multi-execute",
        "multi-frontend",
        "multi-plan",
        "multi-workflow",
      ]) {
        const entry = projection.clients.codex.workflows.find(
          (candidate) => candidate.id === `/${workflow}`,
        );
        expect(entry?.transport, workflow).toBe("unavailable");
        expect(entry?.unavailableReason, workflow).toMatch(/ccg-workflow/i);
        expect(entry?.fallback, workflow).toBeTruthy();
        const file = projection.files.find(
          (candidate) =>
            candidate.destination === `.agents/skills/ecc-workflow-${workflow}/SKILL.md`,
        );
        expect(file?.content, workflow).not.toContain("<project-artifact-path>/bin");
        expect(file?.content, workflow).not.toContain("codeagent-wrapper");
      }
      const projectLocal = projection.files.find(
        (file) => file.destination === ".agents/skills/ecc-workflow-code-review/SKILL.md",
      );
      expect(projectLocal?.content).toContain("<project-artifact-path>");
      const clientGlobal = projection.clients.codex.workflows.find(
        (workflow) => workflow.id === "/skill-create",
      );
      expect(clientGlobal?.transport).toBe("unavailable");
      expect(clientGlobal?.unavailableReason).toMatch(/client-global|lifecycle/i);

      const codexSkills = projection.files.filter(
        (file) =>
          file.destination.startsWith(".agents/skills/") &&
          !file.destination.includes("ecc-workflow-"),
      );
      for (const skill of projection.clients.codex.skills) {
        expect(skill.transport, skill.id).toMatch(/^(native|normalized|unavailable)$/);
        if (skill.transport === "unavailable") {
          expect(skill.unavailableReason, skill.id).toBeTruthy();
          expect(skill.fallback, skill.id).toBeTruthy();
        }
        if (skill.transport === "normalized") {
          const normalizedFiles = codexSkills.filter(
            (file) =>
              file.destination.startsWith(`${skill.destination}/`) &&
              file.destination.endsWith(".md"),
          );
          for (const file of normalizedFiles) {
            expect(file.content, file.destination).not.toMatch(
              /\.claude\b|CLAUDE_|Claude Code|mcp__|AskUserQuestion|subagent_type|\b(?:Task|Agent) tool\b/,
            );
          }
        }
      }
      expect(codexSkills).not.toHaveLength(0);
      const reviewedCanaries = {
        "agent-sort": "unavailable",
        "browser-qa": "normalized",
        ck: "unavailable",
        "codehealth-mcp": "unavailable",
        "config-gc": "unavailable",
        "configure-ecc": "unavailable",
        "context-budget": "unavailable",
        "continuous-learning-v2": "unavailable",
      } as const;
      for (const [id, transport] of Object.entries(reviewedCanaries)) {
        expect(
          projection.clients.codex.skills.find((skill) => skill.id === id)?.transport,
          id,
        ).toBe(transport);
      }
      const codexRoles = projection.files.filter((file) =>
        file.destination.startsWith(".codex/agents/"),
      );
      for (const file of codexRoles) {
        expect(file.content, file.destination).not.toMatch(/\.claude\/rules|mcp__/);
      }
      expect(projectionFilesDigest(projection.files)).toBe(projectionReceipt.projectionSha256);

      const target = await mkdtemp(join(tmpdir(), "aih-ecc-actual-parity-target-"));
      const stateRoot = await mkdtemp(join(tmpdir(), "aih-ecc-actual-parity-state-"));
      try {
        const executable = join(stateRoot, process.platform === "win32" ? "node.exe" : "node");
        const cliScript = join(stateRoot, "cli.js");
        await writeFile(executable, "runtime", { mode: 0o755 });
        await writeFile(cliScript, "cli\n");
        const parity = buildEccProfileParityReceipt(
          projection,
          buildNativeEccRegistration({ root: target, stateRoot, executable, cliScript }),
        );
        expect(eccProfileParityReceiptDigest(parity)).toBe(projectionReceipt.parityReceiptSha256);
      } finally {
        await rm(target, { recursive: true, force: true });
        await rm(stateRoot, { recursive: true, force: true });
      }
    } finally {
      await evidenceRoot.cleanup();
    }
  }, 120_000);
});
