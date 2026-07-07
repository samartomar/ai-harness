import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceBuildCommand } from "../../src/evidence/build.js";
import { EvidenceBundleSchema } from "../../src/evidence/manifest.js";
import { command as initCommand } from "../../src/init/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { jsonFile } from "../../src/internals/render.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  defaultSidecarPath,
  SIDECAR_POINTER_FILE,
  truthPackCommand,
  truthVerifyCommand,
} from "../../src/truth/index.js";

let dir: string;
const HEAD = "a".repeat(40);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-truth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(defaultSidecarPath(dir), { recursive: true, force: true });
});

function runWithHead(head = HEAD) {
  return fakeRunner((argv) =>
    argv[0] === "git" && argv.includes("rev-parse") ? { stdout: `${head}\n` } : undefined,
  );
}

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? runWithHead();
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

function write(rel: string, contents: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function seedRepo(version = "1.2.3"): void {
  write("package.json", JSON.stringify({ name: "svc", version }, null, 2));
  write(
    "docs/CONTROL_MATRIX.md",
    [
      "# Control Matrix",
      "",
      "| ID | Public claim | Implementation seam | Regression proof |",
      "| --- | --- | --- | --- |",
      "| CM-01 | Managed changes are dry-run first. | `src/internals/execute.ts` | `tests/truth/truth.test.ts` (`truth verify fails closed on sidecar drift`) |",
    ].join("\n"),
  );
}

function seedSidecar(
  state: {
    boundToCommit?: string;
    packageVersion?: string;
    claims?: string[];
    decisions?: Array<{ id: string; supersededBy?: string }>;
    promotionRequiresApply?: boolean;
    sidecarPath?: string;
    stagingDir?: string;
  } = {},
): string {
  seedRepo();
  const sidecar = state.sidecarPath ?? defaultSidecarPath(dir);
  mkdirSync(join(sidecar, "truth", "staging"), { recursive: true });
  write(
    SIDECAR_POINTER_FILE,
    JSON.stringify(
      {
        schemaVersion: 1,
        path: sidecar,
        binding: { boundToCommit: state.boundToCommit ?? HEAD },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(sidecar, "truth", "state.json"),
    jsonFile({
      schemaVersion: 1,
      binding: { boundToCommit: state.boundToCommit ?? HEAD },
      assertions: {
        packageVersion: state.packageVersion ?? "1.2.3",
        claims: state.claims ?? ["CM-01"],
        decisions: state.decisions ?? [{ id: "decision.current" }],
      },
      staging: {
        dir: state.stagingDir ?? "truth/staging",
        promotionRequiresApply: state.promotionRequiresApply ?? true,
      },
    }),
  );
  return sidecar;
}

function writesOf(actions: Awaited<ReturnType<typeof truthPackCommand.plan>>["actions"]) {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}

describe("truth sidecar Phase A", () => {
  it("init --sidecar plans an external sidecar and commit binding", async () => {
    seedRepo();
    const c = ctx({ apply: true, options: { sidecar: true } });
    const plan = await initCommand.plan(c);
    const sidecar = defaultSidecarPath(dir);

    expect(writesOf(plan.actions).map((write) => write.path.replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining([
        SIDECAR_POINTER_FILE,
        join(sidecar, "truth", "state.json").replace(/\\/g, "/"),
        join(sidecar, "truth", "staging", ".gitkeep").replace(/\\/g, "/"),
        "AGENTS.md",
      ]),
    );

    await executePlan(plan, c);

    const pointer = JSON.parse(readFileSync(join(dir, SIDECAR_POINTER_FILE), "utf8")) as {
      path: string;
      binding: { boundToCommit: string };
    };
    const state = JSON.parse(readFileSync(join(sidecar, "truth", "state.json"), "utf8")) as {
      binding: { boundToCommit: string };
      staging: { promotionRequiresApply: boolean };
    };

    expect(pointer.path).toBe(sidecar);
    expect(pointer.binding.boundToCommit).toBe(HEAD);
    expect(state.binding.boundToCommit).toBe(HEAD);
    expect(state.staging.promotionRequiresApply).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("AI-managed");
  });

  it("init --sidecar fails closed when git HEAD cannot be bound", async () => {
    seedRepo();
    const c = ctx({
      options: { sidecar: true },
      run: fakeRunner((argv) =>
        argv[0] === "git" && argv.includes("rev-parse") ? { code: 1, stderr: "fatal" } : undefined,
      ),
    });

    await expect(initCommand.plan(c)).rejects.toThrow(/code-commit binding/);
  });

  it("init --sidecar rejects a sidecar path inside the repo", async () => {
    seedRepo();
    const c = ctx({ options: { sidecar: true, sidecarPath: "truth-sidecar" } });

    await expect(initCommand.plan(c)).rejects.toThrow(/outside the repository root/);
  });

  it("init --sidecar rejects an external link that resolves inside the repo", async () => {
    seedRepo();
    const target = join(dir, "linked-sidecar");
    const link = `${dir}-sidecar-link`;
    mkdirSync(target, { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const c = ctx({ options: { sidecar: true, sidecarPath: link } });

      await expect(initCommand.plan(c)).rejects.toThrow(/outside the repository root/);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it("truth pack writes Markdown and JSON under the token budget", async () => {
    const sidecar = seedSidecar();
    const c = ctx({ apply: true, options: { tokenBudget: "96" } });
    const plan = await truthPackCommand.plan(c);
    const writes = writesOf(plan.actions);

    expect(writes.map((write) => write.path.replace(/\\/g, "/"))).toEqual([
      join(sidecar, "truth", "staging", "pack.md").replace(/\\/g, "/"),
      join(sidecar, "truth", "staging", "pack.json").replace(/\\/g, "/"),
    ]);

    await executePlan(plan, c);
    const pack = JSON.parse(
      readFileSync(join(sidecar, "truth", "staging", "pack.json"), "utf8"),
    ) as {
      tokenBudget: number;
      tokenEstimate: number;
      facts: { boundToCommit: string; packageVersion: string };
    };

    expect(pack.tokenBudget).toBe(96);
    expect(pack.tokenEstimate).toBeLessThanOrEqual(96);
    expect(pack.facts.boundToCommit).toBe(HEAD);
    expect(pack.facts.packageVersion).toBe("1.2.3");
    expect(readFileSync(join(sidecar, "truth", "staging", "pack.md"), "utf8")).toContain(
      "# AIH Truth Pack",
    );
  });

  it("truth pack keeps non-ASCII truncated Markdown under the token budget", async () => {
    const sidecar = seedSidecar({
      sidecarPath: join(defaultSidecarPath(dir), `truth-${"é".repeat(80)}`),
    });
    const c = ctx({ apply: true, verify: true, options: { tokenBudget: "64" } });
    await executePlan(await truthPackCommand.plan(c), c);

    const pack = JSON.parse(
      readFileSync(join(sidecar, "truth", "staging", "pack.json"), "utf8"),
    ) as {
      tokenBudget: number;
      tokenEstimate: number;
    };

    expect(pack.tokenBudget).toBe(64);
    expect(pack.tokenEstimate).toBeLessThanOrEqual(64);
  });

  it("truth pack refuses to stage when sidecar drift is detected", async () => {
    const sidecar = seedSidecar({ boundToCommit: "b".repeat(40) });
    const c = ctx({ apply: true, verify: true, options: { tokenBudget: "96" } });
    const plan = await truthPackCommand.plan(c);

    expect(writesOf(plan.actions)).toHaveLength(0);

    const result = await executePlan(plan, c);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.bound-commit-drift");
    expect(existsSync(join(sidecar, "truth", "staging", "pack.json"))).toBe(false);
  });

  it("truth pack refuses an explicit sidecar path inside the repo", async () => {
    seedRepo();
    const sidecar = join(dir, "truth-sidecar");
    mkdirSync(join(sidecar, "truth", "staging"), { recursive: true });
    writeFileSync(
      join(sidecar, "truth", "state.json"),
      jsonFile({
        schemaVersion: 1,
        binding: { boundToCommit: HEAD },
        assertions: {
          packageVersion: "1.2.3",
          claims: ["CM-01"],
          decisions: [{ id: "decision.current" }],
        },
        staging: { dir: "truth/staging", promotionRequiresApply: true },
      }),
    );

    const c = ctx({ apply: true, verify: true, options: { sidecarPath: sidecar } });
    const plan = await truthPackCommand.plan(c);
    const result = await executePlan(plan, c);

    expect(writesOf(plan.actions)).toHaveLength(0);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.sidecar-missing");
    expect(existsSync(join(sidecar, "truth", "staging", "pack.json"))).toBe(false);
  });

  it("truth pack can target an explicit sidecar path", async () => {
    const sidecar = seedSidecar();
    rmSync(join(dir, SIDECAR_POINTER_FILE));

    const c = ctx({ apply: true, options: { sidecarPath: sidecar, tokenBudget: "96" } });
    await executePlan(await truthPackCommand.plan(c), c);

    expect(existsSync(join(sidecar, "truth", "staging", "pack.json"))).toBe(true);
  });

  it("truth verify --sidecar-path uses the explicit sidecar binding", async () => {
    const sidecar = seedSidecar();
    write(
      SIDECAR_POINTER_FILE,
      JSON.stringify(
        {
          schemaVersion: 1,
          path: sidecar,
          binding: { boundToCommit: "b".repeat(40) },
        },
        null,
        2,
      ),
    );

    const c = ctx({ verify: true, options: { sidecarPath: sidecar } });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
  });

  it("truth verify fails closed on sidecar drift", async () => {
    seedSidecar({
      boundToCommit: "b".repeat(40),
      packageVersion: "9.9.9",
      claims: ["CM-01", "CM-99"],
      decisions: [{ id: "decision.old", supersededBy: "decision.missing" }],
    });

    const c = ctx({ verify: true });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);
    const codes = result.report?.checks.map((check) => check.code);

    expect(result.report?.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        "truth.bound-commit-drift",
        "truth.version-drift",
        "truth.claim-matrix-row-missing",
        "truth.decision-supersession-missing",
      ]),
    );
  });

  it("truth verify fails closed when sidecar promotion is not apply-gated", async () => {
    seedSidecar({ promotionRequiresApply: false });

    const c = ctx({ verify: true });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);

    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.sidecar-missing");
  });

  it("truth verify fails closed on malformed sidecar assertions", async () => {
    const sidecar = seedSidecar();
    writeFileSync(
      join(sidecar, "truth", "state.json"),
      jsonFile({
        schemaVersion: 1,
        binding: { boundToCommit: HEAD },
        assertions: { packageVersion: "1.2.3" },
        staging: { dir: "truth/staging", promotionRequiresApply: true },
      }),
    );

    const c = ctx({ verify: true });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);

    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.sidecar-missing");
  });

  it("truth verify fails closed on unsafe sidecar decision IDs", async () => {
    seedSidecar({ decisions: [{ id: "API_KEY=should-not-ship" }] });

    const c = ctx({ verify: true });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);

    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.sidecar-missing");
  });

  it("truth verify fails closed on unsafe sidecar staging directories", async () => {
    seedSidecar({ stagingDir: "API_KEY=should-not-ship" });

    const c = ctx({ verify: true });
    const result = await executePlan(await truthVerifyCommand.plan(c), c);

    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.sidecar-missing");
  });

  it("evidence build indexes a verified truth pack", async () => {
    const sidecar = seedSidecar();
    const packCtx = ctx({ apply: true, verify: true, options: { tokenBudget: "96" } });
    await executePlan(await truthPackCommand.plan(packCtx), packCtx);
    const packPath = join(sidecar, "truth", "staging", "pack.json");
    writeFileSync(
      packPath,
      jsonFile({
        ...(JSON.parse(readFileSync(packPath, "utf8")) as Record<string, unknown>),
        secret: "API_KEY=should-not-ship",
      }),
    );

    const plan = await evidenceBuildCommand.plan(ctx());
    for (const action of plan.actions) {
      if (action.kind !== "write") continue;
      const target = join(dir, action.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, action.contents ?? jsonFile(action.json));
    }

    const index = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(dir, ".aih", "evidence-bundle", "evidence.json"), "utf8")),
    );
    expect(index.artifacts).toContainEqual(
      expect.objectContaining({ kind: "truth-pack", path: ".aih/truth-pack.json" }),
    );
    expect(
      existsSync(join(dir, ".aih", "evidence-bundle", "files", ".aih", "truth-pack.json")),
    ).toBe(true);
    const bundled = readFileSync(
      join(dir, ".aih", "evidence-bundle", "files", ".aih", "truth-pack.json"),
      "utf8",
    );
    expect(bundled).not.toContain("API_KEY");
    expect(JSON.parse(bundled)).not.toHaveProperty("secret");
  });

  it("evidence build fails closed on an unverified truth pack", async () => {
    const sidecar = seedSidecar({ boundToCommit: "b".repeat(40) });
    writeFileSync(
      join(sidecar, "truth", "staging", "pack.json"),
      jsonFile({
        schemaVersion: 1,
        kind: "aih.truth.pack",
        tokenBudget: 96,
        tokenEstimate: 12,
        facts: {
          boundToCommit: "b".repeat(40),
          head: "b".repeat(40),
          packageVersion: "1.2.3",
          controlMatrixClaims: ["CM-01"],
          decisionIds: ["decision.current"],
          stagingDir: "truth/staging",
        },
      }),
    );

    const c = ctx({ verify: true });
    const plan = await evidenceBuildCommand.plan(c);
    const result = await executePlan(plan, c);

    expect(writesOf(plan.actions)).toHaveLength(0);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.bound-commit-drift");
  });

  it("evidence build fails closed on over-budget truth pack metadata", async () => {
    const sidecar = seedSidecar();
    const packCtx = ctx({ apply: true, verify: true, options: { tokenBudget: "96" } });
    await executePlan(await truthPackCommand.plan(packCtx), packCtx);
    const packPath = join(sidecar, "truth", "staging", "pack.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
      tokenBudget: number;
      tokenEstimate: number;
    };
    writeFileSync(packPath, jsonFile({ ...pack, tokenEstimate: pack.tokenBudget + 1 }));

    const c = ctx({ verify: true });
    const plan = await evidenceBuildCommand.plan(c);
    const result = await executePlan(plan, c);

    expect(writesOf(plan.actions)).toHaveLength(0);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.checks.map((check) => check.code)).toContain("truth.pack-invalid");
  });
});
