import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `checkNativeIdentityDrift` (the exported, pure function) already has thorough
 * behavioral coverage in tests/baseline-evidence/native-identity.test.ts. This file
 * targets the parts of src/internals/check-native-identity.ts that only live inside the
 * unexported CLI `main()` and its `import.meta.url` self-invocation guard: reproduce how
 * `tsx` would run this file by pointing `process.argv[1]` at the module's own resolved
 * path, then dynamically re-import after `vi.resetModules()` so the guard re-evaluates
 * and calls `main()` for real.
 *
 * `--write` is deliberately NOT exercised here. `writeNativeIdentityData()` writes to a
 * path derived from this module's own file location
 * (`src/baseline-evidence/native-identity-data.json`) with no override hook, and
 * `discoverNativeDetectorSourceFiles()` / `computeNativeDetectorDigest()` likewise default
 * to the live repo root with no injection point from the CLI. Exercising `--write` for
 * real would overwrite the just-regenerated, currently-correct committed identity
 * snapshot; simulating it safely would require mocking `node:fs`, a pattern this suite
 * does not otherwise use anywhere. Same reasoning applies to the drift-found branch of
 * the non-`--write` path (the `addedSources`/`removedSources`/`digestDrift` stderr
 * block): it only fires when the live repo tree has genuinely drifted from the committed
 * constants, which is not a state this suite should manufacture. Both are left uncovered
 * here as a deliberate, documented gap rather than gamed.
 *
 * The success path below (repo tree matches the committed constants) is exercised for
 * real, against the live repository tree — the same live-tree assumption the existing
 * `checkNativeIdentityDrift()` "reports ok" test already relies on.
 */
describe("check-native-identity CLI (main() via the process.argv guard)", () => {
  const SCRIPT_PATH = fileURLToPath(
    new URL("../../src/internals/check-native-identity.ts", import.meta.url),
  );
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("invokes main() end-to-end and reports the identity is current for the live repo tree", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = [originalArgv[0] ?? "node", SCRIPT_PATH];
    vi.resetModules();

    await import("../../src/internals/check-native-identity.js");

    expect(process.exitCode).not.toBe(1);
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toMatch(/^native-detector identity is current \(native\.[0-9a-f]{12}\)\n$/);
  });
});
