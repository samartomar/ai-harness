import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/guardrails/index.js";
import {
  GITLEAKS_ARGS,
  GITLEAKS_REV,
  preCommitConfigYaml,
} from "../../src/guardrails/precommit.js";
import {
  blockedLicensesFound,
  blockingLicenses,
  LICENSE_MATRIX,
} from "../../src/guardrails/sca.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner, missingToolRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as secretsCommand } from "../../src/secrets/index.js";

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

  it("plans the security artifacts + command-policy/risk-gate projections + gitleaks probe", async () => {
    const p = await command.plan(ctx());
    const writePaths = p.actions
      .filter((a) => a.kind === "write")
      .map((a) => (a as WriteAction).path);
    // gitleaks + pre-commit + sca, then the command-policy projection into Claude's
    // native permission file and the CI-checkable risk-gates JSON sidecar.
    expect(writePaths).toEqual([
      ".gitleaks.toml",
      ".pre-commit-config.yaml",
      ".github/workflows/sca.yml",
      ".claude/settings.json",
      ".ai-context/risk-gates.json",
    ]);
    // taxonomy (path) + license CI note + command-policy (path) + risk-gates CI note.
    expect(p.actions.filter((a) => a.kind === "doc")).toHaveLength(4);
    expect(p.actions.filter((a) => a.kind === "probe")).toHaveLength(1);
  });

  it("projects the command lexicon into .claude/settings.json as a MERGE write", async () => {
    const p = await command.plan(ctx());
    const settings = writeAt(p.actions, ".claude/settings.json");
    expect(settings?.merge).toBe(true);
    const perms = (settings?.json as { permissions: { deny: string[]; ask: string[] } })
      .permissions;
    expect(perms.deny).toContain("Bash(rm -rf /)");
    expect(perms.ask).toContain("Bash(git push*)");
  });

  it("writes the command-policy doc under the context dir (advisory reference)", async () => {
    const p = await command.plan(ctx());
    const cmdPolicy = p.actions.find(
      (a) => a.kind === "doc" && a.path === ".ai-context/command-policy.md",
    );
    expect(cmdPolicy).toBeDefined();
    if (cmdPolicy?.kind === "doc") {
      expect(cmdPolicy.text).toContain("Advisory vs. enforced");
    }
  });

  it("writes the CI-checkable risk-gates.json sidecar (aih-owned, not merged)", async () => {
    const p = await command.plan(ctx());
    const sidecar = writeAt(p.actions, ".ai-context/risk-gates.json");
    expect(sidecar).toBeDefined();
    expect(sidecar?.merge).toBeFalsy();
    const data = sidecar?.json as { gates: { name: string }[] };
    expect(data.gates).toHaveLength(7);
  });

  it("emits the risk-gates guidance as a doc that runs in YOUR CI (ask-not-deny)", async () => {
    const p = await command.plan(ctx());
    const riskNote = p.actions.find(
      (a) =>
        a.kind === "doc" &&
        a.path === undefined &&
        a.text.includes("YOUR CI") &&
        a.text.includes("Risk Gates"),
    );
    expect(riskNote).toBeDefined();
  });

  it("TWO WRITERS compose: secrets Read(...) + guardrails Bash(...) both survive the merge", async () => {
    // The §6 top risk made executable: scaffold/secrets and guardrails both write
    // `.claude/settings.json`; deepMerge unions `permissions.deny`, so neither clobbers.
    const applyCtx = ctx({ apply: true });
    await executePlan(await secretsCommand.plan(applyCtx), applyCtx);
    await executePlan(await command.plan(applyCtx), applyCtx);

    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as {
      permissions: { deny: string[]; ask: string[]; allow: string[] };
    };
    expect(settings.permissions.deny).toContain("Read(./.env*)"); // from secrets
    expect(settings.permissions.deny).toContain("Bash(rm -rf /)"); // from guardrails
    expect(settings.permissions.ask).toContain("Bash(git push*)"); // guardrails ask tier
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

  it("preserves a USER-authored pre-commit config instead of clobbering it", async () => {
    // A team config aih did not generate (no ownership marker), with its own hook.
    writeFileSync(
      join(dir, ".pre-commit-config.yaml"),
      "repos:\n  - repo: local\n    hooks:\n      - id: team-hook\n",
    );
    const p = await command.plan(ctx());
    const pre = writeAt(p.actions, ".pre-commit-config.yaml");
    expect(pre?.once).toBe(true); // write-once → never overwrites the user's file
    // ...and a merge doc hands over the exact gitleaks block to add.
    const mergeDoc = p.actions.find(
      (a) => a.kind === "doc" && a.describe.includes("gitleaks hook"),
    );
    expect(mergeDoc?.kind === "doc" && mergeDoc.text).toContain("gitleaks/gitleaks");
  });

  it("re-owns (normal rewrite, not once) a pre-commit config aih itself generated", async () => {
    writeFileSync(join(dir, ".pre-commit-config.yaml"), preCommitConfigYaml()); // carries the marker
    const p = await command.plan(ctx());
    const pre = writeAt(p.actions, ".pre-commit-config.yaml");
    expect(pre?.once).toBeUndefined(); // aih owns it → idempotent overwrite, no merge doc
    expect(p.actions.some((a) => a.kind === "doc" && a.describe.includes("gitleaks hook"))).toBe(
      false,
    );
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

  it("sca workflow SHA-pins its actions and uses the real anchore/sbom-action", async () => {
    const p = await command.plan(ctx());
    const yaml = writeAt(p.actions, ".github/workflows/sca.yml")?.contents ?? "";
    // No floating major-tag action refs, and not the non-existent syft-action.
    expect(yaml).not.toMatch(/uses: actions\/checkout@v\d/);
    expect(yaml).not.toContain("anchore/syft-action");
    // checkout + sbom-action pinned to a 40-hex commit SHA with a version comment.
    expect(yaml).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
    expect(yaml).toMatch(/uses: anchore\/sbom-action@[0-9a-f]{40} # v/);
    // correct sbom-action input is `format`, not the bogus `output-format`.
    expect(yaml).toContain("format: spdx-json");
    expect(yaml).not.toContain("output-format:");
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

  it("the license gate runs against SBOM fixtures: permissive passes, copyleft fails (AIH-SCA-TEST-001)", () => {
    const sbom = (ids: string[]) =>
      JSON.stringify({ packages: ids.map((id) => ({ licenseConcluded: id })) });
    // Clean: MIT / Apache / MPL (permissive + weak) → gate passes (no blocks).
    expect(blockedLicensesFound(sbom(["MIT", "Apache-2.0", "MPL-2.0"]))).toEqual([]);
    // Strong copyleft, modern SPDX → blocked.
    expect(blockedLicensesFound(sbom(["MIT", "GPL-3.0-only"]))).toContain("GPL-3.0-only");
    // Network copyleft (AGPL) → blocked.
    expect(blockedLicensesFound(sbom(["AGPL-3.0"]))).toContain("AGPL-3.0");
    // Malformed / empty SBOM text → no false positives.
    expect(blockedLicensesFound("")).toEqual([]);
    expect(blockedLicensesFound("{ not valid json")).toEqual([]);
  });

  it("blocks modern GPL SPDX -only / -or-later variants, not just bare GPL-2.0/3.0", () => {
    const blocking = blockingLicenses();
    for (const v of ["GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later"]) {
      expect(blocking).toContain(v);
    }
  });

  it("sca workflow enforces secret scanning in CI (gitleaks job), not only locally", async () => {
    const p = await command.plan(ctx());
    const yaml = writeAt(p.actions, ".github/workflows/sca.yml")?.contents ?? "";
    expect(yaml).toContain("secret-scan:");
    expect(yaml).toContain("gitleaks detect --config .gitleaks.toml");
    // CI uses the SAME pinned gitleaks version as the local pre-commit hook.
    expect(yaml).toContain(GITLEAKS_REV.replace(/^v/, ""));
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
