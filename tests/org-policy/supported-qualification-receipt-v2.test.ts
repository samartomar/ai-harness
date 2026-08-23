import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function context(target: string): PlanContext {
  const run = fakeRunner(() => ({ code: 1 }));
  return { root: target, contextDir: "ai-coding", posture: "enterprise", apply: false, verify: false, json: false, run, host: makeHostAdapter({ platform: "linux", run, env: {} }), env: {}, options: {} };
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
    writeFileSync(join(root, ".aih-supported-qualification-receipt.json"), '{"format":"aih-supported-qualification-receipt","version":1}', "utf8");
    await expect(
      acceptAihSupportedQualificationReceiptV2WithContext(context(root), true),
    ).resolves.toEqual({ state: "refused", reason: "authority-unverified" });
    expect(existsSync(join(root, ".aih", "governance", "aih-supported", "v2", "custody.json"))).toBe(false);
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
