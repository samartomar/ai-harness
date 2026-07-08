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
  then: { type: string; command?: string; prompt?: string };
}

function hookByName(name: string, over: Partial<RepoStack> = {}): KiroHookJson {
  const found = kiroHooks(stack(over)).find((h) => (h.hook as KiroHookJson).name === name);
  if (!found) throw new Error(`hook ${name} not generated`);
  return found.hook as KiroHookJson;
}

describe("kiroHooks — aih-metrics-on-stop (fail-open)", () => {
  it("fires on the verified agentStop event", () => {
    const metrics = hookByName("aih-metrics-on-stop");
    expect(metrics.when.type).toBe("agentStop");
    expect(metrics.then.type).toBe("runCommand");
  });

  it("wraps `aih track --apply` in a fail-open node one-shot without shell execution", () => {
    const cmd = hookByName("aih-metrics-on-stop").then.command ?? "";
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

  it("uses the declared verify command as the manual quality gate when available", () => {
    const gate = hookByName("aih-quality-gate", {
      verifyCommand: "npm run verify",
      testRunner: "npm test",
      lintCommand: "npm run lint",
    });

    expect(gate.then.command).toBe("npm run verify");
  });
});
