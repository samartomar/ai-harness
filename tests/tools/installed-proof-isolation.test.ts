import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(import.meta.dirname, "..", "..", "tools", "verify-developer-tools-installed.mjs"),
  "utf8",
);

describe("installed developer-tools proof isolation", () => {
  it("never hands a subprocess the real user environment", () => {
    expect(script).not.toMatch(/env:\s*(?:\{\s*\.\.\.process\.env\s*\}|process\.env\b)/u);
  });

  it("runs every npm command with an empty userconfig and a private cache", () => {
    expect(script).toMatch(/npm_config_userconfig:\s*emptyUserConfig/u);
    expect(script).toMatch(/npm_config_cache:\s*npmCache/u);
    expect(script).toMatch(/const npmCache = join\(temp, /u);
    const npmRuns = [...script.matchAll(/run\(\s*\[process\.execPath, npmCli[\s\S]*?\)\s*,\s*"/gu)];
    expect(npmRuns.length).toBeGreaterThanOrEqual(2);
    for (const [call] of npmRuns) expect(call).toMatch(/env:\s*npmEnv\b/u);
  });

  it("reports whether the real user home was touched", () => {
    expect(script).toMatch(/check\(\s*"real-home-untouched"/u);
  });

  it("deactivates with a narrower --cli and requires every recorded host to be clean", () => {
    expect(script).toMatch(/check\(\s*"deactivate-narrower-cli-cleans-every-recorded-host"/u);
  });
});
