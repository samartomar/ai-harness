import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  acceptAihSupportedQualificationReceiptV2WithContext,
  inspectAihSupportedQualificationCustodyV2,
  parseAihSupportedQualificationReceiptV2Bytes,
} from "../../src/org-policy/supported-qualification-receipt-v2.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";
import { governanceDecisionSourceDigestV2, governanceDecisionSubjectDigestV2 } from "../../src/org-policy/governance-decision-v2.js";
import { verifyPolicyAuthorityReceipt } from "../../src/org-policy/authority.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function context(target: string, env: NodeJS.ProcessEnv = {}): PlanContext {
  const run = fakeRunner(() => ({ code: 1 }));
  return { root: target, contextDir: "ai-coding", posture: "enterprise", apply: false, verify: false, json: false, run: fakeRunner(() => ({ code: 0 })), host: makeHostAdapter({ platform: "linux", run, env }), env, options: { decision: "decision-supported-package", decisionDigest: `sha256:${"a".repeat(64)}`, target: "claude" } };
}
function writeCurrentAuthority(target: string): void {
  const source = { type: "github" as const, repository: "acme/review-tool", commit: "a".repeat(40), path: "tool.json" };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = { kind: "tool" as const, id: "platform-review-tool", source, sourceDigest, subjectDigest: governanceDecisionSubjectDigestV2({ kind: "tool", id: "platform-review-tool", sourceDigest }) };
  const decision = { format: "aih-governance-decision", version: 2, id: "decision-supported-package", qualificationBasis: { kind: "aih-supported", catalogSignerIdentity: "catalog-signer", catalogDigest: `sha256:${"1".repeat(64)}`, catalogHeadDigest: `sha256:${"2".repeat(64)}`, catalogMemberDigest: `sha256:${"3".repeat(64)}`, subjectKind: subject.kind, subjectDigest: subject.subjectDigest }, subject, targets: ["claude"], allowedEffects: ["install"], policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"c".repeat(64)}` }, control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` }, evidence: { id: "catalog-evidence", digest: `sha256:${"e".repeat(64)}`, attestor: "catalog-signer" }, issuer: "platform-security", actor: "security-admin", reason: "The exact catalog member is supported for this governed subject.", issuedAt: "2026-08-20T00:00:00+00:00", notBefore: "2026-08-20T00:00:00+00:00", expiresAt: "2026-08-30T00:00:00+00:00", disposition: "approved", acceptedFindings: [], acceptedGaps: [], conditions: [] };
  mkdirSync(join(target, ".aih"), { recursive: true });
  writeFileSync(join(target, ".aih", "policy-authority-receipt.json"), JSON.stringify({ format: "aih-policy-authority-receipt", version: 3, issuerRepository: "acme/governance", issuedAt: "2026-08-20T00:00:00+00:00", expiresAt: "2026-08-30T00:00:00+00:00", trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }], targets: ["claude"], decisions: [decision], decisionRevocations: [] }));
}

describe("AIH-supported qualification receipt V2", () => {
  it("has the synchronized 5,970 byte ceiling and refuses V1", () => {
    expect(MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2).toBe(5_970);
    expect(
      parseAihSupportedQualificationReceiptV2Bytes(
        Buffer.from('{"format":"aih-supported-qualification-receipt","version":1}', "utf8"),
      ),
    ).toBeUndefined();
  });

  it("uses only a fixed target receipt path and keeps failed acceptance plus inspect zero-write", async () => {
    root = mkdtempSync(join(tmpdir(), "aih-supported-v2-red-"));
    writeFileSync(join(root, "v1-receipt.json"), "{}", "utf8");
    await expect(
      acceptAihSupportedQualificationReceiptV2WithContext(context(root), true),
    ).resolves.toEqual({ state: "refused", reason: "authority-unverified" });
    await expect(
      inspectAihSupportedQualificationCustodyV2({ root }),
    ).resolves.toEqual({ state: "absent" });
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("refuses a V1 fixed receipt without ever invoking a local fallback or creating custody", async () => {
    root = mkdtempSync(join(tmpdir(), "aih-supported-v2-red-"));
    writeCurrentAuthority(root);
    const bin = mkdtempSync(join(tmpdir(), "aih-supported-gh-"));
    writeFileSync(join(bin, process.platform === "win32" ? "gh.exe" : "gh"), "fixture", { mode: 0o755 });
    writeFileSync(join(root, ".aih", "aih-supported-qualification-receipt.json"), '{"format":"aih-supported-qualification-receipt","version":1}', "utf8");
    const ctx = context(root, { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", AIH_SUPPORTED_QUALIFICATION_REPOSITORY: "aihq/supported", AIH_SUPPORTED_QUALIFICATION_WORKFLOW: "receipt.yml", PATH: bin });
    await expect(verifyPolicyAuthorityReceipt(ctx)).resolves.toMatchObject({ authority: expect.any(Object) });
    await expect(
      acceptAihSupportedQualificationReceiptV2WithContext(ctx, true),
    ).resolves.toEqual({ state: "refused", reason: "receipt-unverified" });
    expect(existsSync(join(root, ".aih", "governance", "aih-supported", "v2", "custody.json"))).toBe(false);
    rmSync(bin, { recursive: true, force: true });
  });

  it("registers a distinct supported-admin group with an apply-only accept and read-only inspect", () => {
    const policy = buildProgram().commands.find((command) => command.name() === "policy");
    const supported = policy?.commands.find((command) => command.name() === "supported-admin");
    expect(supported?.commands.map((command) => command.name())).toEqual(["accept", "inspect"]);
    expect(supported?.commands.find((command) => command.name() === "accept")?.options.some((option) => option.long === "--apply")).toBe(true);
    expect(supported?.commands.find((command) => command.name() === "inspect")?.options.some((option) => option.long === "--apply")).toBe(false);
    expect(supported?.commands.find((command) => command.name() === "accept")?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--decision", "--decision-digest", "--target"]),
    );
    expect(supported?.commands.find((command) => command.name() === "accept")?.options.map((option) => option.long)).not.toContain("--evidence");
  });
});
