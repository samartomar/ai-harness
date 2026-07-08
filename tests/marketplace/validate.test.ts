import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, missingToolRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
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
async function validate(options: Record<string, unknown> = {}, over: Partial<PlanContext> = {}) {
  const c = ctx(options, over);
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
      "marketplace signature",
    ]);
    // Provenance is opt-in locally: an unsigned artifact skips (never fails)
    // without --require-signature — see the signature-probe describe below.
    const signature = report.checks.find((c) => c.name === "marketplace signature");
    expect(signature?.verdict).toBe("skip");
    expect(
      report.checks
        .filter((c) => c.name !== "marketplace signature")
        .every((c) => c.verdict === "pass"),
    ).toBe(true);
    expect(report.exitCode()).toBe(0);
  });

  it("declares the command shape (read-only, always-verify, signature gate flags)", () => {
    expect(marketplaceValidateCommand.readOnly).toBe(true);
    expect(marketplaceValidateCommand.alwaysVerify).toBe(true);
    expect(marketplaceValidateCommand.options?.map((o) => o.flags)).toEqual([
      "--dir <dir>",
      "--require-signature",
      "--signer <signer>",
      "--repo <owner/repo>",
      "--key <path>",
      "--certificate-identity <identity>",
      "--certificate-oidc-issuer <issuer>",
      "--signer-workflow <workflow>",
    ]);
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

  it("fails an undeclared file even when its correct hash line rides in SHA256SUMS", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    // The smuggle the coverage sweep alone cannot see: drop a payload into the
    // artifact AND append its correct hash line to SHA256SUMS. Coverage stays
    // green — the manifest is the declaration authority that refuses the ride.
    const body = "smuggled payload\n";
    writeFileSync(artifact("smuggled.txt"), body, "utf8");
    const sums = readFileSync(artifact("SHA256SUMS"), "utf8");
    writeFileSync(artifact("SHA256SUMS"), `${sums}${sha(body)}  smuggled.txt\n`, "utf8");
    const report = await validate();
    const fails = report.checks.filter((c) => c.verdict === "fail");
    expect(fails).toHaveLength(1); // the undeclared finding, and nothing else
    expect(fails[0]?.code).toBe("marketplace.sums-coverage");
    expect(fails[0]?.fingerprint).toBe("marketplace-undeclared:smuggled.txt");
    expect(fails[0]?.detail).toContain(
      "smuggled.txt exists in the artifact but marketplace.json does not declare it",
    );
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

  it("fails closed when a declared artifact file is a symlink outside the artifact", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const outside = join(workspace, "outside-secret.txt");
    writeFileSync(outside, "outside bytes\n", "utf8");
    rmSync(artifact("skills/alpha/SKILL.md"));
    symlinkSync(outside, artifact("skills/alpha/SKILL.md"), "file");

    const report = await validate();

    const finding = report.checks.find((c) => c.code === "marketplace.path-traversal");
    expect(finding?.detail).toContain("skills/alpha/SKILL.md");
    expect(finding?.detail).toContain("symlink");
    expect(report.exitCode()).toBe(1);
  });

  it("fails closed when an undeclared artifact entry is a symlink", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const outside = join(workspace, "outside-secret.txt");
    writeFileSync(outside, "outside bytes\n", "utf8");
    symlinkSync(outside, artifact("stray-link.txt"), "file");

    const report = await validate();

    const finding = report.checks.find((c) => c.code === "marketplace.path-traversal");
    expect(finding?.detail).toContain("stray-link.txt");
    expect(finding?.detail).toContain("symlink");
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

describe("marketplace validate — the signature probe", () => {
  const signatureOf = (report: { checks: Check[] }): Check | undefined =>
    report.checks.find((c) => c.name === "marketplace signature");

  it("skips (never fails) without --require-signature when there is no signature and no --repo", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const report = await validate();
    const check = signatureOf(report);
    expect(check?.verdict).toBe("skip");
    expect(check?.code).toBe("marketplace.signature");
    expect(check?.detail).toContain("no signature to verify");
    expect(report.exitCode()).toBe(0);
  });

  it("skips when the verifier tool is absent (spawnError)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    // The detached sig is coverage-exempt, so integrity stays green around it.
    // --key supplies the identity material cosign now requires to spawn at all.
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const report = await validate({ key: "keys/pub.key" }, { run: missingToolRunner });
    const check = signatureOf(report);
    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain("cosign not found");
    expect(report.exitCode()).toBe(0);
  });

  it("skips an explicit --signer cosign whose detached signature is missing on disk", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const report = await validate({ signer: "cosign" });
    const check = signatureOf(report);
    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain("SHA256SUMS.sig missing");
    expect(report.exitCode()).toBe(0);
  });

  it("--require-signature turns every unverifiable skip into a coded fail (the CI gate)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();

    // No signature at all.
    const noSig = await validate({ requireSignature: true });
    const noSigCheck = signatureOf(noSig);
    expect(noSigCheck?.verdict).toBe("fail");
    expect(noSigCheck?.code).toBe("marketplace.signature");
    expect(noSigCheck?.detail).toContain("--require-signature makes this a failure");
    expect(noSig.exitCode()).toBe(1);

    // gh requested without the repository identity it verifies against.
    const noRepo = await validate({ requireSignature: true, signer: "gh" });
    const noRepoCheck = signatureOf(noRepo);
    expect(noRepoCheck?.verdict).toBe("fail");
    expect(noRepoCheck?.detail).toContain("requires --repo");
    expect(noRepo.exitCode()).toBe(1);

    // Verifier tool absent — cosign (inferred from the sig file, spawned with
    // --key identity material) and gh alike.
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const noCosign = await validate(
      { requireSignature: true, key: "keys/pub.key" },
      { run: missingToolRunner },
    );
    expect(signatureOf(noCosign)?.verdict).toBe("fail");
    expect(signatureOf(noCosign)?.code).toBe("marketplace.signature");
    expect(signatureOf(noCosign)?.detail).toContain("cosign not found");
    expect(noCosign.exitCode()).toBe(1);
    const noGh = await validate(
      { requireSignature: true, signer: "gh", repo: "owner/repo" },
      { run: missingToolRunner },
    );
    expect(signatureOf(noGh)?.verdict).toBe("fail");
    expect(signatureOf(noGh)?.detail).toContain("gh not found");
    expect(noGh.exitCode()).toBe(1);
  });

  it("passes a cosign verify-blob that exits 0, with the exact --key argv", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined; // exit 0
    });
    const report = await validate({ requireSignature: true, key: "keys/pub.key" }, { run });
    const check = signatureOf(report);
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("cosign verified");
    expect(calls.filter((argv) => argv[0] === "cosign")).toEqual([
      [
        "cosign",
        "verify-blob",
        "--signature",
        artifact("SHA256SUMS.sig"),
        "--key",
        "keys/pub.key",
        artifact("SHA256SUMS"),
      ],
    ]);
    expect(report.exitCode()).toBe(0);
  });

  it("passes a keyless cosign verify with the exact identity-pair argv", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined; // exit 0
    });
    const report = await validate(
      {
        requireSignature: true,
        certificateIdentity: "me@example.com",
        certificateOidcIssuer: "https://accounts.example.com",
      },
      { run },
    );
    expect(signatureOf(report)?.verdict).toBe("pass");
    expect(calls.filter((argv) => argv[0] === "cosign")).toEqual([
      [
        "cosign",
        "verify-blob",
        "--signature",
        artifact("SHA256SUMS.sig"),
        "--certificate-identity",
        "me@example.com",
        "--certificate-oidc-issuer",
        "https://accounts.example.com",
        artifact("SHA256SUMS"),
      ],
    ]);
    expect(report.exitCode()).toBe(0);
  });

  it("passes a gh attestation verify that exits 0, with the exact argv", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === "gh" ? { code: 0, stdout: "verified\n" } : undefined;
    });
    const report = await validate(
      { requireSignature: true, signer: "gh", repo: "owner/repo" },
      { run },
    );
    const check = signatureOf(report);
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("owner/repo");
    expect(calls.filter((argv) => argv[0] === "gh")).toEqual([
      ["gh", "attestation", "verify", artifact("SHA256SUMS"), "--repo", "owner/repo"],
    ]);
    expect(report.exitCode()).toBe(0);
  });

  it("a verification that RAN and failed is tampering evidence — fails in BOTH modes", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const run = fakeRunner((argv) =>
      argv[0] === "cosign" ? { code: 1, stderr: "bad signature\n" } : undefined,
    );
    for (const options of [
      { key: "keys/pub.key" },
      { requireSignature: true, key: "keys/pub.key" },
    ]) {
      const report = await validate(options, { run });
      const check = signatureOf(report);
      expect(check?.verdict).toBe("fail");
      expect(check?.code).toBe("marketplace.signature");
      expect(check?.detail).toContain("bad signature");
      expect(report.exitCode()).toBe(1);
    }

    // Same ladder rung for gh: ran, exited non-zero → fail even without the gate.
    const ghRun = fakeRunner((argv) =>
      argv[0] === "gh" ? { code: 1, stderr: "attestation not found\n" } : undefined,
    );
    const ghReport = await validate({ signer: "gh", repo: "owner/repo" }, { run: ghRun });
    const ghCheck = signatureOf(ghReport);
    expect(ghCheck?.verdict).toBe("fail");
    expect(ghCheck?.detail).toContain("attestation not found");
    expect(ghReport.exitCode()).toBe(1);
  });

  it("fails an unknown --signer in BOTH modes (operator error, not an unverifiable state)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    for (const options of [{ signer: "gpg" }, { signer: "gpg", requireSignature: true }]) {
      const report = await validate(options);
      const check = signatureOf(report);
      expect(check?.verdict).toBe("fail");
      expect(check?.code).toBe("marketplace.signature");
      expect(check?.detail).toContain('--signer must be cosign or gh — got "gpg"');
      expect(report.exitCode()).toBe(1);
    }
  });

  it("an explicit --repo beats a stale leftover .sig — gh is chosen, cosign never spawns", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    // The stale-sig shadowing regression: an earlier cosign publish left a .sig
    // behind; the operator explicitly names a gh identity via --repo.
    writeFileSync(artifact("SHA256SUMS.sig"), "stale cosign sig\n", "utf8");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === "gh" ? { code: 0, stdout: "verified\n" } : undefined;
    });
    const report = await validate({ repo: "owner/repo" }, { run });
    const check = signatureOf(report);
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("owner/repo");
    expect(calls.filter((argv) => argv[0] === "cosign")).toEqual([]);
    expect(calls.filter((argv) => argv[0] === "gh")).toEqual([
      ["gh", "attestation", "verify", artifact("SHA256SUMS"), "--repo", "owner/repo"],
    ]);
  });

  it("cosign with no identity material NEVER spawns: skip locally, fail under the gate", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined;
    });

    // Local mode: a tolerated skip — and cosign's nonzero exit stays reserved
    // for tampering evidence, so the runner is never invoked at all.
    const local = await validate({}, { run });
    const localCheck = signatureOf(local);
    expect(localCheck?.verdict).toBe("skip");
    expect(localCheck?.detail).toContain(
      "proves an identity only with --key, or --certificate-identity + --certificate-oidc-issuer",
    );
    expect(calls).toEqual([]);
    expect(local.exitCode()).toBe(0);

    // Gate mode: the same unverifiable state becomes a coded fail — still no spawn.
    const gated = await validate({ requireSignature: true }, { run });
    const gatedCheck = signatureOf(gated);
    expect(gatedCheck?.verdict).toBe("fail");
    expect(gatedCheck?.code).toBe("marketplace.signature");
    expect(gatedCheck?.detail).toContain("--require-signature makes this a failure");
    expect(calls).toEqual([]);
    expect(gated.exitCode()).toBe(1);
  });

  it("exactly one half of the keyless pair fails naming the missing option (both modes)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    writeFileSync(artifact("SHA256SUMS.sig"), "sig-bytes\n", "utf8");
    for (const requireSignature of [false, true]) {
      const idOnly = await validate({ requireSignature, certificateIdentity: "me@example.com" });
      expect(signatureOf(idOnly)?.verdict).toBe("fail");
      expect(signatureOf(idOnly)?.detail).toContain("requires --certificate-oidc-issuer");
      expect(idOnly.exitCode()).toBe(1);
      const issuerOnly = await validate({
        requireSignature,
        certificateOidcIssuer: "https://accounts.example.com",
      });
      expect(signatureOf(issuerOnly)?.verdict).toBe("fail");
      expect(signatureOf(issuerOnly)?.detail).toContain("requires --certificate-identity");
      expect(issuerOnly.exitCode()).toBe(1);
    }
  });

  it("--signer-workflow narrows the gh attestation verify argv", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === "gh" ? { code: 0 } : undefined;
    });
    const report = await validate(
      { signer: "gh", repo: "owner/repo", signerWorkflow: ".github/workflows/release.yml" },
      { run },
    );
    expect(signatureOf(report)?.verdict).toBe("pass");
    expect(calls.filter((argv) => argv[0] === "gh")).toEqual([
      [
        "gh",
        "attestation",
        "verify",
        artifact("SHA256SUMS"),
        "--repo",
        "owner/repo",
        "--signer-workflow",
        ".github/workflows/release.yml",
      ],
    ]);
  });

  it("refuses a dash-leading --repo before spawning anything (argv-flag smuggling)", async () => {
    seedApproved(["alpha"]);
    await buildArtifact();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return undefined;
    });
    const report = await validate({ repo: "--evil" }, { run });
    const check = signatureOf(report);
    expect(check?.verdict).toBe("fail");
    expect(check?.detail).toContain("refusing to pass a value that parses as a flag");
    expect(calls).toEqual([]); // neither verifier was ever spawned
    expect(report.exitCode()).toBe(1);
  });
});
