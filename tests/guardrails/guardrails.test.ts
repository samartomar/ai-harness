import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/guardrails/index.js";
import { GITLEAKS_ARGS, GITLEAKS_REV } from "../../src/guardrails/precommit.js";
import { blockingLicenses, LICENSE_MATRIX } from "../../src/guardrails/sca.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner, missingToolRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-guardrails-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

/** Find a write action by its target path. */
function writeAt(actions: Action[], path: string): WriteAction | undefined {
  return actions.find((a): a is WriteAction => a.kind === "write" && a.path === path);
}

describe("guardrails command", () => {
  it("keeps the command name stable and exposes a real plan", async () => {
    expect(command.name).toBe("guardrails");
    const p = await command.plan(ctx());
    expect(p.capability).toBe("guardrails");
    expect(p.actions.length).toBeGreaterThan(0);
  });

  it("plans exactly the four artifacts plus CI note and gitleaks probe", async () => {
    const p = await command.plan(ctx());
    const writePaths = p.actions
      .filter((a) => a.kind === "write")
      .map((a) => (a as WriteAction).path);
    expect(writePaths).toEqual([
      ".gitleaks.toml",
      ".pre-commit-config.yaml",
      ".github/workflows/sca.yml",
    ]);
    expect(p.actions.filter((a) => a.kind === "doc")).toHaveLength(2);
    expect(p.actions.filter((a) => a.kind === "probe")).toHaveLength(1);
  });

  it("gitleaks.toml extends defaults and carries BOTH enterprise regexes", async () => {
    const p = await command.plan(ctx());
    const toml = writeAt(p.actions, ".gitleaks.toml")?.contents ?? "";
    expect(toml).toContain("useDefault = true");
    // AWS access-key id (temporary A3T + long-term AKIA).
    expect(toml).toContain("(?i)(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16})");
    // Generic PEM private-key header.
    expect(toml).toContain("-----BEGIN [A-Z]+ PRIVATE KEY-----");
  });

  it("gitleaks.toml allowlists local scratch only (never source)", async () => {
    const p = await command.plan(ctx());
    const toml = writeAt(p.actions, ".gitleaks.toml")?.contents ?? "";
    expect(toml).toContain("[allowlist]");
    expect(toml).toContain(".var/");
    expect(toml).toContain(".aih-scratch/");
    expect(toml).not.toContain("src/");
  });

  it("pre-commit config wires the gitleaks repo with the pinned rev and args", async () => {
    const p = await command.plan(ctx());
    const yaml = writeAt(p.actions, ".pre-commit-config.yaml")?.contents ?? "";
    expect(yaml).toContain("repo: https://github.com/gitleaks/gitleaks");
    // Pin the EXACT rev the blueprint standardizes on (v8.24.2), not just "some v8".
    expect(GITLEAKS_REV).toBe("v8.24.2");
    expect(yaml).toContain(`rev: ${GITLEAKS_REV}`);
    expect(yaml).toContain("id: gitleaks");
    expect(GITLEAKS_ARGS).toEqual(["--verbose", "--config=.gitleaks.toml"]);
    expect(yaml).toContain('args: ["--verbose", "--config=.gitleaks.toml"]');
  });

  it("adds a local lint hook ONLY when the repo defines a lint command", async () => {
    // No lint command → gitleaks only, never a hook that runs a missing script.
    const bare = writeAt((await command.plan(ctx())).actions, ".pre-commit-config.yaml");
    expect(bare?.contents).not.toContain("repo: local");
    expect(bare?.contents).not.toContain("npm run lint");

    // With a real lint script → a local hook running that exact command.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
    const withLint = writeAt((await command.plan(ctx())).actions, ".pre-commit-config.yaml");
    expect(withLint?.contents).toContain("repo: local");
    expect(withLint?.contents).toContain("entry: npm run lint");
  });

  it("sca workflow blocks AGPL / strong copyleft and notes the matrix", async () => {
    const p = await command.plan(ctx());
    const yaml = writeAt(p.actions, ".github/workflows/sca.yml")?.contents ?? "";
    expect(yaml).toContain("name: sca");
    // Encodes the full disposition matrix...
    expect(yaml).toContain("permissive");
    expect(yaml).toContain("weak-copyleft");
    expect(yaml).toContain("strong-copyleft");
    expect(yaml).toContain("network-copyleft");
    // ...and actually blocks AGPL.
    expect(yaml).toContain("AGPL-3.0");
    expect(yaml.toLowerCase()).toContain("copyleft");
    for (const spdx of blockingLicenses()) {
      expect(yaml).toContain(spdx);
    }
    // The runtime gate keys off BLOCKED_LICENSES — it must carry exactly the
    // blocking SPDX set (space-joined), nothing more, nothing less.
    expect(yaml).toContain(`BLOCKED_LICENSES: "${blockingLicenses().join(" ")}"`);
  });

  it("license matrix dispositions match the blueprint compliance gates", () => {
    // blueprint: Legal and Open-Source Compliance Gates matrix.
    const disp = (category: string) =>
      LICENSE_MATRIX.find((t) => t.category === category)?.disposition;
    expect(disp("permissive")).toBe("auto-approve"); // MIT/Apache/BSD -> Auto-Approve
    expect(disp("weak-copyleft")).toBe("alert"); // MPL/LGPL/EPL -> Manual Alert
    expect(disp("strong-copyleft")).toBe("fail"); // GPL v2/v3 -> Fail-on-Risk
    expect(disp("network-copyleft")).toBe("block"); // AGPL v3 -> Block SaaS
    // The blueprint examples must land in the right tier.
    const tierOf = (spdx: string) => LICENSE_MATRIX.find((t) => t.spdx.includes(spdx))?.category;
    expect(tierOf("MIT")).toBe("permissive");
    expect(tierOf("Apache-2.0")).toBe("permissive");
    expect(tierOf("BSD-3-Clause")).toBe("permissive");
    expect(tierOf("MPL-2.0")).toBe("weak-copyleft");
    expect(tierOf("LGPL-3.0")).toBe("weak-copyleft");
    expect(tierOf("EPL-2.0")).toBe("weak-copyleft");
    expect(tierOf("GPL-2.0")).toBe("strong-copyleft");
    expect(tierOf("GPL-3.0")).toBe("strong-copyleft");
    expect(tierOf("AGPL-3.0")).toBe("network-copyleft");
  });

  it("blockingLicenses are exactly the fail + block tiers (GPL + AGPL/SSPL)", () => {
    const blocking = blockingLicenses();
    expect(blocking).toContain("GPL-3.0");
    expect(blocking).toContain("AGPL-3.0");
    expect(blocking).toContain("SSPL-1.0");
    // Permissive + weak-copyleft must NOT be blocking.
    expect(blocking).not.toContain("MIT");
    expect(blocking).not.toContain("MPL-2.0");
  });

  it("writes the taxonomy doc under the context dir as a doc action (no exec/cloud)", async () => {
    const p = await command.plan(ctx());
    const taxonomy = p.actions.find(
      (a) => a.kind === "doc" && a.path === ".ai-context/guardrails-taxonomy.md",
    );
    expect(taxonomy).toBeDefined();
    if (taxonomy?.kind === "doc") {
      expect(taxonomy.text).toContain("Golden Paths");
      expect(taxonomy.text).toContain("Guardrails");
      expect(taxonomy.text).toContain("Safety Nets");
    }
  });

  it("honors a custom contextDir for the taxonomy doc path", async () => {
    const p = await command.plan(ctx({ contextDir: ".context" }));
    const taxonomy = p.actions.find(
      (a) => a.kind === "doc" && a.path === ".context/guardrails-taxonomy.md",
    );
    expect(taxonomy).toBeDefined();
  });

  it("BOUNDARY: no exec actions and the CI note is doc-only (runs in their pipeline)", async () => {
    const p = await command.plan(ctx());
    // The harness never runs CI: there must be zero local exec actions...
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
    // ...and CI activation is human guidance, not a written/run artifact.
    const ciNote = p.actions.find(
      (a) => a.kind === "doc" && a.path === undefined && a.text.includes("YOUR CI"),
    );
    expect(ciNote).toBeDefined();
  });

  it("dry-run writes nothing but reports every planned artifact", async () => {
    const res = await executePlan(await command.plan(ctx()), ctx({ apply: false }));
    expect(res.applied).toBe(false);
    const planned = res.writes.map((w) => w.path);
    expect(planned).toContain(".gitleaks.toml");
    expect(planned).toContain(".github/workflows/sca.yml");
    expect(res.writes.every((w) => w.effect === "create")).toBe(true);
    // doc-with-path (taxonomy) is reported as a doc, not a write.
    expect(res.docs.some((d) => d.path === ".ai-context/guardrails-taxonomy.md")).toBe(true);
  });

  it("is idempotent: re-planning yields byte-identical generated content", async () => {
    const a = await command.plan(ctx());
    const b = await command.plan(ctx());
    const grab = (acts: Action[], path: string) => writeAt(acts, path)?.contents;
    expect(grab(a.actions, ".gitleaks.toml")).toBe(grab(b.actions, ".gitleaks.toml"));
    expect(grab(a.actions, ".github/workflows/sca.yml")).toBe(
      grab(b.actions, ".github/workflows/sca.yml"),
    );
  });

  it("verify: gitleaks probe SKIPS when the tool is absent (never fails)", async () => {
    const res = await executePlan(
      await command.plan(ctx({ run: missingToolRunner })),
      ctx({ verify: true, run: missingToolRunner }),
    );
    const check = res.report?.checks.find((c) => c.name === "gitleaks present");
    expect(check?.verdict).toBe("skip");
    expect(res.report?.ok).toBe(true);
  });

  it("verify: gitleaks probe PASSES and reports the version when present", async () => {
    const run: Runner = fakeRunner((argv) =>
      argv[0] === "gitleaks" && argv[1] === "version" ? { code: 0, stdout: "8.18.4\n" } : undefined,
    );
    const res = await executePlan(await command.plan(ctx({ run })), ctx({ verify: true, run }));
    const check = res.report?.checks.find((c) => c.name === "gitleaks present");
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("8.18.4");
  });
});
