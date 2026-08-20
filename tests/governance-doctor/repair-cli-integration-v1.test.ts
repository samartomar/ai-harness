import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import * as policyValidate from "../../src/org-policy/validate.js";
import { buildProgram } from "../../src/program.js";
import {
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureIsolatedHome,
} from "./repair-execution-fixture-v1.js";

const confirmation = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

const repairExecutor = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const verifier = vi.hoisted(() => ({
  throwsAfterEffect: false,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

vi.mock("../../src/governance-doctor/repair-confirmation-v1.js", () => ({
  promptGovernanceDoctorRepairConfirmationV1: confirmation.prompt,
}));

vi.mock("../../src/governance-doctor/repair-command-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-command-v1.js")>();
  repairExecutor.execute.mockImplementation(actual.executeGovernanceDoctorRepairCommandV1);
  return {
    ...actual,
    executeGovernanceDoctorRepairCommandV1: repairExecutor.execute,
  };
});

vi.mock("../../src/governance-doctor/repair-verifier-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-verifier-v1.js")>();
  return {
    ...actual,
    verifyGovernanceDoctorRepairV1: (input: unknown) => {
      if (verifier.throwsAfterEffect) throw new Error("post-effect verification failed");
      return actual.verifyGovernanceDoctorRepairV1(input);
    },
  };
});

const CANONICAL_CONTEXT_DIR = "ai-coding";
const CONTEXT_DIR_MISSING = {
  code: "canon.context-dir-missing" as const,
  detail: "ai-coding not scaffolded - run: aih scaffold --apply",
  name: "context-dir",
  verdict: "skip" as const,
};
const HEALTHY = { name: "diagnostic", verdict: "pass" as const };

interface ConfirmationInput {
  readonly plan: { readonly planSha256: string };
}

let home: RepairFixtureHome;
let root: string;
let priorApply: string | undefined;
let priorExitCode: typeof process.exitCode;
let stdout: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function passingProbePlan(capability: string) {
  return {
    actions: [
      {
        describe: `${capability} diagnostic`,
        kind: "probe" as const,
        run: async () => HEALTHY,
      },
    ],
    capability,
  };
}

function claimFiles(): readonly string[] {
  const directory = repairFixtureClaimStoreDirectory(home.path);
  return existsSync(directory) ? readdirSync(directory) : [];
}

function rootEntries(): readonly string[] {
  return readdirSync(root).sort();
}

async function runRegistered(
  argv: readonly string[],
): Promise<{ readonly code: number; readonly out: string }> {
  process.exitCode = undefined;
  const program = buildProgram();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  await program.parseAsync(["node", "aih", "repair", ...argv]);
  return { code: process.exitCode ?? 0, out: stdout.join("") };
}

beforeEach(() => {
  home = repairFixtureIsolatedHome();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-repair-cli-")));
  priorApply = process.env.AIH_APPLY;
  priorExitCode = process.exitCode;
  stdout = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  verifier.throwsAfterEffect = false;
  repairExecutor.execute.mockClear();
  confirmation.prompt.mockClear();
  confirmation.prompt.mockImplementation(async (input: ConfirmationInput) => ({
    answer: input.plan.planSha256,
    kind: "answered",
  }));
  writeFileSync(
    join(root, ".aih-config.json"),
    JSON.stringify({ contextDir: CANONICAL_CONTEXT_DIR, schemaVersion: 1, targets: [] }),
  );
  vi.spyOn(doctorCommand, "plan").mockImplementation(() => ({
    actions: [
      {
        describe: "doctor diagnostic",
        kind: "probe" as const,
        run: async () =>
          existsSync(join(root, CANONICAL_CONTEXT_DIR)) ? HEALTHY : CONTEXT_DIR_MISSING,
      },
    ],
    capability: "doctor",
  }));
  vi.spyOn(policyValidate.policyEvaluateCommand, "plan").mockImplementation(() =>
    passingProbePlan("policy evaluate"),
  );
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.restoreAllMocks();
  if (priorApply === undefined) delete process.env.AIH_APPLY;
  else process.env.AIH_APPLY = priorApply;
  process.exitCode = priorExitCode;
  home.release();
  rmSync(root, { force: true, recursive: true });
});

describe("aih repair registered CLI integration V1", () => {
  it("keeps a bare registered invocation dry-run, with no confirmation, claim, or effect", async () => {
    const result = await runRegistered(["--root", root]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Governance Doctor repair preview");
    expect(result.out).toMatch(/Precondition SHA-256: [a-f0-9]{64}/);
    expect(result.out).toContain("Target occupancy: unoccupied");
    expect(result.out).toContain("Audit completeness: completed");
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(rootEntries()).toEqual([".aih-config.json"]);
  });

  it("does not let ambient AIH_APPLY authorize the registered repair route", async () => {
    process.env.AIH_APPLY = "true";

    const result = await runRegistered(["--root", root]);

    expect(result.code).toBe(0);
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(rootEntries()).toEqual([".aih-config.json"]);
  });

  it("refuses --apply --json before confirmation, claim, or effect", async () => {
    const result = await runRegistered(["--apply", "--json", "--root", root]);

    expect(result.code).toBe(1);
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).not.toHaveBeenCalled();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(rootEntries()).toEqual([".aih-config.json"]);
    expect(JSON.parse(result.out)).toMatchObject({
      digests: [
        {
          data: {
            outcome: "refused",
            reason: "interactive-confirmation-required",
          },
        },
      ],
    });
  });

  it("routes literal --apply through the custom executor and creates only the canonical target", async () => {
    const result = await runRegistered(["--apply", "--root", root]);

    expect(result.code).toBe(0);
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).toHaveBeenCalledOnce();
    expect(claimFiles()).toHaveLength(1);
    expect(rootEntries()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(readdirSync(join(root, CANONICAL_CONTEXT_DIR))).toEqual([]);
    expect(result.out).toContain("repairState: complete");
    expect(result.out).toContain("create canonical managed directory");
  });

  it("refuses the registered apply route when local terminal confirmation is non-interactive", async () => {
    confirmation.prompt.mockResolvedValueOnce({ kind: "non-interactive" });

    const result = await runRegistered(["--apply", "--root", root]);

    expect(result.code).toBe(1);
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).toHaveBeenCalledOnce();
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANONICAL_CONTEXT_DIR))).toBe(false);
    expect(rootEntries()).toEqual([".aih-config.json"]);
    expect(result.out).toContain("confirmation-refused");
  });

  it("keeps the applied effect and mutation summaries honest when post-effect verification fails", async () => {
    verifier.throwsAfterEffect = true;

    const result = await runRegistered(["--apply", "--root", root]);

    expect(result.code).toBe(1);
    expect(repairExecutor.execute).toHaveBeenCalledOnce();
    expect(confirmation.prompt).toHaveBeenCalledOnce();
    expect(claimFiles()).toHaveLength(1);
    expect(rootEntries()).toEqual([".aih-config.json", CANONICAL_CONTEXT_DIR]);
    expect(result.out).toContain("effectVerification: unverified");
    expect(result.out).toContain("repairState: failed");
    expect(result.out).toContain("spend durable repair claim");
    expect(result.out).toContain("create canonical managed directory");
  });
});
