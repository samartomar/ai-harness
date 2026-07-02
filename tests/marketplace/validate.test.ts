import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { marketplaceBuildCommand } from "../../src/marketplace/build.js";
import { marketplaceValidateCommand } from "../../src/marketplace/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";
const OUT = ".aih/marketplace";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-marketplace-validate-"));
  home = mkdtempSync(join(tmpdir(), "aih-marketplace-validate-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown> = {}, over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: false,
    verify: true, // the runner forces verify for readOnly/alwaysVerify commands
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options,
    ...over,
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function evidenceBody(name: string): string {
  return `{"schemaVersion":1,"verdict":"GREEN","skill":"${name}"}\n`;
}

function validCard(name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    source: `owner/repo@${PIN}`,
    commit: PIN,
    license: "MIT License",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [`.aih/skill-reports/owner-repo-${name}.json`],
  };
}

/** Approve + install one promoted skill (files + card + evidence + lock entry). */
function seedApproved(names: string[]): void {
  for (const name of names) {
    write(join(CONTEXT_DIR, "skills", "owner-repo", name, "SKILL.md"), `# ${name}\n`);
    write(`${CONTEXT_DIR}/skill-cards/${name}.json`, `${JSON.stringify(validCard(name))}\n`);
    write(`.aih/skill-reports/owner-repo-${name}.json`, evidenceBody(name));
  }
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: names.map((name) => ({
        name,
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${name}.json`,
        evidenceSha256: sha(evidenceBody(name)),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** Materialize a real artifact under `.aih/marketplace` via the build command. */
async function buildArtifact(): Promise<void> {
  const c = ctx({}, { apply: true, verify: false });
  await executePlan(await Promise.resolve(marketplaceBuildCommand.plan(c)), c);
}

/** Execute the validate plan and return the verification report. */
async function validate(options: Record<string, unknown> = {}) {
  const c = ctx(options);
  const result = await executePlan(await Promise.resolve(marketplaceValidateCommand.plan(c)), c);
  if (result.report === undefined) throw new Error("expected a verification report");
  return result.report;
}

const artifact = (rel: string): string => join(workspace, OUT, rel);

describe("marketplace validate — the green path", () => {
  it("passes a freshly built artifact and exits 0", async () => {
    seedApproved(["alpha", "beta"]);
    await buildArtifact();
    const report = await validate();
    expect(report.checks.map((c) => c.name).sort()).toEqual([
      "marketplace checksums verified",
      "marketplace coverage complete",
      "marketplace manifest valid",
    ]);
    expect(report.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(report.exitCode()).toBe(0);
  });

  it("declares the command shape (read-only, always-verify, --dir only)", () => {
    expect(marketplaceValidateCommand.readOnly).toBe(true);
    expect(marketplaceValidateCommand.alwaysVerify).toBe(true);
    expect(marketplaceValidateCommand.options?.map((o) => o.flags)).toEqual(["--dir <dir>"]);
  });
});

describe("marketplace validate — coded findings", () => {
  it("fails with marketplace.checksum-mismatch when a shipped byte is tampered", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("skills/alpha/SKILL.md"), "# tampered\n", "utf8");
    const report = await validate();
    const codes = report.checks.map((c) => c.code);
    expect(codes).toContain("marketplace.checksum-mismatch");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.missing-file when a referenced file is deleted", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    rmSync(artifact("cards/alpha.json"));
    const report = await validate();
    expect(report.checks.map((c) => c.code)).toContain("marketplace.missing-file");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.sums-coverage when a stray file rides in the tree", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("stray.txt"), "smuggled\n", "utf8");
    const report = await validate();
    const finding = report.checks.find((c) => c.code === "marketplace.sums-coverage");
    expect(finding?.detail).toContain("stray.txt");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.path-traversal on a `..` manifest path, before any fs use", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const manifest = JSON.parse(readFileSync(artifact("marketplace.json"), "utf8")) as {
      skills: Array<{ files: Array<{ path: string }> }>;
    };
    const first = manifest.skills[0]?.files[0];
    if (first === undefined) throw new Error("expected a manifest file entry");
    first.path = "../../../outside";
    writeFileSync(artifact("marketplace.json"), JSON.stringify(manifest), "utf8");
    const report = await validate();
    const traversal = report.checks.filter((c) => c.code === "marketplace.path-traversal");
    expect(traversal.length).toBeGreaterThan(0);
    expect(traversal[0]?.detail).toContain("../../../outside");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.path-traversal on an escaping SHA256SUMS line", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const sums = readFileSync(artifact("SHA256SUMS"), "utf8");
    writeFileSync(artifact("SHA256SUMS"), `${sums}${"0".repeat(64)}  ../escape\n`, "utf8");
    const report = await validate();
    expect(report.checks.map((c) => c.code)).toContain("marketplace.path-traversal");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.manifest-parse on malformed JSON", async () => {
    write(`${OUT}/marketplace.json`, "{ not json");
    const report = await validate();
    const parse = report.checks.find((c) => c.code === "marketplace.manifest-parse");
    expect(parse?.detail).toContain("not valid JSON");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.manifest-parse when the manifest is missing", async () => {
    mkdirSync(join(workspace, OUT), { recursive: true });
    const report = await validate();
    const parse = report.checks.find((c) => c.code === "marketplace.manifest-parse");
    expect(parse?.detail).toContain("missing");
    expect(report.exitCode()).toBe(1);
  });

  it("fails when the artifact directory does not exist at all", async () => {
    const report = await validate({ dir: ".aih/absent" });
    expect(report.checks.map((c) => c.code)).toContain("marketplace.manifest-parse");
    expect(report.checks.map((c) => c.code)).toContain("marketplace.sums-coverage");
    expect(report.exitCode()).toBe(1);
  });

  it("fails with marketplace.unapproved-verdict on a RED skill (raw-JSON probe)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const manifest = JSON.parse(readFileSync(artifact("marketplace.json"), "utf8")) as {
      skills: Array<{ verdict: string }>;
    };
    const first = manifest.skills[0];
    if (first === undefined) throw new Error("expected a manifest skill entry");
    first.verdict = "RED";
    writeFileSync(artifact("marketplace.json"), JSON.stringify(manifest), "utf8");
    const report = await validate();
    const codes = report.checks.map((c) => c.code);
    // The precise signal fires even though the schema (rightly) also refuses RED.
    expect(codes).toContain("marketplace.unapproved-verdict");
    expect(codes).toContain("marketplace.manifest-parse");
    expect(report.exitCode()).toBe(1);
  });

  it("malformed SHA256SUMS lines fail as checksum findings", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const sums = readFileSync(artifact("SHA256SUMS"), "utf8");
    writeFileSync(artifact("SHA256SUMS"), `${sums}not-a-checksum-line\n`, "utf8");
    const report = await validate();
    const finding = report.checks.find((c) => c.code === "marketplace.checksum-mismatch");
    expect(finding?.detail).toContain("malformed line");
    expect(report.exitCode()).toBe(1);
  });
});
