import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  verifiedPolicyAuthorityReceiptAssertionV1,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
let bin: string;
let gh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
  root = mkdtempSync(join(tmpdir(), "aih-authority-live-custody-"));
  bin = mkdtempSync(join(tmpdir(), "aih-authority-live-custody-gh-"));
  const executable = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "trusted gh fixture\n", { mode: 0o755 });
  gh = realpathSync.native(executable);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function receipt(target: "claude" | "codex"): string {
  return JSON.stringify({
    format: "aih-policy-authority-receipt",
    version: 1,
    issuerRepository: "acme/governance",
    issuedAt: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
    targets: [target],
  });
}

function receiptPath(): string {
  const parent = join(root, ".aih");
  mkdirSync(parent, { recursive: true });
  return join(parent, "policy-authority-receipt.json");
}

function context(handler: (argv: string[]) => { code: number }): PlanContext {
  const run = fakeRunner((argv) => handler(argv));
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: true,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
    options: {},
  };
}

describe("policy authority live receipt custody", () => {
  it("does not mint a transaction assertion from an unverified structural lookalike", () => {
    expect(
      verifiedPolicyAuthorityReceiptAssertionV1({
        receipt: JSON.parse(receipt("claude")),
        receiptDigest: `sha256:${"0".repeat(64)}`,
        repository: "acme/governance",
      }),
    ).toBeUndefined();
  });

  it("mints no authority when the live receipt changes while gh verifies its private copy", async () => {
    const path = receiptPath();
    const initial = receipt("claude");
    const substituted = receipt("codex");
    writeFileSync(path, initial);

    const result = await verifyPolicyAuthorityReceipt(
      context((argv) => {
        expect(argv[0]).toBe(gh);
        expect(readFileSync(argv[3] as string, "utf8")).toBe(initial);
        writeFileSync(path, substituted);
        return { code: 0 };
      }),
    );

    expect(result).toEqual({
      problem: "GitHub authority receipt attestation could not be verified",
    });
  });

  it("mints no authority when the live receipt gains a hard link during verification", async () => {
    const path = receiptPath();
    const initial = receipt("claude");
    writeFileSync(path, initial);

    const result = await verifyPolicyAuthorityReceipt(
      context((argv) => {
        expect(argv[0]).toBe(gh);
        expect(readFileSync(argv[3] as string, "utf8")).toBe(initial);
        linkSync(path, join(root, "receipt-link.json"));
        return { code: 0 };
      }),
    );

    expect(result).toEqual({
      problem: "GitHub authority receipt attestation could not be verified",
    });
  });
});
