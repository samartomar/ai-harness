import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { resolveOrgBaselineEvidence } from "../../src/baseline-evidence/org.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { orgPolicyPath, parseOrgPolicy } from "../../src/org-policy/schema.js";
import { compilePolicy } from "../../src/org-policy/workbench/policy-compiler.js";
import { importWorkbenchPolicySelections } from "../../src/org-policy/workbench/policy-import.js";
import { packagedPreparedWorkbenchCatalogV1 } from "../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../src/org-policy/workbench/selection-engine.js";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function put(root: string, relative: string, contents: string | Buffer): void {
  const path = join(root, ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
function tree(root: string, values: Record<string, string | Buffer>): void {
  for (const [path, contents] of Object.entries(values)) put(root, path, contents);
}

function authorPolicy() {
  const prepared = packagedPreparedWorkbenchCatalogV1();
  let state = createWorkbenchState();
  const selected = reduceWorkbenchAction(prepared.bundle, state, {
    type: "select-root",
    assetId: "ecc/skill:tdd-workflow",
    origin: { kind: "administrator" },
  });
  expect(selected.accepted).toBe(true);
  state = selected.state;
  const excluded = reduceWorkbenchAction(prepared.bundle, state, {
    type: "add-exclusion",
    assetId: "ecc/skill:frontend-patterns",
    origin: { kind: "administrator" },
  });
  expect(excluded.accepted).toBe(true);
  state = excluded.state;
  const compiled = compilePolicy(
    {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        supportedClis: ["codex"],
        catalog: { reviewed: [], custom: [] },
        policyVersion: "fictional-adopter-v1",
      },
    },
    state,
    prepared.bundle,
    prepared.bindings,
    "author",
    prepared.sourceInputs,
  );
  expect(compiled.accepted).toBe(true);
  const exported = JSON.parse(JSON.stringify(compiled.policy)) as Record<string, unknown>;
  const reopened = importWorkbenchPolicySelections(
    exported,
    prepared.bundle,
    prepared.bindings,
    prepared.sourceInputs,
  );
  expect(reopened.accepted).toBe(true);
  expect(reopened.state).toEqual(state);
  const governance = exported.governance as { externalSelections?: unknown[] };
  const selection = governance.externalSelections?.find(
    (
      entry,
    ): entry is {
      framework: string;
      items: Array<{ source: { repository: string; commit: string } }>;
    } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { framework?: unknown }).framework === "ecc",
  );
  const source = selection?.items[0]?.source;
  if (source === undefined) throw new Error("compiled fixture policy omitted its ECC source tuple");
  const [owner, repo] = source.repository.split("/");
  if (owner === undefined || repo === undefined)
    throw new Error("compiled ECC repository is invalid");
  return { policy: exported, source: { owner, repo, pinnedSha: source.commit } };
}

function sourceWithTdd(): { source: string; bytes: Buffer } {
  const source = mkdtempSync(join(tmpdir(), "aih-portable-ecc-source-"));
  roots.push(source);
  // Fixture guidance deliberately has no upstream-content or qualification claim.
  const bytes = Buffer.from(
    "# TDD fixture guidance\n\nSynthetic portable-adopter content.\n",
    "utf8",
  );
  tree(source, {
    "skills/tdd-workflow/SKILL.md": bytes,
    ".agents/skills/tdd-workflow/SKILL.md": bytes,
  });
  return { source, bytes };
}

function catalogFor(source: { owner: string; repo: string; pinnedSha: string }) {
  return defineBaselineCatalog({
    id: "ecc",
    ...source,
    components: [
      { id: "skill:tdd-workflow", paths: [".agents/skills/tdd-workflow", "skills/tdd-workflow"] },
    ],
  });
}
function lockFor(sourceRoot: string, source: { owner: string; repo: string; pinnedSha: string }) {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        ...source,
        components: [
          {
            id: "skill:tdd-workflow",
            paths: [".agents/skills/tdd-workflow", "skills/tdd-workflow"],
            treeSha256: hashComponentTree(sourceRoot, [
              ".agents/skills/tdd-workflow",
              "skills/tdd-workflow",
            ]).treeSha256,
            verdict: "pass",
            analyzers: [{ name: "fixture-baseline", version: "1" }],
            findings: [],
          },
        ],
      },
    ],
  });
}
function seedEvidence(root: string, lock: unknown): void {
  const bundle = ".aih/org-evidence/ecc";
  const path = ".aih/baseline-reports/ecc.json";
  const artifact = `${JSON.stringify(lock, null, 2)}\n`;
  const artifactHash = sha256(artifact);
  const manifest = `${JSON.stringify({ schemaVersion: 1, files: [{ path, bytes: Buffer.byteLength(artifact), sha256: artifactHash }] }, null, 2)}\n`;
  const index = `${JSON.stringify({ schemaVersion: 1, artifacts: [{ kind: "baseline-evidence", path, sha256: artifactHash, schemaVersion: 1 }] }, null, 2)}\n`;
  const sums = `${artifactHash}  files/${path}\n${sha256(manifest)}  manifest.json\n${sha256(index)}  evidence.json\n`;
  tree(root, {
    [`${bundle}/files/${path}`]: artifact,
    [`${bundle}/manifest.json`]: manifest,
    [`${bundle}/evidence.json`]: index,
    [`${bundle}/SHA256SUMS`]: sums,
  });
}
function attestationRunner(calls: string[][]) {
  return fakeRunner((argv) => {
    calls.push([...argv]);
    if (argv[0] === "gh" && argv[1] === "attestation" && argv[2] === "verify")
      return { code: 0, stdout: "SYNTHETIC FIXTURE: attestation runner stub" };
    throw new Error(`unexpected external command: ${argv.join(" ")}`);
  });
}
function writePolicy(
  root: string,
  policy: unknown,
  source: { owner: string; repo: string; pinnedSha: string },
) {
  const object = policy as Record<string, unknown>;
  const governance = object.governance as Record<string, unknown>;
  const policyWithEvidence = {
    ...object,
    governance,
    trust: {
      baselineOverrides: [
        {
          catalog: "ecc",
          ...source,
          bundle: ".aih/org-evidence/ecc",
          signingRepository: "fictional-adopter/governance",
          reason: "synthetic fixture evidence",
          reviewer: "fixture administrator",
          approvedAt: "2026-09-12T00:00:00Z",
        },
      ],
    },
  };
  writeFileSync(orgPolicyPath(root, {}), `${JSON.stringify(policyWithEvidence, null, 2)}\n`);
  return parseOrgPolicy(policyWithEvidence);
}
describe("portable Workbench team delivery", () => {
  it("exports/reopens the required TDD selection and optional exclusion, then admits its synthetic organization bundle", async () => {
    const { policy, source: tuple } = authorPolicy();
    const { source } = sourceWithTdd();
    const consumer = mkdtempSync(join(tmpdir(), "aih-portable-adopter-"));
    roots.push(consumer);
    seedEvidence(consumer, lockFor(source, tuple));
    const parsed = writePolicy(consumer, policy, tuple);
    const calls: string[][] = [];
    const admitted = await resolveOrgBaselineEvidence({
      root: consumer,
      catalog: catalogFor(tuple),
      policy: parsed,
      run: attestationRunner(calls),
      posture: "enterprise",
    });
    expect(admitted.evidence?.tier).toBe("org");
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
    expect(parsed.schemaVersion).toBe(3);
  });

  it("validates the synthetic organization bundle before its only stubbed external attestation, then refuses tampering", async () => {
    const { policy, source: tuple } = authorPolicy();
    const { source } = sourceWithTdd();
    const consumer = mkdtempSync(join(tmpdir(), "aih-portable-adopter-reject-"));
    roots.push(consumer);
    seedEvidence(consumer, lockFor(source, tuple));
    const parsed = writePolicy(consumer, policy, tuple);
    const calls: string[][] = [];
    const run = attestationRunner(calls);
    const verified = await resolveOrgBaselineEvidence({
      root: consumer,
      catalog: catalogFor(tuple),
      policy: parsed,
      run,
      posture: "enterprise",
    });
    expect(verified.evidence?.tier).toBe("org");
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "attestation", "verify"]);
    writeFileSync(
      join(
        consumer,
        ".aih",
        "org-evidence",
        "ecc",
        "files",
        ".aih",
        "baseline-reports",
        "ecc.json",
      ),
      "tampered\n",
    );
    const refused = await resolveOrgBaselineEvidence({
      root: consumer,
      catalog: catalogFor(tuple),
      policy: parsed,
      run,
      posture: "enterprise",
    });
    expect(refused.evidence).toBeUndefined();
    expect(refused.checks[0]?.code).toBe("baseline.evidence-mismatch");
    expect(calls).toHaveLength(1);
  });
});
