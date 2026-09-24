import { readFileSync } from "node:fs";
import { type Action, type Cli, SUPPORTED_CLIS } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import { superpowersActionsForCli, superpowersOverviewDoc } from "../src/guidance.js";
import { methodologySteering } from "../src/kiro-steering.js";

// Golden outputs captured from Core's own Superpowers implementation (src/superpowers/**,
// src/kiro/content.ts) at 80120883, before it moved into this plugin.
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/core-parity-golden.json", import.meta.url), "utf8"),
) as {
  methodologySteering: string;
  overview: Action;
  perCli: Record<Cli, { withPin: Action[]; withoutPin: Action[] }>;
};

const PIN = "a".repeat(40);
const docs = (actions: readonly Action[]) => actions.filter((action) => action.kind === "doc");
const execs = (actions: readonly Action[]) => actions.filter((action) => action.kind === "exec");

describe("per-CLI Superpowers guidance — parity with Core", () => {
  it.each([...SUPPORTED_CLIS])("%s matches Core's guidance with and without a pin", (cli) => {
    expect(superpowersActionsForCli(cli, PIN)).toEqual(golden.perCli[cli].withPin);
    expect(superpowersActionsForCli(cli)).toEqual(golden.perCli[cli].withoutPin);
  });

  it("claude: documents the official-marketplace plugin command", () => {
    const text = docs(superpowersActionsForCli("claude"))
      .map((action) => (action.kind === "doc" ? action.text : ""))
      .join("\n");
    expect(text).toContain("/plugin install superpowers@claude-plugins-official");
  });

  it("antigravity and copilot: evidence-bound guidance, never a mutable remote exec", () => {
    for (const cli of ["antigravity", "copilot"] as const) {
      const actions = superpowersActionsForCli(cli, PIN);
      expect(execs(actions)).toHaveLength(0);
      const text = JSON.stringify(actions);
      expect(text).toContain(PIN);
      expect(text).toContain("not evidence-covered");
    }
  });

  it("codex and kimi: the /plugins TUI flow (not shell-runnable)", () => {
    for (const cli of ["codex", "kimi"] as const) {
      expect(JSON.stringify(superpowersActionsForCli(cli))).toContain("/plugins");
    }
  });

  it("other CLIs point at the upstream INSTALL guide", () => {
    for (const cli of ["cursor", "gemini", "windsurf", "opencode", "zed"] as const) {
      expect(JSON.stringify(superpowersActionsForCli(cli))).toContain(
        "github.com/obra/superpowers",
      );
    }
  });

  it("the overview matches Core's", () => {
    expect(superpowersOverviewDoc()).toEqual(golden.overview);
  });
});

describe("Kiro methodology steering — parity with Core", () => {
  it("is byte-identical to Core's always-on steering", () => {
    expect(methodologySteering()).toBe(golden.methodologySteering);
  });

  it("is always-on Kiro steering carrying the disciplined loop", () => {
    const steering = methodologySteering();
    expect(steering.startsWith("---\ninclusion: always\n---\n\n")).toBe(true);
    expect(steering).toContain("TDD");
    expect(steering).toContain("aih superpowers --cli <tool>");
  });
});
