import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FrameworkEvidenceGatedInstallRequestV1 } from "../../src/framework-plugin/contract-v1.js";
import { frameworkHostServicesV1 } from "../../src/framework-plugin/host-services.js";
import {
  executeSuperpowersCommand,
  executeSuperpowersInitPhase,
} from "../../src/framework-plugin/superpowers-command.js";
import {
  type Action,
  digest,
  doc,
  dynamicDigest,
  exec,
  type Plan,
  type PlanContext,
  plan,
  probe,
  remove,
  writeText,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadSuperpowersFromSource } from "./plugin-source.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-framework-host-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
    ...over,
  };
}

function request(
  over: Partial<FrameworkEvidenceGatedInstallRequestV1> = {},
): FrameworkEvidenceGatedInstallRequestV1 {
  return {
    source: { owner: "obra", repo: "Superpowers", commit: "a".repeat(40) },
    components: [{ id: "skill:x", paths: ["skills/x"], skillContent: true }],
    componentIds: ["skill:x"],
    buildInstallPlan: () => plan("never"),
    ...over,
  };
}

describe("framework host services", () => {
  it("executes a report-only plugin plan and records the result as produced", async () => {
    const produced = new WeakSet<object>();
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx(),
      policy: undefined,
      transactionPins: {},
      produced,
    });
    const result = await host.executePlan(
      plan("plugin", doc("nothing to install", "all components current"), digest("summary", "ok")),
    );
    expect(produced.has(result)).toBe(true);
    expect(result.docs.map((entry) => entry.describe)).toEqual(["nothing to install"]);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["a file write", writeText("bypass.md", "unverified\n", "write")],
    ["a doc written to a file", doc("guidance", "unverified\n", "bypass.md")],
    ["a local command", exec("touch", ["touch", "bypass.md"])],
    [
      "a shell profile block",
      {
        kind: "envblock",
        path: "bypass.md",
        scope: "x",
        shell: "posix",
        vars: [],
        describe: "profile",
      } satisfies Action,
    ],
    ["a removal", remove("bypass.md", "remove")],
    ["a probe callback", probe("check", () => ({ name: "x", verdict: "pass" }) as never)],
    ["a late-bound digest callback", dynamicDigest("late", () => "text")],
  ])("refuses %s outside Core's evidence gate before any effect", async (_label, action) => {
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx(),
      policy: undefined,
      transactionPins: {},
      produced: new WeakSet(),
    });
    await expect(host.executePlan(plan("plugin", doc("ok", "ok"), action))).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_PLUGIN",
      message: expect.stringContaining("runEvidenceGatedInstall"),
    });
    expect(existsSync(join(root, "bypass.md"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("executes the report-only actions it checked, not ones the plugin adds afterwards", async () => {
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx(),
      policy: undefined,
      transactionPins: {},
      produced: new WeakSet(),
    });
    const sneaky = plan("plugin", doc("ok", "ok"));
    const pending = host.executePlan(sneaky);
    sneaky.actions.push(writeText("bypass.md", "unverified\n", "late write"));
    const result = await pending;
    expect(result.writes).toEqual([]);
    expect(existsSync(join(root, "bypass.md"))).toBe(false);
  });

  it("refuses a plan whose actions are not an array", async () => {
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx(),
      policy: undefined,
      transactionPins: {},
      produced: new WeakSet(),
    });
    await expect(
      host.executePlan({ capability: "plugin", actions: "nope" } as unknown as Plan),
    ).rejects.toMatchObject({ code: "AIH_FRAMEWORK_PLUGIN" });
  });

  it.each([
    ["an escaping component path", request({ components: [{ id: "skill:x", paths: ["../x"] }] })],
    ["no component ids", request({ componentIds: [] })],
    ["an unknown component id", request({ componentIds: ["skill:y"] })],
    ["a short commit", request({ source: { owner: "obra", repo: "Superpowers", commit: "abc" } })],
  ])("refuses a plugin evidence request with %s before any acquisition", async (_label, bad) => {
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx(),
      policy: undefined,
      transactionPins: {},
      produced: new WeakSet(),
    });
    await expect(host.runEvidenceGatedInstall(bad)).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_PLUGIN",
    });
  });

  it("keeps control characters out of plugin progress lines", () => {
    const lines: string[] = [];
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx({ progress: (line) => lines.push(line) }),
      policy: undefined,
      transactionPins: {},
      produced: new WeakSet(),
    });
    host.progress("step\u001b[2J\none");
    expect(lines).toEqual(["step[2J one"]);
  });
});

describe("the Catalog descriptor refusal", () => {
  const unavailable = async () =>
    ({
      ok: false,
      refusal: { reason: "catalog-package-unavailable", detail: "@aihq/catalog is not installed" },
    }) as const;
  const incompatible = async () =>
    ({
      ok: false,
      refusal: { reason: "catalog-package-incompatible", detail: "no framework descriptor" },
    }) as const;

  it("makes aih superpowers refuse by name when Catalog cannot supply the descriptor", async () => {
    await expect(
      executeSuperpowersCommand(ctx({ apply: false, targets: undefined }), {
        loadPlugin: () => loadSuperpowersFromSource(),
        loadDescriptor: unavailable,
      }),
    ).rejects.toMatchObject({
      code: "AIH_CATALOG_PACKAGE",
      message: expect.stringMatching(/^catalog-package-unavailable: /),
    });
  });

  it("reports init's Superpowers phase as refused: skipped when Catalog is absent", async () => {
    const result = await executeSuperpowersInitPhase(ctx({ apply: false, verify: false }), {
      loadPlugin: () => loadSuperpowersFromSource(),
      loadDescriptor: unavailable,
    });
    const check = result.report?.checks.find((entry) => entry.name === "init superpowers phase");
    expect(check?.verdict).toBe("skip");
    expect(result.docs.map((entry) => entry.describe)).toContain(
      "init: superpowers — refused (catalog-package-unavailable)",
    );
  });

  it("fails init's Superpowers phase when an installed Catalog is incompatible", async () => {
    const result = await executeSuperpowersInitPhase(ctx({ apply: false }), {
      loadPlugin: () => loadSuperpowersFromSource(),
      loadDescriptor: incompatible,
    });
    const check = result.report?.checks.find((entry) => entry.name === "init superpowers phase");
    expect(check?.verdict).toBe("fail");
    expect(result.report?.ok).toBe(false);
  });
});
