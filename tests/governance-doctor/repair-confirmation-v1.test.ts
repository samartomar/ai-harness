import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOVERNANCE_DOCTOR_REPAIR_CONFIRMATION_TIMEOUT_MS_V1,
  promptGovernanceDoctorRepairConfirmationV1,
} from "../../src/governance-doctor/repair-confirmation-v1.js";
import {
  canonicalGovernanceDoctorRepairEffectSummaryV1Bytes,
  governanceDoctorRepairEffectSummaryV1,
} from "../../src/governance-doctor/repair-plan-v1.js";
import { repairFixturePlan } from "./repair-execution-fixture-v1.js";

const runtime = vi.hoisted(() => ({
  env: {} as NodeJS.ProcessEnv,
  stdin: { isTTY: true },
  stdout: { isTTY: true, write: vi.fn() },
}));

const readline = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const line = {
    close: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return line;
    }),
    question: vi.fn(),
  };
  return {
    createInterface: vi.fn(() => line),
    emit: (event: "SIGINT" | "close") => listeners.get(event)?.(),
    line,
    reset: () => {
      listeners.clear();
      line.close.mockReset();
      line.once.mockClear();
      line.question.mockReset();
    },
  };
});

vi.mock("node:process", () => ({ default: runtime }));
vi.mock("node:readline", () => ({ createInterface: readline.createInterface }));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-repair-confirmation-"));
  runtime.env = {};
  runtime.stdin.isTTY = true;
  runtime.stdout.isTTY = true;
  runtime.stdout.write.mockClear();
  readline.createInterface.mockClear();
  readline.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { force: true, recursive: true });
});

async function request(planNonce = "7f".repeat(32), targetPath = "ai-coding") {
  const plan = await repairFixturePlan({
    effects: [
      {
        arguments: { path: targetPath },
        effectId: "create-canonical-context-directory",
        templateId: "ensure-canon-directory",
      },
    ],
    planNonce,
    root,
    scopePaths: [targetPath],
  });
  return { plan, summary: governanceDoctorRepairEffectSummaryV1(plan) };
}

describe("Governance Doctor Repair TTY confirmation V1", () => {
  it("requires both real process streams to be TTYs and honors AIH_NO_PROMPT before opening readline", async () => {
    for (const configure of [
      () => {
        runtime.stdin.isTTY = false;
      },
      () => {
        runtime.stdout.isTTY = false;
      },
      () => {
        runtime.env = { AIH_NO_PROMPT: "1" };
      },
    ]) {
      configure();
      await expect(promptGovernanceDoctorRepairConfirmationV1(await request())).resolves.toEqual({
        kind: "non-interactive",
      });
      expect(readline.createInterface).not.toHaveBeenCalled();
    }
  });

  it("itself displays the canonical effect summary and both complete digests, preserving the raw answer", async () => {
    const repair = await request();
    const pending = promptGovernanceDoctorRepairConfirmationV1(repair);
    expect(readline.createInterface).toHaveBeenCalledWith({
      input: runtime.stdin,
      output: runtime.stdout,
      terminal: true,
    });
    const question = readline.line.question.mock.calls[0]?.[0];
    const answer = readline.line.question.mock.calls[0]?.[1] as
      | ((value: string) => void)
      | undefined;
    expect(question).toContain("ai-coding");
    expect(question).toContain(repair.plan.planSha256);
    expect(question).toContain(repair.summary.summarySha256);
    const displayed = runtime.stdout.write.mock.calls.map(([value]) => String(value)).join("");
    expect(displayed).toContain(
      canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(repair.summary).toString("utf8"),
    );
    expect(displayed).toContain("create-managed-directory");
    answer?.(`${repair.plan.planSha256} trailing-token`);

    await expect(pending).resolves.toEqual({
      answer: `${repair.plan.planSha256} trailing-token`,
      kind: "answered",
    });
    expect(readline.line.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a branded plan whose sole target is not the canonical managed directory", async () => {
    const repair = await request("7f".repeat(32), "custom-context");

    await expect(promptGovernanceDoctorRepairConfirmationV1(repair)).rejects.toThrow(
      /requires exactly one canonical effect/,
    );
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it("refuses a branded multi-effect plan and summary before opening readline", async () => {
    const plan = await repairFixturePlan({
      effects: [
        {
          arguments: { path: "ai-coding" },
          effectId: "create-canonical-context-directory",
          templateId: "ensure-canon-directory",
        },
        {
          arguments: { path: "other-managed-file" },
          effectId: "normalize-other-managed-file",
          templateId: "normalize-canon-endings",
        },
      ],
      root,
      scopePaths: ["ai-coding", "other-managed-file"],
    });

    await expect(
      promptGovernanceDoctorRepairConfirmationV1({
        plan,
        summary: governanceDoctorRepairEffectSummaryV1(plan),
      }),
    ).rejects.toThrow(/requires exactly one canonical effect/);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it("turns EOF, Ctrl-C, and a bounded timeout into closed refusals while closing readline exactly once", async () => {
    const repair = await request();
    const eof = promptGovernanceDoctorRepairConfirmationV1(repair);
    readline.emit("close");
    await expect(eof).resolves.toEqual({ kind: "eof" });
    expect(readline.line.close).toHaveBeenCalledTimes(1);

    readline.reset();
    const cancelled = promptGovernanceDoctorRepairConfirmationV1(repair);
    readline.emit("SIGINT");
    await expect(cancelled).resolves.toEqual({ kind: "cancelled" });
    expect(readline.line.close).toHaveBeenCalledTimes(1);

    readline.reset();
    vi.useFakeTimers();
    const timedOut = promptGovernanceDoctorRepairConfirmationV1(repair);
    await vi.advanceTimersByTimeAsync(GOVERNANCE_DOCTOR_REPAIR_CONFIRMATION_TIMEOUT_MS_V1);
    await expect(timedOut).resolves.toEqual({ kind: "timeout" });
    expect(readline.line.close).toHaveBeenCalledTimes(1);
  });

  it("accepts only a branded plan joined to its branded summary, never a caller-supplied token, file, or callback", async () => {
    const repair = await request();
    const otherRepair = await request("6e".repeat(32));
    await expect(
      promptGovernanceDoctorRepairConfirmationV1({
        plan: repair.plan,
        summary: { ...repair.summary },
      }),
    ).rejects.toThrow(/repair effect summary|validated brand/i);
    await expect(
      promptGovernanceDoctorRepairConfirmationV1({
        plan: repair.plan,
        summary: otherRepair.summary,
      }),
    ).rejects.toThrow(/repair effect summary|summary.*plan|plan.*summary/i);
    expect(readline.createInterface).not.toHaveBeenCalled();

    const source = readFileSync(
      resolve(__dirname, "../../src/governance-doctor/repair-confirmation-v1.ts"),
      "utf8",
    );
    expect(source).toContain("process.stdin.isTTY");
    expect(source).toContain("process.stdout.isTTY");
    expect(source).toContain("process.env.AIH_NO_PROMPT");
    expect(source).toContain("createInterface");
    expect(source).toContain("canonicalGovernanceDoctorRepairPlanV1Bytes");
    expect(source).toContain("canonicalGovernanceDoctorRepairEffectSummaryV1Bytes");
    expect(source).not.toMatch(/PlanContext|Prompter|ctx\.prompter|AIH_.*(?:TOKEN|CONFIRM)/);
    for (const token of [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "fetch(",
      "require(",
      "import(",
      "eval",
      "new Function",
      "globalThis",
    ])
      expect(source, token).not.toContain(token);
  });
});
