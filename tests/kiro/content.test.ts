import { describe, expect, it } from "vitest";
import { kiroHooks } from "../../src/kiro/content.js";
import type { RepoStack } from "../../src/profile/scan.js";

function stack(over: Partial<RepoStack> = {}): RepoStack {
  return {
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    hasTypeScript: false,
    scripts: {},
    entryPoints: [],
    browserTest: false,
    isMonorepo: false,
    ...over,
  };
}

interface KiroHookJson {
  version: string;
  hooks: Array<{
    enabled?: boolean;
    name: string;
    description?: string;
    trigger: string;
    matcher?: string;
    timeout?: number;
    action: { type: string; command?: string; prompt?: string };
  }>;
}

function hookByName(name: string, over: Partial<RepoStack> = {}): KiroHookJson["hooks"][number] {
  const found = kiroHooks(stack(over)).find((h) =>
    (h.hook as KiroHookJson).hooks.some((hook) => hook.name === name),
  );
  if (!found) throw new Error(`hook ${name} not generated`);
  const hook = (found.hook as KiroHookJson).hooks.find((candidate) => candidate.name === name);
  if (!hook) throw new Error(`hook ${name} not generated`);
  return hook;
}

describe("kiroHooks — aih-metrics-on-stop (fail-open)", () => {
  it("uses the standalone v1 Stop trigger", () => {
    const metrics = hookByName("aih-metrics-on-stop");
    expect(metrics.trigger).toBe("Stop");
    expect(metrics.action.type).toBe("command");
  });

  it("wraps `aih track --apply` in a fail-open node one-shot without shell execution", () => {
    const cmd = hookByName("aih-metrics-on-stop").action.command ?? "";
    // Still runs the real snapshot command...
    expect(cmd).toContain("['track','--apply']");
    // ...but via `node -e` with execFileSync(shell:false), a filtered PATH, and a
    // catch that warns without failing the turn when `aih` is missing/failing.
    expect(cmd.startsWith("node -e ")).toBe(true);
    expect(cmd).toContain("execFileSync");
    expect(cmd).toContain("shell:false");
    expect(cmd).toContain("path.relative");
    expect(cmd).toContain("catch");
    expect(cmd).toContain("console.warn");
    // An inner timeout bounds a stuck `aih` even if the host ignores the hook timeout.
    expect(cmd).toMatch(/timeout:\s*\d+/);
    // Not the bare command that fails every turn when `aih` isn't on PATH.
    expect(cmd).not.toBe("aih track --apply");
  });

  it("caps the turn with a seconds-unit hook timeout (Kiro default is 60s)", () => {
    const metrics = hookByName("aih-metrics-on-stop");
    expect(metrics.timeout).toBeGreaterThan(0);
    expect(metrics.timeout).toBeLessThanOrEqual(60);
  });

  it("advertises its fail-open behavior in the description (no false PATH promise)", () => {
    expect(hookByName("aih-metrics-on-stop").description?.toLowerCase()).toContain("fail-open");
  });
});

describe("kiroHooks — base set is unchanged", () => {
  it("still emits secret-scan and tests-on-edit hooks with real schema types", () => {
    const names = kiroHooks(stack({ testRunner: "npm test" })).map(
      (h) => (h.hook as KiroHookJson).hooks[0]?.name,
    );
    expect(names).toContain("aih-secret-scan-on-create");
    expect(names).toContain("aih-tests-on-edit");
    expect(names).toContain("aih-metrics-on-stop");
    expect(names).not.toContain("aih-quality-gate");
  });

  it("uses current standalone JSON paths and PascalCase file triggers", () => {
    const generated = kiroHooks(stack({ languages: ["TypeScript/Node.js"] }));
    expect(generated.map((hook) => hook.path)).toContain(".kiro/hooks/aih-tests-on-edit.json");
    const tests = hookByName("aih-tests-on-edit", { languages: ["TypeScript/Node.js"] });
    expect(tests.trigger).toBe("PostFileSave");
    expect(tests.matcher).toBe("\\.(ts|tsx|js|jsx)$");
    expect(tests.action.type).toBe("agent");
    expect(
      generated.flatMap((file) => (file.hook as KiroHookJson).hooks.map((hook) => hook.trigger)),
    ).not.toContain("Manual");
  });
});
