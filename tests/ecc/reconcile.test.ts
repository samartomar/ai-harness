import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentId, EccMcpComponentId } from "../../src/ecc/components.js";
import {
  eccInstallStateCandidates,
  reconcileEccRegistrationLedger,
} from "../../src/ecc/reconcile.js";
import type {
  ProjectRegistration,
  RegistrationLedger,
  TargetRegistration,
} from "../../src/ecc/registration.js";

let home: string;
let reactRoot: string;
let cppRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-ecc-reconcile-"));
  reactRoot = join(home, "projects", "react");
  cppRoot = join(home, "projects", "cpp");
  mkdirSync(reactRoot, { recursive: true });
  mkdirSync(cppRoot, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function authorization(componentId = "module:rules-core"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function project(
  root: string,
  components: EccComponentId[],
  mcps: EccMcpComponentId[] = ["mcp:sequential-thinking"],
  scope: ProjectRegistration["scope"] = "scoped",
): ProjectRegistration {
  return { root: resolve(root), scope, components, mcps };
}

function target(
  components: EccComponentId[],
  mcps: EccMcpComponentId[] = ["mcp:sequential-thinking", "mcp:github"],
  name: TargetRegistration["target"] = "codex",
): TargetRegistration {
  return {
    target: name,
    components: components.map((id) => ({ id, authorization: authorization() })),
    mcps,
  };
}

function ledger(
  projects: ProjectRegistration[],
  targets: TargetRegistration[] = [
    target(["baseline:rules", "skill:coding-standards", "framework:react", "lang:cpp"]),
  ],
): RegistrationLedger {
  return { schemaVersion: 1, projects, targets };
}

describe("ECC registration reconciliation", () => {
  it("retires only missing projects and filters targets to the live union", () => {
    const input = ledger([
      project(reactRoot, ["baseline:rules", "skill:coding-standards", "framework:react"]),
      project(cppRoot, ["baseline:rules", "skill:coding-standards", "lang:cpp"], [
        "mcp:sequential-thinking",
        "mcp:github",
      ]),
    ]);

    const result = reconcileEccRegistrationLedger(input, {
      projectStatus: (root) => (root === resolve(cppRoot) ? "missing" : "live"),
    });

    expect(result.retiredProjects).toEqual([resolve(cppRoot)]);
    expect(result.desired).toEqual({
      components: ["baseline:rules", "framework:react", "skill:coding-standards"],
      mcps: ["mcp:sequential-thinking"],
    });
    expect(result.removedComponents).toEqual(["lang:cpp"]);
    expect(result.removedMcps).toEqual(["mcp:github"]);
    expect(result.ledger.projects.map(({ root }) => root)).toEqual([resolve(reactRoot)]);
    expect(result.ledger.targets[0]?.components.map(({ id }) => id)).toEqual([
      "baseline:rules",
      "framework:react",
      "skill:coding-standards",
    ]);
    expect(result.ledger.targets[0]?.mcps).toEqual(["mcp:sequential-thinking"]);
  });

  it("keeps shared components until their last live contributor is gone", () => {
    const input = ledger([
      project(reactRoot, ["baseline:rules", "skill:coding-standards", "framework:react"]),
      project(cppRoot, ["baseline:rules", "skill:coding-standards", "lang:cpp"]),
    ]);

    const first = reconcileEccRegistrationLedger(input, {
      projectStatus: (root) => (root === resolve(reactRoot) ? "missing" : "live"),
    });
    expect(first.desired.components).toContain("skill:coding-standards");

    const last = reconcileEccRegistrationLedger(input, { projectStatus: () => "missing" });
    expect(last.desired).toEqual({ components: [], mcps: [] });
    expect(last.ledger.targets[0]?.components).toEqual([]);
  });

  it("preserves existing target content while any live project has full scope", () => {
    const input = ledger([
      project(reactRoot, ["baseline:rules"], ["mcp:sequential-thinking"], "full"),
      project(cppRoot, ["lang:cpp"]),
    ]);

    const result = reconcileEccRegistrationLedger(input, {
      projectStatus: (root) => (root === resolve(cppRoot) ? "missing" : "live"),
    });

    expect(result.full).toBe(true);
    expect(result.ledger.targets).toEqual(input.targets);
    expect(result.removedComponents).toEqual([]);
    expect(result.removedMcps).toEqual([]);
  });

  it("removes a whole-target aggregate only when existing prune already drops it", () => {
    const input = ledger(
      [project(reactRoot, ["baseline:rules"])],
      [target(["baseline:rules"], [], "codex"), target(["baseline:rules"], [], "claude")],
    );
    const result = reconcileEccRegistrationLedger(input, {
      projectStatus: () => "live",
      droppedTargets: ["codex"],
    });
    expect(result.ledger.targets.map(({ target }) => target)).toEqual(["claude"]);
  });

  it("discovers only closed, deterministic state candidates for registered targets", () => {
    const input = ledger(
      [project(reactRoot, ["baseline:rules"])],
      [
        target(["baseline:rules"], [], "codex"),
        target(["baseline:rules"], [], "claude"),
        target(["baseline:rules"], [], "cursor"),
        target(["baseline:rules"], [], "opencode"),
      ],
    );
    const reconciliation = reconcileEccRegistrationLedger(input, { projectStatus: () => "live" });

    expect(eccInstallStateCandidates(home, reconciliation)).toEqual([
      {
        target: "claude",
        scope: "home",
        root: join(home, ".claude"),
        statePath: join(home, ".claude", "ecc", "install-state.json"),
      },
      {
        target: "codex",
        scope: "home",
        root: join(home, ".codex"),
        statePath: join(home, ".codex", "ecc-install-state.json"),
      },
      {
        target: "cursor",
        scope: "project",
        projectRoot: resolve(reactRoot),
        root: join(resolve(reactRoot), ".cursor"),
        statePath: join(resolve(reactRoot), ".cursor", "ecc-install-state.json"),
      },
      {
        target: "opencode",
        scope: "home",
        root: join(home, ".opencode"),
        statePath: join(home, ".opencode", "ecc-install-state.json"),
      },
    ]);
  });

  it("fails closed for symlinked or non-directory registered roots", () => {
    const outside = join(home, "outside");
    mkdirSync(outside);
    const linked = join(home, "linked");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => reconcileEccRegistrationLedger(ledger([project(linked, ["baseline:rules"])]))).toThrow(
      /symlink/i,
    );

    const file = join(home, "not-a-directory");
    writeFileSync(file, "not a project\n", "utf8");
    expect(() => reconcileEccRegistrationLedger(ledger([project(file, ["baseline:rules"])]))).toThrow(
      /directory/i,
    );
  });
});
