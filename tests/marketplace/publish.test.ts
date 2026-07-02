import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { DigestAction, ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { marketplaceBuildCommand } from "../../src/marketplace/build.js";
import { marketplacePublishCommand } from "../../src/marketplace/publish.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";
const OUT = ".aih/marketplace";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-marketplace-publish-"));
  home = mkdtempSync(join(tmpdir(), "aih-marketplace-publish-home-"));
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
    verify: false,
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

/** Materialize a real, valid artifact under `.aih/marketplace` via the build command. */
async function buildArtifact(): Promise<void> {
  const c = ctx({}, { apply: true });
  await executePlan(await Promise.resolve(marketplaceBuildCommand.plan(c)), c);
}

/** Await the plan through an async frame so a sync refusal becomes a rejection. */
const planOf = async (c: PlanContext) => marketplacePublishCommand.plan(c);

const artifact = (rel: string): string => join(workspace, OUT, rel);

describe("marketplace publish — fail-closed refusals", () => {
  it("refuses without --signer: a publish without a signer is just a build", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const err = await planOf(ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AihError);
    expect((err as AihError).code).toBe("AIH_TRUST");
    expect((err as AihError).message).toMatch(/requires --signer cosign\|gh/);
    expect((err as AihError).message).toContain("just a build");
  });

  it("refuses an unknown --signer with the closed union named", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const err = await planOf(ctx({ signer: "gpg" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AihError);
    expect((err as AihError).code).toBe("AIH_TRUST");
    expect((err as AihError).message).toContain('got "gpg"');
  });

  it("refuses to sign an artifact with a failing finding, listing the checks", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("skills/alpha/SKILL.md"), "# tampered\n", "utf8");
    const err = await planOf(ctx({ signer: "cosign" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AihError);
    expect((err as AihError).code).toBe("AIH_TRUST");
    expect((err as AihError).message).toContain("publish only what validates — fix these first:");
    expect((err as AihError).message).toContain("marketplace checksum mismatch");
    expect((err as AihError).message).toContain("skills/alpha/SKILL.md");
  });

  it("refuses an artifact directory that was never built (findings, not a crash)", async () => {
    await expect(planOf(ctx({ signer: "cosign" }))).rejects.toThrow(/publish only what validates/);
  });
});

describe("marketplace publish — the signing exec", () => {
  it("plans exactly one cosign sign-blob exec over <dir>/SHA256SUMS, then the digest", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const plan = await planOf(ctx({ signer: "cosign" }));
    expect(plan.actions.map((a) => a.kind)).toEqual(["exec", "digest"]);
    const sign = plan.actions[0] as ExecAction;
    expect(sign.argv).toEqual([
      "cosign",
      "sign-blob",
      "--yes",
      "--output-signature",
      artifact("SHA256SUMS.sig"),
      artifact("SHA256SUMS"),
    ]);
    // Deliberate divergence from bundle's best-effort signAction: a publish
    // whose signing fails must fail loudly.
    expect(sign.allowFailure).toBe(false);
  });

  it("plans the gh attestation sign exec for --signer gh", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const plan = await planOf(ctx({ signer: "gh" }));
    const sign = plan.actions[0] as ExecAction;
    expect(sign.argv).toEqual(["gh", "attestation", "sign", artifact("SHA256SUMS")]);
    expect(sign.allowFailure).toBe(false);
  });

  it("resolves an explicit --dir to the same argv as the default", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const byDefault = (await planOf(ctx({ signer: "cosign" }))).actions[0] as ExecAction;
    const byAbsolute = (await planOf(ctx({ signer: "cosign", dir: join(workspace, OUT) })))
      .actions[0] as ExecAction;
    expect(byAbsolute.argv).toEqual(byDefault.argv);
  });

  it("plans no writes and runs nothing at plan time (the sign is --apply-only)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined;
    });
    const plan = await planOf(ctx({ signer: "cosign" }, { run }));
    expect(calls).toEqual([]);
    expect(plan.actions.some((a) => a.kind === "write")).toBe(false);
  });
});

describe("marketplace publish — the digest", () => {
  it("digests dir, signer, what consumers verify, and the require-signature hint", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const plan = await planOf(ctx({ signer: "cosign" }));
    const report = plan.actions.find((a): a is DigestAction => a.kind === "digest");
    expect(report?.describe).toBe("marketplace publish");
    expect(report?.text).toContain("SHA256SUMS signed with cosign");
    expect(report?.text).toContain("SHA256SUMS.sig");
    expect(report?.text).toContain(
      "`aih marketplace validate --dir .aih/marketplace --require-signature`",
    );
    expect(report?.data).toMatchObject({
      dir: OUT,
      signer: "cosign",
      verify: "aih marketplace validate --dir .aih/marketplace --require-signature",
    });
    expect((report?.data as { verifies: string }).verifies).toContain("SHA256SUMS.sig");
  });

  it("points gh consumers at the attestation and the --repo verify form", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const plan = await planOf(ctx({ signer: "gh" }));
    const report = plan.actions.find((a): a is DigestAction => a.kind === "digest");
    expect((report?.data as { verifies: string }).verifies).toContain("GitHub attestation");
    expect((report?.data as { verify: string }).verify).toBe(
      "aih marketplace validate --dir .aih/marketplace --require-signature --repo <owner/repo>",
    );
  });
});

describe("marketplace publish — command shape", () => {
  it("declares a write command (not readOnly) with --dir defaulted and --signer open", () => {
    expect(marketplacePublishCommand.readOnly).toBeUndefined();
    expect(marketplacePublishCommand.options?.map((o) => o.flags)).toEqual([
      "--dir <dir>",
      "--signer <signer>",
    ]);
    expect(marketplacePublishCommand.options?.find((o) => o.flags === "--dir <dir>")?.default).toBe(
      OUT,
    );
  });
});
