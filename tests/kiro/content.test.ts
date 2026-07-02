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
  enabled: boolean;
  name: string;
  when: { type: string };
  timeout?: number;
  then: { type: string; command: string };
}

function hookByName(name: string): KiroHookJson {
  const found = kiroHooks(stack()).find((h) => (h.hook as KiroHookJson).name === name);
  if (!found) throw new Error(`hook ${name} not generated`);
  return found.hook as KiroHookJson;
}

describe("kiroHooks — aih-metrics-on-stop (fail-open)", () => {
  it("fires on the verified agentStop event", () => {
    const metrics = hookByName("aih-metrics-on-stop");
    expect(metrics.when.type).toBe("agentStop");
    expect(metrics.then.type).toBe("runCommand");
  });

  it("wraps `aih track --apply` in a dependency-free, fail-open node one-shot", () => {
    const cmd = hookByName("aih-metrics-on-stop").then.command;
    // Still runs the real snapshot command...
    expect(cmd).toContain("aih track --apply");
    // ...but via `node -e` (a real cross-platform exe; resolves the `.cmd` shim through
    // cmd.exe /c on Windows) with a try/catch that swallows a missing/failing `aih`.
    expect(cmd.startsWith("node -e ")).toBe(true);
    expect(cmd).toContain("execSync");
    expect(cmd).toContain("catch");
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
    const metrics = kiroHooks(stack()).find(
      (h) => (h.hook as KiroHookJson).name === "aih-metrics-on-stop",
    )?.hook as { description: string };
    expect(metrics.description.toLowerCase()).toContain("fail-open");
  });
});

describe("kiroHooks — base set is unchanged", () => {
  it("still emits secret-scan and tests-on-edit hooks with real schema types", () => {
    const names = kiroHooks(stack({ testRunner: "npm test" })).map(
      (h) => (h.hook as KiroHookJson).name,
    );
    expect(names).toContain("aih-secret-scan-on-create");
    expect(names).toContain("aih-tests-on-edit");
    expect(names).toContain("aih-metrics-on-stop");
    expect(names).toContain("aih-quality-gate");
  });
});
