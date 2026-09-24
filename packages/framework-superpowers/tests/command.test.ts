import { readFileSync } from "node:fs";
import type { Action, DigestAction, Plan, WriteAction } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import { executeSuperpowers, identifyComponents } from "../src/command.js";
import { methodologySteering } from "../src/kiro-steering.js";
import {
  authorization,
  catalogDescriptor,
  descriptorFromDocument,
  operationContext,
  PINNED_COMMIT,
  pinnedDescriptorDocument,
} from "./context.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/core-parity-golden.json", import.meta.url), "utf8"),
) as { sourceRoot: string; verifiedAllClis: Plan };

const ALL_CLIS = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "gemini",
  "copilot",
  "windsurf",
  "opencode",
  "zed",
  "kimi",
  "kiro",
] as const;

describe("identifyComponents", () => {
  it("applies every pinned component to each targeted host with an upstream route", () => {
    const identified = identifyComponents(
      operationContext({ targets: ["claude", "kiro"], descriptor: catalogDescriptor() }),
    );
    expect(identified.upstream).toEqual({ repository: "obra/Superpowers", commit: PINNED_COMMIT });
    expect(identified.components).toHaveLength(15);
    expect(identified.components.every((component) => component.hosts.join() === "claude")).toBe(
      true,
    );
  });
});

describe("the superpowers command", () => {
  it("asks Core's evidence gate for the exact pinned source and every component", async () => {
    const ctx = operationContext({ descriptor: catalogDescriptor() });
    await executeSuperpowers(ctx);
    expect(ctx.host.requests).toHaveLength(1);
    const [request] = ctx.host.requests;
    expect(request?.source).toEqual({ owner: "obra", repo: "Superpowers", commit: PINNED_COMMIT });
    expect(request?.componentIds).toHaveLength(15);
    expect(request?.componentIds[0]).toBe("runtime:superpowers-plugin");
    expect(request?.componentIds).toContain("skill:test-driven-development");
    expect(request?.components.find((component) => component.id === "skill:writing-plans")).toEqual(
      { id: "skill:writing-plans", paths: ["skills/writing-plans"], skillContent: true },
    );
  });

  it("honours an exact AIH_SUPERPOWERS_REF override", async () => {
    const override = "d".repeat(40);
    const ctx = operationContext({ env: { AIH_SUPERPOWERS_REF: ` ${override} ` } });
    await executeSuperpowers(ctx);
    expect(ctx.host.requests[0]?.source.commit).toBe(override);
  });

  it.each(["main", "D".repeat(40), "abc123"])(
    "refuses AIH_SUPERPOWERS_REF=%s before any evidence request",
    async (value) => {
      const ctx = operationContext({ env: { AIH_SUPERPOWERS_REF: value } });
      await expect(executeSuperpowers(ctx)).rejects.toMatchObject({
        code: "AIH_CONFIG",
        message:
          "AIH_SUPERPOWERS_REF must be an exact lowercase 40-character commit SHA for evidence-gated installs",
      });
      expect(ctx.host.requests).toHaveLength(0);
    },
  );

  it("refuses a malformed descriptor before any evidence request", async () => {
    const ctx = operationContext({
      descriptor: descriptorFromDocument({ ...pinnedDescriptorDocument(), version: 9 }),
    });
    await expect(executeSuperpowers(ctx)).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_DESCRIPTOR",
    });
    expect(ctx.host.requests).toHaveLength(0);
  });

  it("builds Core's exact verified guidance for every CLI once the source is verified", async () => {
    const ctx = operationContext({ targets: [...ALL_CLIS], descriptor: catalogDescriptor() });
    await executeSuperpowers(ctx);
    const request = ctx.host.requests[0];
    const authorizations = (request?.componentIds ?? []).map((id) => authorization(id));
    const built = await request?.buildInstallPlan({
      sourceRoot: golden.sourceRoot,
      authorizations,
      held: [],
    });
    expect(built).toEqual(golden.verifiedAllClis);
  });

  it("emits receipts and manual guidance without mutable remote execs", async () => {
    const ctx = operationContext({ targets: ["antigravity", "copilot", "kiro"] });
    await executeSuperpowers(ctx);
    const request = ctx.host.requests[0];
    const authorizations = (request?.componentIds ?? []).map((id) => authorization(id));
    const built = await request?.buildInstallPlan({
      sourceRoot: "/quarantine/tree",
      authorizations,
      held: [],
    });
    const actions: Action[] = built?.actions ?? [];
    expect(actions.filter((action) => action.kind === "exec")).toHaveLength(0);
    const steering = actions.find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === ".kiro/steering/superpowers-methodology.md",
    );
    expect(steering?.contents).toBe(methodologySteering());
    const digest = actions.find(
      (action): action is DigestAction => action.kind === "digest" && action.data !== undefined,
    );
    expect(digest?.data).toEqual({ authorizations });
    expect(JSON.stringify(actions)).toContain("not evidence-covered");
  });

  it("labels a policy-disabled hook in the verified guidance and keeps the guidance", async () => {
    const ctx = operationContext({
      targets: ["claude"],
      policy: {
        posture: "enterprise",
        hookControls: { disabled: [{ hookId: "hook:session-start", authority: "enterprise" }] },
      },
    });
    await executeSuperpowers(ctx);
    const request = ctx.host.requests[0];
    const built = await request?.buildInstallPlan({
      sourceRoot: "/quarantine/tree",
      authorizations: (request?.componentIds ?? []).map((id) => authorization(id)),
      held: [],
    });
    const describes = (built?.actions ?? []).map((action) => action.describe);
    expect(describes).toContain("Install Superpowers for Claude Code (plugin)");
    expect(describes.some((describe) => describe.includes("hook:session-start"))).toBe(true);
  });

  it("does not need the hook inventory when policy disables no hook", async () => {
    const document = pinnedDescriptorDocument();
    delete (document.sections as Record<string, unknown>).hookControlInventory;
    const ctx = operationContext({ descriptor: descriptorFromDocument(document) });
    await expect(executeSuperpowers(ctx)).resolves.toBeDefined();
  });

  it("refuses a policy-disabled hook when the descriptor carries no hook inventory", async () => {
    const document = pinnedDescriptorDocument();
    delete (document.sections as Record<string, unknown>).hookControlInventory;
    const ctx = operationContext({
      descriptor: descriptorFromDocument(document),
      policy: {
        posture: "vibe",
        hookControls: { disabled: [{ hookId: "hook:session-start", authority: "user" }] },
      },
    });
    await expect(executeSuperpowers(ctx)).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_DESCRIPTOR",
    });
    expect(ctx.host.requests).toHaveLength(0);
  });
});
