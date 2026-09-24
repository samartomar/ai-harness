import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { headroomLayout, headroomMcpServer } from "../../src/tools/headroom.js";
import {
  headroomReceiptFor,
  readHeadroomReceipt,
  writeHeadroomReceipt,
} from "../../src/tools/headroom-receipt.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-headroom-receipt-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-headroom-receipt-state-")));
  roots.push(root, state);
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: process.env.PATH };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
}

function activated(ctx: PlanContext) {
  const layout = headroomLayout(ctx);
  mkdirSync(layout.stateRoot, { recursive: true });
  const receipt = headroomReceiptFor({
    layout,
    platform: "linux-x64",
    acceptedAt: "2026-09-23T12:00:00.000Z",
    hosts: ["claude", "codex"],
    server: headroomMcpServer(ctx),
  });
  return { layout, receipt };
}

describe("Headroom activation receipt", () => {
  it("records consent, pins, lock, hosts and the exact launcher", () => {
    const ctx = context();
    const { layout, receipt } = activated(ctx);
    expect(readHeadroomReceipt(layout)).toEqual({ state: "absent" });
    expect(writeHeadroomReceipt(layout, receipt, undefined)).toBe(true);
    const read = readHeadroomReceipt(layout);
    expect(read.state).toBe("valid");
    if (read.state !== "valid") throw new Error("expected a valid receipt");
    expect(read.receipt).toEqual(receipt);
    expect(read.receipt).toMatchObject({
      version: "aih-headroom-activation-receipt/v1",
      canonicalRoot: layout.project,
      consent: {
        activateHeadroom: true,
        acceptHeadroomEgress: true,
        acceptedAt: "2026-09-23T12:00:00.000Z",
      },
      pin: { package: "headroom-ai[mcp]==0.38.0", platform: "linux-x64" },
      egressControls: { HEADROOM_BEACON: "off", DO_NOT_TRACK: "1", HEADROOM_UPDATE_CHECK: "off" },
      hosts: ["claude", "codex"],
    });
    expect(read.receipt.launcher.server).toEqual(headroomMcpServer(ctx));
    expect(writeHeadroomReceipt(layout, receipt, read.sha256)).toBe(false);
    expect(() => writeHeadroomReceipt(layout, receipt, "0".repeat(64))).toThrow(/changed/u);
  });

  it("treats an older pin as stale and keeps its recorded launcher for removal", () => {
    const ctx = context();
    const { layout, receipt } = activated(ctx);
    writeFileSync(
      layout.receiptPath,
      `${JSON.stringify({ ...receipt, pin: { ...receipt.pin, package: "headroom-ai[mcp]==0.37.0", version: "0.37.0" } }, null, 2)}\n`,
    );
    const read = readHeadroomReceipt(layout);
    expect(read).toMatchObject({ state: "stale", reason: expect.stringContaining("0.37.0") });
    if (read.state !== "stale") throw new Error("expected a stale receipt");
    expect(read.receipt.launcher.server).toEqual(receipt.launcher.server);
  });

  it.each([
    ["malformed JSON", () => "{"],
    [
      "a foreign worktree",
      (receipt: Record<string, unknown>) =>
        JSON.stringify({ ...receipt, canonicalRoot: join(tmpdir(), "other-worktree") }),
    ],
    [
      "a forged launcher digest",
      (receipt: Record<string, unknown>) =>
        JSON.stringify({
          ...receipt,
          launcher: { ...(receipt.launcher as object), sha256: "a".repeat(64) },
        }),
    ],
    [
      "a consent flag that is not true",
      (receipt: Record<string, unknown>) =>
        JSON.stringify({
          ...receipt,
          consent: { ...(receipt.consent as object), acceptHeadroomEgress: false },
        }),
    ],
    [
      "an extra field",
      (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, activatedBy: "policy" }),
    ],
    [
      "an unsupported host",
      (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, hosts: ["notepad"] }),
    ],
  ])("fails closed for %s", (_label, mutate) => {
    const ctx = context();
    const { layout, receipt } = activated(ctx);
    writeFileSync(layout.receiptPath, mutate(receipt as unknown as Record<string, unknown>));
    expect(readHeadroomReceipt(layout)).toMatchObject({ state: "invalid" });
    expect(readFileSync(layout.receiptPath, "utf8").length).toBeGreaterThan(0);
  });
});
