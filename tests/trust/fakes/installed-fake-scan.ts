import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as LoadScanPackage from "../../../src/scan-package/load-scan-package.js";
import type { FakeScanAdapterForTests } from "./fake-scan-adapter.js";
import {
  type FakeTrustLintArtifactV1,
  type FakeTrustLintOptionsV1,
  type FakeTrustLintResultV1,
  fakeTrustLintScan,
} from "./fake-trust-lint.js";

/**
 * TEST FAKE. For a test that reaches Scan's execution through the installed
 * package rather than an injected adapter, replace only
 * `loadScanExecutionAdapterV1` with `adapter()`; every other export (Scan's
 * attestation verification, the probe, the shard runner) stays the real one.
 *
 *   vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) =>
 *     (await import("../trust/fakes/installed-fake-scan.js")).withInstalledFakeScan(
 *       await importOriginal(),
 *     ),
 *   );
 *
 * The default adapter is a trust lint that reports `lint` (no findings and
 * neutral facts for every selected path unless given); `setInstalledFakeScan`
 * swaps it for one test.
 */

let current: FakeScanAdapterForTests | undefined;
let lint: Parameters<typeof fakeTrustLintScan>[0] = {};

/** Use `adapter` as the installed Scan until `resetInstalledFakeScan`. */
export function setInstalledFakeScan(adapter: FakeScanAdapterForTests): void {
  current = adapter;
}

export function resetInstalledFakeScan(): void {
  current = undefined;
}

/** The adapter the installed-package route returns right now. */
export function installedFakeScan(): FakeScanAdapterForTests {
  current ??= fakeTrustLintScan(lint);
  return current;
}

export function withInstalledFakeScan(
  original: typeof LoadScanPackage,
  defaultLint:
    | FakeTrustLintOptionsV1
    | ((
        selectedPaths: readonly string[],
        request: Record<string, unknown>,
      ) => FakeTrustLintOptionsV1) = {},
): typeof LoadScanPackage {
  lint = defaultLint;
  current = undefined;
  return {
    ...original,
    loadScanExecutionAdapterV1: async () => ({ ok: true, adapter: installedFakeScan() }),
  };
}

/**
 * A trust lint for committed fixtures, stating two things Scan reports for them:
 * every selected line containing "Ignore (all) previous instructions" is a
 * `trust.prompt-injection` finding, and a file named like a licence
 * (`LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, any extension) is legal text.
 * Only those; this is a fixture fake, not a lint.
 */
export function fixtureTrustLint(
  selectedPaths: readonly string[],
  request: Record<string, unknown>,
): FakeTrustLintOptionsV1 {
  const sourceRoot = (request.subject as { sourceRoot?: unknown } | undefined)?.sourceRoot;
  if (typeof sourceRoot !== "string") return {};
  const results: FakeTrustLintResultV1[] = [];
  const artifacts: Record<string, FakeTrustLintArtifactV1> = {};
  for (const path of selectedPaths) {
    if (/^(?:licen[cs]e|copying|notice)(?:\.[^/]*)?$/i.test(path.split("/").at(-1) ?? "")) {
      artifacts[path] = { legalText: true };
    }
    let text: string;
    try {
      text = readFileSync(join(sourceRoot, path), "utf8");
    } catch {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!/ignore (?:all )?previous instructions/i.test(line)) continue;
      results.push({
        ruleId: "trust.prompt-injection",
        message: `${path}:${index + 1} — prompt-injection.ignore-instructions: attempts to override prior/system instructions`,
        uri: path,
        line: index + 1,
        fingerprint: `trust-prompt-injection:${path}:${index + 1}`,
      });
    }
  }
  return { results, artifacts };
}
