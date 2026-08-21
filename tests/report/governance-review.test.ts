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
      { tool: "codex", kind: "mcp", name: "subject-2/check" },
      { tool: "codex", kind: "mcp", name: "ghp_private-token-never-render" },
      { tool: "codex", kind: "unknown-kind" },
    );
    const before = effective(ids);
    const view = governanceReviewView({
      effective: before,
      receipts: RECEIPTS,
      captureInstalled: true,
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
      state: "partial-attribution",
      unmatched: 1,
      malformedExcluded: 0,
      unknownKindExcluded: 1,
    });
    expect(view.text).not.toContain("secret-like-tool-name");
    expect(view.text).not.toContain("ghp_private-token-never-render");
    expect(view.text).not.toContain("redacted");
    expect(before).toEqual(effective(ids));
  });

  it("distinguishes no capture from installed capture with zero observed events and keeps receipt failures explicit", () => {
    const noCapture = governanceReviewView({
      effective: effective(["context7"]),
      receipts: RECEIPTS,
      captureInstalled: false,
      usage: { events: [], malformed: 0, unknownKind: 0 },
    });
    const installedZero = governanceReviewView({
      effective: effective(["context7"]),
      receipts: RECEIPTS,
      captureInstalled: true,
      usage: { events: [], malformed: 0, unknownKind: 0 },
    });

    expect(noCapture.data).toMatchObject({ usage: { state: "no-capture" } });
    expect(installedZero.data).toMatchObject({
      usage: { state: "installed-zero-observed" },
      subjects: [
        {
          materialization: { state: "missing" },
          registrar: { state: "invalid" },
        },
      ],
    });
    expect(installedZero.text).toContain("installed-zero-observed");
    expect(installedZero.text).toContain("receipt=missing");
  });
});

describe("governanceReviewDigest", () => {
  it("fails closed with an explicit, redacted absent-policy view", async () => {
    const digest = await governanceReviewDigest(ctx());

    expect(digest.describe).toBe("Governance review — policy absent");
    expect(digest.data).toEqual({
      format: "aih-governance-review-v1",
      policy: { state: "absent" },
      subjects: [],
      usage: {
        state: "no-capture",
        validEvents: 0,
        malformedExcluded: 0,
        unknownKindExcluded: 0,
        unmatched: 0,
      },
    });
    expect(digest.text).not.toContain(root);
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
