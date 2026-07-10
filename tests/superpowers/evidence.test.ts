import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { Action, DigestAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";
import {
  superpowersEvidenceComponentIds,
  verifiedSuperpowersInstallPlan,
} from "../../src/superpowers/verified.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-superpowers-evidence-"));
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: "obra/Superpowers",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

const execs = (actions: Action[]) => actions.filter((action) => action.kind === "exec");

describe("verified Superpowers install planning", () => {
  it("selects the plugin runtime and every installable skill component", () => {
    const ids = superpowersEvidenceComponentIds();
    expect(ids[0]).toBe("runtime:superpowers-plugin");
    expect(ids).toHaveLength(15);
    expect(ids).toContain("skill:test-driven-development");
  });

  it("emits receipts and manual guidance without mutable remote execs", () => {
    const ids = superpowersEvidenceComponentIds();
    const authorizations = ids.map(authorization);
    const built = verifiedSuperpowersInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      ["antigravity", "copilot", "kiro"],
      authorizations,
    );

    expect(execs(built.actions)).toHaveLength(0);
    expect(
      built.actions.some(
        (action) =>
          action.kind === "write" && action.path === ".kiro/steering/superpowers-methodology.md",
      ),
    ).toBe(true);
    const digest = built.actions.find(
      (action): action is DigestAction => action.kind === "digest" && action.data !== undefined,
    );
    expect(digest?.data).toEqual({ authorizations });
    expect(built.actions.map((action) => JSON.stringify(action)).join("\n")).toContain(
      "not evidence-covered",
    );
  });
});

describe("registered Superpowers command", () => {
  it("previews exact-pinned acquisition before any target guidance", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync([
        "node",
        "aih",
        "superpowers",
        "--cli",
        "antigravity,copilot",
        "--json",
        "--no-log",
        "--root",
        root,
      ]);
      const raw = stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      const result = JSON.parse(raw) as {
        capability: string;
        execs: Array<{ argv: string[]; ran: boolean }>;
      };
      expect(result.capability).toBe("superpowers: acquire exact baseline source");
      expect(result.execs).toEqual([expect.objectContaining({ ran: false })]);
      expect(JSON.stringify(result)).toContain(baselineCatalogById("superpowers").pinnedSha);
      expect(JSON.stringify(result)).not.toContain("agy");
      expect(JSON.stringify(result)).not.toContain('"copilot","plugin"');
    } finally {
      stdout.mockRestore();
    }
  }, 20_000);
});
