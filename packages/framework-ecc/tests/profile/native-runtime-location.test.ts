import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { eccRuntimeScriptPath } from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import { defaultNativeRegistrationInput } from "../../src/profile/command.js";

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_ECC_STATE_ROOT: resolve("/state/aih-ecc") },
    options: { lifecycle: "install" },
  };
}

describe("the native ECC runtime location", () => {
  it("is Core's runtime script, obtained through framework-host, never a file beside the plugin", () => {
    const input = defaultNativeRegistrationInput(context(resolve("/repo")));
    expect(input.cliScript).toBe(eccRuntimeScriptPath());
    expect(basename(input.cliScript)).toBe("ecc-runtime.js");
    expect(basename(dirname(input.cliScript))).toBe("dist");
    const pluginSource = join(import.meta.dirname, "../../src");
    expect(dirname(input.cliScript)).not.toBe(join(pluginSource, "profile"));
    expect(readFileSync(join(pluginSource, "profile", "command.ts"), "utf8")).not.toContain(
      '"ecc-runtime.js"',
    );
  });
});
