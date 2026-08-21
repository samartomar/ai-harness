import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { EffectiveOrgPolicy } from "../../src/org-policy/effective.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  governanceReviewDigest,
  governanceReviewView,
} from "../../src/report/governance-review.js";
import { readUsageStrict } from "../../src/usage/events.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-governance-review-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function writeUsage(...rows: unknown[]): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(
    join(root, ".aih", "usage.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function candidate(id: string, requested = true): EffectiveOrgPolicy["candidates"][number] {
  return {
    id,
    origin: "reviewed" as const,
    kind: "mcp" as const,
    requested,
    effective: false,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    source: { type: "mcp" as const, server: id, subject: `mcp-server-sha256:${"b".repeat(64)}` },
    evidence: "missing" as const,
    dangerCodes: [],
    blockingCodes: ["evidence-missing"],
    decisionBlockers: [],
    resolutionReasons: ["projector-unavailable-for-candidate"],
    lifecycle: "supported" as const,
    projection: {
      projector: "mcp-managed-settings",
      requestedTargets: ["claude"],
      supportedTargets: ["claude"],
      availableTargets: ["claude"],
      coverage: "complete" as const,
      ownership: "managed-settings-receipt" as const,
      receipt: "pending-projection" as const,
    },
  };
}

function effective(ids: string[]): EffectiveOrgPolicy {
  return {
    policyVersion: "2026.08.0",
    candidates: ids.map((id) => candidate(id)),
    activeMcpServerIds: [],
    frameworkSelections: [],
    externalCuration: [],
    externalSelections: [],
    decisionBlockers: [],
    blocking: true,
    authority: { verified: false },
  };
}

function usageMeteringCandidate(
  receipt: "pending-projection" | "unavailable" = "pending-projection",
): EffectiveOrgPolicy["candidates"][number] {
  return {
    id: "usage-metering",
    origin: "reviewed",
    kind: "hook",
    requested: true,
    effective: true,
    sourceDigest: `sha256:${"c".repeat(64)}`,
    source: { type: "hook", handler: "usage-metering", scriptDigest: `sha256:${"d".repeat(64)}` },
    evidence: "verified",
    dangerCodes: [],
    blockingCodes: [],
    decisionBlockers: [],
    resolutionReasons: [],
    lifecycle: "supported",
    projection: {
      projector: "usage-hook",
      requestedTargets: ["claude"],
      supportedTargets: ["claude"],
      availableTargets: ["claude"],
      coverage: "complete",
      ownership: "usage-hook-receipt",
      receipt,
    },
  };
}

const RECEIPTS = {
  hook: { state: "absent", detail: "redacted" },
  mcp: { state: "missing", detail: "redacted" },
  kiro: { state: "not-requested", detail: "redacted" },
  registrar: { state: "invalid", detail: "redacted" },
} as const;

describe("governanceReviewView", () => {
  it("keeps all governed subjects in deterministic ordinal order and never includes raw unmatched names", () => {
    const ids = [
      "subject-12",
      "subject-2",
      "subject-1",
      "subject-13",
      ...Array.from({ length: 9 }, (_, index) => `subject-${index + 3}`),
    ];
    writeUsage(
      { tool: "codex", kind: "mcp", server: "subject-1", name: "subject-2/check" },
      { tool: "codex", kind: "skill", name: "subject-2/check", source: "ecc" },
      { tool: "codex", kind: "mcp", name: "ghp_private-token-never-render" },
      { tool: "codex", kind: "unknown-kind" },
    );
    const before = effective(ids);
    const view = governanceReviewView({
      effective: before,
      receipts: RECEIPTS,
      usage: readUsageStrict(ctx()),
    });
    const data = view.data as {
      subjects: Array<{
        id: string;
        ordinal: number;
        attribution: { exact: number; heuristic: number };
      }>;
      usage: {
        state: string;
        unmatched: number;
        malformedExcluded: number;
        unknownKindExcluded: number;
      };
    };

    expect(data.subjects).toHaveLength(13);
    expect(data.subjects.map((subject) => subject.id)).toEqual([...ids].sort());
    expect(data.subjects.map((subject) => subject.ordinal)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
    expect(data.subjects.find((subject) => subject.id === "subject-1")?.attribution).toEqual({
      exact: 1,
      heuristic: 0,
    });
    expect(data.subjects.find((subject) => subject.id === "subject-2")?.attribution).toEqual({
      exact: 0,
      heuristic: 1,
    });
    expect(data.usage).toMatchObject({
      state: "no-capture",
      unmatched: 1,
      malformedExcluded: 0,
      unknownKindExcluded: 1,
    });
    expect(view.text).not.toContain("secret-like-tool-name");
    expect(view.text).not.toContain("ghp_private-token-never-render");
    expect(view.text).not.toContain("redacted");
    expect(before).toEqual(effective(ids));
  });

  it("derives capture ownership only from an effective usage-metering subject and an active strict receipt", () => {
    const noReceipt = effective(["context7"]);
    noReceipt.candidates.push(usageMeteringCandidate());
    mkdirSync(join(root, ".aih"), { recursive: true });
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".aih", "usage-record.mjs"), "recorder");
    writeFileSync(join(root, ".git", "hooks", "post-commit"), "usage-record.mjs");
    const noCapture = governanceReviewView({
      effective: noReceipt,
      receipts: RECEIPTS,
      usage: { events: [], malformed: 0, unknownKind: 0 },
    });
    const activeReceipt = governanceReviewView({
      effective: noReceipt,
      receipts: { ...RECEIPTS, hook: { state: "active" } },
      usage: { events: [], malformed: 0, unknownKind: 0 },
    });

    const noCaptureSubjects = (noCapture.data as { subjects: Array<{ id: string }> }).subjects;
    const activeReceiptSubjects = (activeReceipt.data as { subjects: Array<{ id: string }> })
      .subjects;
    expect(noCapture.data).toMatchObject({ usage: { state: "no-capture" } });
    expect(noCaptureSubjects.find((subject) => subject.id === "context7")).toMatchObject({
      usage: { signal: "unknown-no-capture", count: 0 },
    });
    expect(activeReceipt.data).toMatchObject({ usage: { state: "installed-zero-observed" } });
    expect(activeReceiptSubjects.find((subject) => subject.id === "context7")).toMatchObject({
      materialization: { state: "missing" },
      usage: { signal: "not-observed-with-installed-capture", count: 0 },
    });
    expect(activeReceipt.text).toContain("installed-zero-observed");
    expect(activeReceipt.text).toContain("receipt=missing");
  });

  it("keeps each selected MCP target's strict receipt verdict", () => {
    const multiTarget = effective(["context7"]);
    const subject = multiTarget.candidates[0];
    if (subject === undefined) throw new Error("expected governed subject");
    subject.projection.requestedTargets = ["claude", "kiro"];
    subject.projection.supportedTargets = ["claude", "kiro"];
    subject.projection.availableTargets = ["claude", "kiro"];

    const digest = governanceReviewView({
      effective: multiTarget,
      receipts: RECEIPTS,
      usage: { events: [], malformed: 0, unknownKind: 0 },
    });

    expect(digest.data).toMatchObject({
      subjects: [
        {
          materialization: {
            state: "multiple",
            targets: { claude: "missing", kiro: "not-requested" },
          },
        },
      ],
    });
    expect(digest.text).toContain("receipt=multiple (claude:missing,kiro:not-requested)");
  });

  it("keeps observed and not-observed subjects distinct without inferring action", () => {
    const installed = effective(["context7", "github"]);
    installed.candidates.push(usageMeteringCandidate());
    const digest = governanceReviewView({
      effective: installed,
      receipts: { ...RECEIPTS, hook: { state: "active" } },
      usage: {
        events: [{ tool: "codex", kind: "mcp", server: "context7" }],
        malformed: 0,
        unknownKind: 0,
      },
    });

    const subjects = (digest.data as { subjects: Array<{ id: string }> }).subjects;
    expect(subjects.find((subject) => subject.id === "context7")).toMatchObject({
      usage: { count: 1, signal: "observed" },
    });
    expect(subjects.find((subject) => subject.id === "github")).toMatchObject({
      usage: { count: 0, signal: "not-observed-with-installed-capture" },
    });
    expect(digest.text).not.toMatch(/unused|trim|retire|revoke|uninstall|value/i);
  });

  it("keeps heuristic-only and mixed attribution globally partial", () => {
    const installed = effective(["context7", "github"]);
    installed.candidates.push(usageMeteringCandidate());
    const input = {
      effective: installed,
      receipts: { ...RECEIPTS, hook: { state: "active" } },
      usage: { malformed: 0, unknownKind: 0 },
    };
    const heuristicOnly = governanceReviewView({
      ...input,
      usage: {
        ...input.usage,
        events: [{ tool: "codex", kind: "skill", name: "context7/check", source: "ecc" }],
      },
    });
    const mixed = governanceReviewView({
      ...input,
      usage: {
        ...input.usage,
        events: [
          { tool: "codex", kind: "mcp", server: "context7" },
          { tool: "codex", kind: "skill", name: "github/check", source: "ecc" },
        ],
      },
    });

    expect(heuristicOnly.data).toMatchObject({ usage: { state: "partial-attribution" } });
    expect(mixed.data).toMatchObject({ usage: { state: "partial-attribution" } });
  });
});

describe("governanceReviewDigest", () => {
  it("fails closed with an explicit, redacted absent-policy view", async () => {
    writeUsage({ tool: "codex", kind: "mcp", name: "unattributable" });
    const digest = await governanceReviewDigest(ctx());

    expect(digest.describe).toBe("Governance review — policy absent");
    expect(digest.data).toEqual({
      format: "aih-governance-review-v1",
      policy: { state: "absent" },
      subjects: [],
      usage: {
        state: "no-capture",
        validEvents: 1,
        malformedExcluded: 0,
        unknownKindExcluded: 0,
        unmatched: 1,
      },
    });
    expect(digest.text).not.toContain(root);
  });

  it("makes valid events aggregate-only when a policy is present but not governing", async () => {
    writeUsage({ tool: "codex", kind: "mcp", name: "unattributable" });
    writeFileSync(
      join(root, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );

    const digest = await governanceReviewDigest(ctx());

    expect(digest.describe).toBe("Governance review — policy not-governing");
    expect(digest.data).toMatchObject({
      policy: { state: "not-governing" },
      subjects: [],
      usage: { validEvents: 1, unmatched: 1 },
    });
    expect(digest.text).not.toContain("unattributable");
  });

  it("fails closed with an explicit, redacted invalid-policy view", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), "{ invalid json");

    const digest = await governanceReviewDigest(ctx());

    expect(digest.describe).toBe("Governance review — policy invalid");
    expect(digest.data).toMatchObject({ policy: { state: "invalid" }, subjects: [] });
    expect(digest.text).not.toContain("invalid json");
    expect(digest.text).not.toContain(root);
  });
});
