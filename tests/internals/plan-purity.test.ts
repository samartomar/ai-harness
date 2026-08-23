import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_COMMAND_SPECS } from "../../src/commands/index.js";
import { command as healCommand } from "../../src/heal/index.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyResolvePlan } from "../../src/org-policy/policy-resolve-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

// #35 — plan() purity guardrail.
//
// The dry-run trust story is that computing a plan performs NO arbitrary or
// attacker-controlled execution. A few commands legitimately run READ-ONLY tools during
// plan() to DECIDE what to emit — heal's node/npm/npx + TLS checks pick the repair ladder,
// certs reads the OS trust store, report shells git for stats. Those results shape the plan
// and so cannot be deferred into a `probe` (the plan can't be built without them); they are
// documented, allowlisted exceptions below.
//
// This test PINS that exception set: only these read-only binaries, on fixed targets, may be
// exec'd during plan() — never anything else. If a future change shells out an arbitrary or
// interpolated command at plan time (the #1 `AIH_GRAPH_CMD` class of bug), it fails HERE, in
// CI, instead of in production.
const ALLOWED_PLAN_READS = new Set<string>([
  "git", // report / workspace — read-only repo stats
  "node", // heal — `node --version` runtime presence
  "npm", // heal — `npm --version` runtime health
  "npx", // heal / mcp — pre-flight
  "curl", // heal / certs — TLS reachability to fixed hosts
  "uv", // mcp — pinned code-review-graph launcher
  "uvx", // mcp — pinned code-review-graph launcher
  "openssl", // certs — inspect the corporate CA (no key material)
  "which", // ecc / superpowers / mcp / report — presence detection (fixed CLI/tool names)
  "nproc", // hardware — CPU count
  "nvidia-smi", // hardware — GPU query (--query-gpu, read-only)
]);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-plan-purity-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxWithRecorder(recorded: string[][]): PlanContext {
  const run = fakeRunner((argv) => {
    recorded.push([...argv]);
    return undefined; // default RunResult (code 0, empty stdout) — read succeeds, empty
  });
  return {
    root: tmp,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: tmp },
    options: {},
  };
}

describe("plan() purity — no arbitrary exec during dry-run (#35)", () => {
  it("every command's plan(ctx) only execs read-only, allowlisted binaries", async () => {
    const violations: string[] = [];
    for (const spec of ALL_COMMAND_SPECS) {
      const recorded: string[][] = [];
      const ctx = ctxWithRecorder(recorded);
      try {
        await spec.plan(ctx);
      } catch {
        // A command may need fixtures to finish planning; any reads it made before
        // throwing are already recorded and still checked.
      }
      for (const argv of recorded) {
        const bin = argv[0] ?? "";
        if (!ALLOWED_PLAN_READS.has(bin)) violations.push(`${spec.name}: ${JSON.stringify(argv)}`);
      }
    }
    expect(
      violations,
      `un-allowlisted exec during plan() — either it's an arbitrary-exec regression, or a new read-only tool to document + allowlist:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("heal plan construction does not contact repo-derived MCP endpoint targets", async () => {
    writeFileSync(
      join(tmp, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          hostile: { command: "node", url: "https://attacker.example:8443/mcp" },
        },
      }),
    );
    const recorded: string[][] = [];
    const ctx = ctxWithRecorder(recorded);
    ctx.options = { scope: "mcp", probeMcpEndpoints: true };

    await healCommand.plan(ctx);

    expect(recorded.map((argv) => argv.join(" ")).join("\n")).not.toContain("attacker.example");
  });

  it("policy resolve with valid options defers evidence custody and authority attestation until an action runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00+00:00"));
    const bin = mkdtempSync(join(tmpdir(), "aih-plan-purity-gh-"));
    try {
      const gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
      writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
      mkdirSync(join(tmp, ".aih"), { recursive: true });
      const authorityPath = join(tmp, ".aih", "policy-authority-receipt.json");
      const evidencePath = join(tmp, "evidence.json");
      writeFileSync(
        authorityPath,
        JSON.stringify({
          format: "aih-policy-authority-receipt",
          version: 3,
          issuerRepository: "acme/governance",
          issuedAt: "2026-08-23T00:00:00+00:00",
          expiresAt: "2026-08-24T00:00:00+00:00",
          trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
          targets: ["claude"],
          decisions: [],
          decisionRevocations: [],
        }),
      );
      writeFileSync(evidencePath, "{}");
      const before = new Map([
        [authorityPath, Buffer.from(readFileSync(authorityPath))],
        [evidencePath, Buffer.from(readFileSync(evidencePath))],
      ]);
      const recorded: string[][] = [];
      const privateVerifierCopies: string[] = [];
      const run = fakeRunner((argv) => {
        recorded.push([...argv]);
        const copiedReceipt = argv[3];
        if (copiedReceipt !== undefined && existsSync(copiedReceipt)) {
          privateVerifierCopies.push(copiedReceipt);
        }
        return { code: 0 };
      });
      const ctx: PlanContext = {
        root: tmp,
        contextDir: "ai-coding",
        apply: false,
        verify: true,
        json: true,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: bin },
        options: {
          decision: "decision-platform-tool",
          decisionDigest: `sha256:${"0".repeat(64)}`,
          target: "claude",
          effect: "configure",
          evidence: "evidence.json",
        },
      };

      const planned = policyResolvePlan(ctx);
      await Promise.resolve();

      expect(recorded).toEqual([]);
      expect(privateVerifierCopies).toEqual([]);
      for (const [path, contents] of before) expect(readFileSync(path)).toEqual(contents);
      expect(planned.actions.map((action) => action.kind)).toEqual(["digest", "probe"]);

      const [digest, verification] = planned.actions;
      if (digest?.kind !== "digest" || digest.run === undefined || verification?.kind !== "probe") {
        throw new Error("policy resolve must provide a dynamic digest and verification probe");
      }
      await digest.run(ctx);
      await verification.run(ctx);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.[0]).toMatch(/[\\/]gh(?:\.exe)?$/i);
      expect(recorded[0]?.slice(1, 3)).toEqual(["attestation", "verify"]);
      expect(privateVerifierCopies).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
