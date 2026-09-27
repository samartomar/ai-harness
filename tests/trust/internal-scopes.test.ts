import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInternalScopes } from "../../src/trust/internal-scopes.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-trust-scopes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("resolveInternalScopes", () => {
  it("normalizes comma-separated env scopes and defaults empty", () => {
    expect(resolveInternalScopes({ env: {} })).toEqual([]);
    expect(
      resolveInternalScopes({ env: { AIH_TRUST_INTERNAL_SCOPES: "acme, @internal ,,tools" } }),
    ).toEqual(["@acme", "@internal", "@tools"]);
  });

  it("lowercases, deduplicates and sorts scopes into the form Scan requires", () => {
    expect(
      resolveInternalScopes({ env: { AIH_TRUST_INTERNAL_SCOPES: "Zeta,@acme,ACME,@beta" } }),
    ).toEqual(["@acme", "@beta", "@zeta"]);
  });

  it("unions env scopes with org-policy trust.internalScopes", () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          supportedClis: [
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
          ],
        },
        trust: { internalScopes: ["policy", "@shared"] },
      }),
    );

    expect(
      resolveInternalScopes({
        root: dir,
        env: { AIH_TRUST_INTERNAL_SCOPES: "envscope,@shared" },
      }),
    ).toEqual(["@envscope", "@policy", "@shared"]);
  });

  it("degrades to env scopes when org-policy is malformed", () => {
    write("aih-org-policy.json", "{ broken");

    expect(
      resolveInternalScopes({
        root: dir,
        env: { AIH_TRUST_INTERNAL_SCOPES: "@envscope" },
      }),
    ).toEqual(["@envscope"]);
  });
});
