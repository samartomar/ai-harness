import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractTruthCheck } from "../../src/contract/check.js";
import { command, portablePathsCheck } from "../../src/contract/index.js";
import type { ProjectContract } from "../../src/contract/schema.js";
import { ProjectContractSchema, readProjectContract } from "../../src/contract/schema.js";
import { synthesizeContract, unportablePaths } from "../../src/contract/synth.js";
import { setupDoc } from "../../src/contract/templates.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner, missingToolRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { scanRepo } from "../../src/profile/scan.js";
import {
  fakeTrackedPaths,
  gitTrackedRunner,
  seedAngularLike,
  seedForeignCanon,
  seedImportableCli,
  seedLegacyScripts,
  seedMindworksLike,
  seedMonorepoSmall,
  seedNodeNoBuildStart,
  seedNoPackageJson,
} from "./fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-contract-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
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

const CONTRACT_PATH = "ai-coding/project.json";

function writePaths(actions: Action[]): string[] {
  return actions
    .filter((a): a is WriteAction => a.kind === "write")
    .map((a) => a.path.replace(/\\/g, "/"));
}

function writesByPath(actions: Action[]): Map<string, WriteAction> {
  const m = new Map<string, WriteAction>();
  for (const a of actions) {
    if (a.kind === "write") m.set(a.path.replace(/\\/g, "/"), a);
  }
  return m;
}

/** Synthesize a contract for the current `dir`, with an optional ctx override. */
function synth(over: Partial<PlanContext> = {}): Promise<ProjectContract> {
  const c = ctx(over);
  return synthesizeContract(c, scanRepo(c.root, { maxDepth: 8, contextDir: c.contextDir }));
}

describe("contract command surface", () => {
  it("registers as `contract` with no extra options", () => {
    expect(command.name).toBe("contract");
    expect(command.options).toEqual([]);
  });
});

describe("contract plan (dry-run shape)", () => {
  it("emits the project.json write + the portable-paths probe — no exec, no doc", async () => {
    seedMindworksLike(dir);
    const p = await command.plan(ctx());
    const kinds = p.actions.map((a) => a.kind);
    expect(kinds).toContain("write");
    expect(kinds).toContain("probe");
    expect(kinds).not.toContain("exec");
    expect(kinds).not.toContain("doc");
    expect(writePaths(p.actions)).toContain(CONTRACT_PATH);
  });

  it("writes exactly one project.json (one-writer-per-file), schema-valid, merge:true", async () => {
    seedMindworksLike(dir);
    const actions = (await command.plan(ctx())).actions;
    expect(writePaths(actions).filter((p) => p === CONTRACT_PATH)).toHaveLength(1);
    const w = writesByPath(actions).get(CONTRACT_PATH);
    expect(w?.merge).toBe(true);
    expect(() => ProjectContractSchema.parse(w?.json)).not.toThrow();
  });

  it("is deterministic: two plans render byte-identical project.json", async () => {
    seedMindworksLike(dir);
    const a = writesByPath((await command.plan(ctx())).actions).get(CONTRACT_PATH);
    const b = writesByPath((await command.plan(ctx())).actions).get(CONTRACT_PATH);
    const abs = join(dir, "ai-coding", "project.json");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a && b) expect(resolveContents(a, abs)).toBe(resolveContents(b, abs));
  });
});

describe("PR 1B — project.md + setup.md", () => {
  const FILES = ["ai-coding/project.json", "ai-coding/project.md", "ai-coding/setup.md"];

  it("emits exactly the three contract files", async () => {
    seedMindworksLike(dir);
    expect(writePaths((await command.plan(ctx())).actions).sort()).toEqual([...FILES].sort());
  });

  it("project.md mirrors project.json facts and defers working agreements to the canon", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    const md = (
      writesByPath((await command.plan(ctx())).actions).get("ai-coding/project.md")?.contents ?? ""
    ).replace(/\r\n/g, "\n");
    expect(c.commands.test).toBeDefined();
    if (c.commands.test) expect(md).toContain(c.commands.test.value); // prose === JSON value
    expect(md).toContain("## Stack");
    expect(md).toContain("## Commands");
    expect(md).toContain("agent canon"); // facts only — points at the canon, never carries it
    expect(md).not.toContain("Conventional commits"); // no working-agreement prose folded in
  });

  it("setup.md is write-once; project.md regenerates", async () => {
    seedMindworksLike(dir);
    const w = writesByPath((await command.plan(ctx())).actions);
    expect(w.get("ai-coding/setup.md")?.once).toBe(true);
    expect(w.get("ai-coding/project.md")?.once).toBeUndefined();

    const a1 = ctx({ apply: true });
    await executePlan(await command.plan(a1), a1);
    const a2 = ctx({ apply: true });
    const r2 = await executePlan(await command.plan(a2), a2);
    const effect = (p: string): string | undefined =>
      r2.writes.find((x) => x.path.replace(/\\/g, "/") === p)?.effect;
    expect(effect("ai-coding/setup.md")).toBe("kept");
    expect(effect("ai-coding/project.md")).toBe("unchanged");
  });

  it("renders the inferred-command caveat only when a command is inferred", async () => {
    seedNoPackageJson(dir); // go test ./... is inferred
    const md =
      writesByPath((await command.plan(ctx())).actions).get("ai-coding/project.md")?.contents ?? "";
    expect(md).toContain("inferred");
    expect(md).toContain("confirm before relying on it");
  });

  it("renders safe install commands for Python package managers", async () => {
    seedMindworksLike(dir);
    const base = await synth();
    expect(setupDoc("ai-coding", { ...base, packageManager: "poetry" })).toContain(
      "`poetry install`",
    );
    expect(setupDoc("ai-coding", { ...base, packageManager: "uv" })).toContain("`uv sync`");
    expect(setupDoc("ai-coding", { ...base, packageManager: "pip" })).toContain(
      "`python -m pip install -r requirements.txt`",
    );
  });
});

describe("command confidence", () => {
  it("marks declared package.json scripts as detected", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    expect(c.commands.test).toEqual({ value: "npm test", confidence: "detected" });
    expect(c.commands.build).toEqual({ value: "npm run build", confidence: "detected" });
    expect(c.commands.lint).toEqual({ value: "npm run lint", confidence: "detected" });
    expect(c.commands.start).toEqual({ value: "npm start", confidence: "detected" });
  });

  it("keeps a language-default test as inferred but strict-omits a language-default build", async () => {
    seedNoPackageJson(dir);
    const c = await synth();
    // test: low-harm to suggest → language default kept as inferred.
    expect(c.commands.test).toEqual({ value: "go test ./...", confidence: "inferred" });
    // build: an undeclared `go build ./...` would read as invented → strict-omit.
    expect(c.commands.build).toBeUndefined();
    expect(c.commands.lint).toBeUndefined();
    expect(c.commands.start).toBeUndefined();
  });

  it("captures resolved CLI targets and the stack description", async () => {
    seedMindworksLike(dir);
    const c = await synth({ targets: ["claude", "codex"] as unknown as PlanContext["targets"] });
    expect(c.targets).toEqual(["claude", "codex"]);
    expect(c.description).toBe("A worked-example service");
    expect(c.languages).toContain("TypeScript/Node.js");
    expect(c.frameworks).toContain("Express");
  });
});

describe("build/start strict-omit (PR 1A correction)", () => {
  it("omits build and start when no such script is declared", async () => {
    seedNodeNoBuildStart(dir);
    const c = await synth();
    expect(c.commands.test).toEqual({ value: "npm test", confidence: "detected" });
    expect(c.commands.build).toBeUndefined(); // (a) no build script → omitted
    expect(c.commands.start).toBeUndefined(); // (b) no start script → omitted
  });

  it("emits declared build + start scripts as detected (never inferred)", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    expect(c.commands.build).toEqual({ value: "npm run build", confidence: "detected" }); // (c)
    expect(c.commands.start).toEqual({ value: "npm start", confidence: "detected" });
  });

  it("keeps entrypoints under `entrypoints`, never promoted to a command", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    // (d) entrypoints are a faithful passthrough of the scanned stack, independent of
    // the start grader — the strict-omit change must neither move nor drop them.
    const stack = scanRepo(dir, { maxDepth: 8, contextDir: "ai-coding" });
    expect(c.entrypoints).toEqual(stack.entryPoints);
  });
});

describe("scale classification", () => {
  it("buckets by tracked-file count from git ls-files", async () => {
    seedMindworksLike(dir);
    const small = await synth({ run: gitTrackedRunner(fakeTrackedPaths(50)) });
    expect(small.scale).toMatchObject({ trackedFiles: 50, class: "small", isMonorepo: false });
    expect((await synth({ run: gitTrackedRunner(fakeTrackedPaths(500)) })).scale.class).toBe(
      "medium",
    );
    expect((await synth({ run: gitTrackedRunner(fakeTrackedPaths(1500)) })).scale.class).toBe(
      "large",
    );
  });

  it("reports class `unknown` with no trackedFiles when git is absent", async () => {
    seedMindworksLike(dir);
    const c = await synth({ run: missingToolRunner });
    expect(c.scale.class).toBe("unknown");
    expect(c.scale.trackedFiles).toBeUndefined();
  });

  it("floors a low-file monorepo at `medium`", async () => {
    seedMonorepoSmall(dir);
    const c = await synth({ run: gitTrackedRunner(fakeTrackedPaths(10)) });
    expect(c.scale.isMonorepo).toBe(true);
    expect(c.scale.class).toBe("medium");
  });
});

describe("sensitive paths (value-blind)", () => {
  it("records secret-file PATHS only — never the values", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    expect(c.sensitivePaths).toContain(".env");
    expect(JSON.stringify(c)).not.toContain("do-not-read");
  });
});

describe("known gaps", () => {
  it("flags inferred commands as unconfirmed", async () => {
    seedNoPackageJson(dir);
    const gaps = (await synth()).knownGaps;
    expect(gaps.some((g) => g.includes("go test ./...") && g.includes("inferred"))).toBe(true);
  });

  it("flags a brownfield canon for reconcile", async () => {
    seedForeignCanon(dir);
    const gaps = (await synth()).knownGaps;
    expect(gaps.some((g) => g.includes("reconcile existing AI canon"))).toBe(true);
  });

  it("flags un-imported CLI rule sets", async () => {
    seedImportableCli(dir);
    const gaps = (await synth()).knownGaps;
    expect(gaps.some((g) => g.includes("un-imported CLI rule set"))).toBe(true);
  });

  it("flags legacy canon scripts to retire", async () => {
    seedLegacyScripts(dir);
    const gaps = (await synth()).knownGaps;
    expect(gaps.some((g) => g.includes("retire") && g.includes("regenerate-adapters"))).toBe(true);
  });

  it("flags committed Python virtualenv directories as non-source", async () => {
    mkdirSync(join(dir, ".venv", "lib", "python3.12", "site-packages"), { recursive: true });
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"svc\"\n");
    const gaps = (await synth()).knownGaps;
    expect(gaps.some((g) => g.includes(".venv") && g.includes("do not treat as source"))).toBe(
      true,
    );
  });
});

describe("browser-SPA detection (P4/P5)", () => {
  it("labels a browser SPA as TypeScript (not Node.js) and flags the browser-test trap", async () => {
    seedAngularLike(dir);
    const c = await synth();
    expect(c.languages).toContain("TypeScript");
    expect(c.languages).not.toContain("TypeScript/Node.js");
    expect(c.frameworks).toContain("Angular");
    // The headless agent-trap surfaces as a knownGap (renders in project.md + setup.md).
    expect(c.knownGaps.some((g) => g.includes("browser") && g.includes("headless"))).toBe(true);
  });

  it("keeps the Node.js label + no browser gap for a Node service", async () => {
    seedMindworksLike(dir); // Express, no karma
    const c = await synth();
    expect(c.languages).toContain("TypeScript/Node.js");
    expect(c.knownGaps.some((g) => g.includes("browser"))).toBe(false);
  });
});

describe("portable-paths invariant", () => {
  it("passes for a synthesized contract (all repo-relative POSIX)", async () => {
    seedMindworksLike(dir);
    const c = await synth();
    expect(unportablePaths(c)).toEqual([]);
    expect(portablePathsCheck(c, "vibe").verdict).toBe("pass");
  });

  it("fails on .. escapes, absolute, drive-letter, and UNC values", async () => {
    seedMindworksLike(dir);
    const base = await synth();
    for (const bad of ["../escape", "/abs/path", "C:\\win", "C:/win", "\\\\unc\\share", "a\\b"]) {
      const tampered: ProjectContract = { ...base, entrypoints: [bad] };
      expect(unportablePaths(tampered)).toContain(bad);
      expect(portablePathsCheck(tampered, "team").verdict).toBe("fail");
    }
  });

  it("keeps unportable paths warning-only at vibe posture", async () => {
    seedMindworksLike(dir);
    const tampered: ProjectContract = { ...(await synth()), entrypoints: ["../escape"] };
    const res = portablePathsCheck(tampered, "vibe");
    expect(res.verdict).toBe("pass");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("warning-only");
  });

  it("surfaces a failing probe when the context dir itself is non-portable", async () => {
    seedMindworksLike(dir);
    const c = ctx({ contextDir: "../sneaky", posture: "team" });
    const p = await command.plan(c);
    const probeAction = p.actions.find((a) => a.kind === "probe");
    expect(probeAction).toBeDefined();
    if (probeAction?.kind === "probe") {
      expect((await probeAction.run(c)).verdict).toBe("fail");
    }
  });
});

describe("apply + read round-trip", () => {
  it("creates project.json, then is idempotent on re-apply", async () => {
    seedMindworksLike(dir);
    const a1 = ctx({ apply: true });
    const r1 = await executePlan(await command.plan(a1), a1);
    expect(r1.writes.find((w) => w.path.replace(/\\/g, "/") === CONTRACT_PATH)?.effect).toBe(
      "create",
    );

    const a2 = ctx({ apply: true });
    const r2 = await executePlan(await command.plan(a2), a2);
    expect(r2.writes.find((w) => w.path.replace(/\\/g, "/") === CONTRACT_PATH)?.effect).toBe(
      "unchanged",
    );
  });

  it("round-trips through readProjectContract after apply", async () => {
    seedMindworksLike(dir);
    const applied = ctx({ apply: true });
    await executePlan(await command.plan(applied), applied);
    const read = readProjectContract(dir, "ai-coding");
    expect(read?.schemaVersion).toBe(1);
    expect(read?.commands.test?.value).toBe("npm test");
  });

  it("readProjectContract returns undefined when the contract is absent", () => {
    expect(readProjectContract(dir, "ai-coding")).toBeUndefined();
  });
});

describe("PR 1D — doctor contract-truth probe", () => {
  function writeContract(c: ProjectContract): void {
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "project.json"), `${JSON.stringify(c, null, 2)}\n`);
  }

  it("skips when no contract is committed", async () => {
    expect((await contractTruthCheck(ctx())).verdict).toBe("skip");
  });

  it("passes a clean committed contract", async () => {
    seedMindworksLike(dir);
    writeContract(await synth());
    expect((await contractTruthCheck(ctx())).verdict).toBe("pass");
  });

  it("fails when the committed contract drifts from the live repo facts", async () => {
    seedNodeNoBuildStart(dir);
    writeContract(await synth());
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run", build: "tsc -p ." },
        devDependencies: { typescript: "^5", vitest: "^1" },
      }),
    );

    const res = await contractTruthCheck(ctx({ posture: "team" }));
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("contract.stale");
    expect(res.detail).toContain("commands.build");
    expect(res.detail).toContain("re-run `aih contract");
  });

  it("fails when generated stack facts drift beyond commands", async () => {
    seedMindworksLike(dir);
    writeContract(await synth());
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "mindworks",
        description: "A worked-example service",
        scripts: {
          test: "vitest run",
          build: "tsc -p .",
          lint: "biome check .",
          start: "node dist/main.js",
        },
        dependencies: { "@aws-sdk/client-dynamodb": "^3", express: "^4", pg: "^8" },
        devDependencies: { typescript: "^5", vitest: "^1" },
      }),
    );
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    writeFileSync(join(dir, "Dockerfile"), "FROM node:20\n");

    const res = await contractTruthCheck(ctx({ posture: "team" }));
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("contract.stale");
    expect(res.detail).toContain("cloud");
    expect(res.detail).toContain("databases");
    expect(res.detail).toContain("deployment");
    expect(res.detail).toContain("packageManager");
  });

  it("keeps contract staleness warning-only at vibe posture", async () => {
    seedNodeNoBuildStart(dir);
    writeContract(await synth());
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run", build: "tsc -p ." },
        devDependencies: { typescript: "^5", vitest: "^1" },
      }),
    );

    const res = await contractTruthCheck(ctx({ posture: "vibe" }));
    expect(res.verdict).toBe("pass");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("warning-only");
  });

  it("ignores user-added project.json keys when checking staleness", async () => {
    seedMindworksLike(dir);
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    writeFileSync(
      join(dir, "ai-coding", "project.json"),
      `${JSON.stringify({ ...(await synth()), teamNotes: { owner: "platform" } }, null, 2)}\n`,
    );

    const res = await contractTruthCheck(ctx({ posture: "team" }));
    expect(res.verdict).toBe("pass");
    expect(res.code).toBeUndefined();
  });

  it("fails (routable) on a non-portable path in the committed contract", async () => {
    seedMindworksLike(dir);
    writeContract({ ...(await synth()), entrypoints: ["../escape"] });
    const res = await contractTruthCheck(ctx({ posture: "team" }));
    expect(res.verdict).toBe("fail");
    expect(res.code).toBe("contract.path-unportable");
    expect(res.detail).toContain("../escape");
  });

  it("warns without failing on a non-portable committed contract at vibe posture", async () => {
    seedMindworksLike(dir);
    writeContract({ ...(await synth()), entrypoints: ["../escape"] });
    const res = await contractTruthCheck(ctx({ posture: "vibe" }));
    expect(res.verdict).toBe("pass");
    expect(res.code).toBeUndefined();
    expect(res.detail).toContain("warning-only");
  });

  it("does not false-fail a large repo — defers deep validation to graph safety", async () => {
    seedNodeNoBuildStart(dir);
    const big = gitTrackedRunner(fakeTrackedPaths(1500));
    writeContract(await synth({ run: big }));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run", build: "tsc -p ." },
        devDependencies: { typescript: "^5", vitest: "^1" },
      }),
    );
    const res = await contractTruthCheck(ctx({ run: big }));
    expect(res.verdict).toBe("pass");
    expect(res.detail).toContain("deferred");
  });
});
