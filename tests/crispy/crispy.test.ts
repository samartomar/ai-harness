import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/crispy/index.js";
import { STAGES } from "../../src/crispy/stages.js";
import { INSTALL_COMMANDS, MAX_BULLETS } from "../../src/crispy/templates.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
const run = fakeRunner(() => undefined);
const host = makeHostAdapter({ platform: "linux", run, env: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-crispy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(
  options: Record<string, unknown>,
  contextDir = ".ai-context",
  apply = false,
): PlanContext {
  return {
    root: dir,
    contextDir,
    apply,
    verify: false,
    json: false,
    run,
    host,
    env: {},
    options,
  };
}

/** Seed a stage artifact on disk so a later stage's gate is satisfied. */
function seedArtifact(contextDir: string, file: string, body = "seed"): void {
  const abs = join(dir, contextDir, "crispy", file);
  mkdirSync(join(dir, contextDir, "crispy"), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

const writes = (actions: Action[]): WriteAction[] =>
  actions.filter((a): a is WriteAction => a.kind === "write");
const findWrite = (actions: Action[], suffix: string): WriteAction | undefined =>
  writes(actions).find((w) => w.path.endsWith(suffix));

describe("crispy stages", () => {
  it("declares exactly the 7 ordered CRISPY stages", () => {
    expect(STAGES).toHaveLength(7);
    expect(STAGES.map((s) => s.name)).toEqual([
      "context",
      "research",
      "iterate",
      "structure",
      "plan",
      "synthesize",
      "implement",
    ]);
  });

  it("numbers each artifact by its position (1-context.md … 7-implement.md)", () => {
    STAGES.forEach((s, i) => {
      expect(s.artifact).toBe(`${i + 1}-${s.name}.md`);
    });
  });
});

describe("crispy --init", () => {
  it("scaffolds the workspace with README and an empty STATE tracker", async () => {
    const p = await command.plan(makeCtx({ init: true }));
    const readme = findWrite(p.actions, ".ai-context/crispy/README.md");
    const state = findWrite(p.actions, ".ai-context/crispy/STATE.md");
    expect(readme).toBeDefined();
    expect(state).toBeDefined();
    // Fresh init: every stage box is unchecked.
    expect(state?.contents).toContain("- [ ] 1. context");
    expect(state?.contents).not.toContain("- [x]");
  });

  it("explains CRISPY in the README and lists all stages", async () => {
    const p = await command.plan(makeCtx({ init: true }));
    const readme = findWrite(p.actions, "README.md");
    expect(readme?.contents).toContain("# CRISPY workspace");
    for (const s of STAGES) {
      expect(readme?.contents).toContain(`\`${s.artifact}\``);
    }
  });

  it("reflects already-present artifacts as checked in STATE", async () => {
    seedArtifact(".ai-context", "1-context.md");
    const p = await command.plan(makeCtx({ init: true }));
    const state = findWrite(p.actions, "STATE.md");
    expect(state?.contents).toContain("- [x] 1. context");
    expect(state?.contents).toContain("- [ ] 2. research");
  });
});

describe("crispy stage gate", () => {
  it("blocks research with no context artifact: a gate doc and NO write", async () => {
    const p = await command.plan(makeCtx({ stage: "research" }));
    expect(writes(p.actions)).toHaveLength(0);
    const gate = p.actions.find((a) => a.kind === "doc");
    expect(gate?.kind).toBe("doc");
    expect((gate as { describe: string }).describe).toContain("complete `context`");
    if (gate?.kind === "doc") {
      expect(gate.text).toContain("complete `context` first");
    }
  });

  it("writes the research artifact once the context artifact exists", async () => {
    seedArtifact(".ai-context", "1-context.md");
    const p = await command.plan(makeCtx({ stage: "research" }));
    const artifact = findWrite(p.actions, "2-research.md");
    expect(artifact).toBeDefined();
    expect(artifact?.contents).toContain("# CRISPY — research");
    // STATE is refreshed and marks research done.
    const state = findWrite(p.actions, "STATE.md");
    expect(state?.contents).toContain("- [x] 2. research");
  });

  it("allows the first stage (context) with no prior artifact", async () => {
    const p = await command.plan(makeCtx({ stage: "context" }));
    expect(findWrite(p.actions, "1-context.md")).toBeDefined();
  });

  it("blocks a mid-chain stage when an intermediate artifact is missing", async () => {
    // Seed only context+research, then jump to structure (needs iterate).
    seedArtifact(".ai-context", "1-context.md");
    seedArtifact(".ai-context", "2-research.md");
    const p = await command.plan(makeCtx({ stage: "structure" }));
    expect(writes(p.actions)).toHaveLength(0);
    const gate = p.actions.find((a) => a.kind === "doc");
    expect((gate as { describe: string }).describe).toContain("complete `iterate`");
  });
});

describe("crispy stage selection edges", () => {
  it("emits a stage-list doc (no write) when --stage is unknown", async () => {
    const p = await command.plan(makeCtx({ stage: "bogus" }));
    expect(writes(p.actions)).toHaveLength(0);
    const d = p.actions.find((a) => a.kind === "doc");
    if (d?.kind === "doc") {
      for (const s of STAGES) expect(d.text).toContain(s.name);
    }
  });

  it("emits a stage-list doc (no write) when --stage is absent", async () => {
    const p = await command.plan(makeCtx({}));
    expect(writes(p.actions)).toHaveLength(0);
    expect(p.actions.some((a) => a.kind === "doc")).toBe(true);
  });
});

describe("crispy template authoring rule", () => {
  it("keeps every stage template under 40 instruction bullets", async () => {
    // Seed every artifact so each stage is allowed to write, then assert the
    // embedded bullet count per the blueprint's Under-40 rule.
    for (const s of STAGES) seedArtifact(".ai-context", s.artifact);
    for (const s of STAGES) {
      const p = await command.plan(makeCtx({ stage: s.name }));
      const artifact = findWrite(p.actions, s.artifact);
      const bulletLines = (artifact?.contents ?? "").split("\n").filter((l) => l.startsWith("- "));
      expect(bulletLines.length).toBeGreaterThan(0);
      expect(bulletLines.length).toBeLessThan(MAX_BULLETS);
    }
  });
});

describe("crispy boundary", () => {
  it("emits the Superpowers/ECC install commands as a doc, never exec/write", async () => {
    const p = await command.plan(makeCtx({ stage: "context" }));
    const docs = p.actions.filter((a) => a.kind === "doc");
    const installDoc = docs.find(
      (d) => d.kind === "doc" && d.text.includes("superpowers-marketplace"),
    );
    expect(installDoc).toBeDefined();
    if (installDoc?.kind === "doc") {
      for (const cmd of INSTALL_COMMANDS) expect(installDoc.text).toContain(cmd);
    }
    // The commands appear ONLY as doc text — no exec action runs them.
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("never writes outside the crispy workspace and emits no probes", async () => {
    const p = await command.plan(makeCtx({ stage: "context" }));
    for (const w of writes(p.actions)) {
      expect(w.path.startsWith(".ai-context/crispy/")).toBe(true);
    }
    expect(p.actions.some((a) => a.kind === "probe")).toBe(false);
  });
});

describe("crispy custom context dir", () => {
  it("honors a custom contextDir for gate checks and write paths", async () => {
    seedArtifact("docs/ctx", "1-context.md");
    const p = await command.plan(makeCtx({ stage: "research" }, "docs/ctx"));
    expect(findWrite(p.actions, "docs/ctx/crispy/2-research.md")).toBeDefined();
  });
});

describe("crispy determinism", () => {
  it("produces byte-identical output across repeated planning", async () => {
    seedArtifact(".ai-context", "1-context.md");
    const a = await command.plan(makeCtx({ stage: "research" }));
    const b = await command.plan(makeCtx({ stage: "research" }));
    expect(findWrite(a.actions, "2-research.md")?.contents).toBe(
      findWrite(b.actions, "2-research.md")?.contents,
    );
  });

  it("STATE marking is idempotent when re-advancing a completed stage", async () => {
    seedArtifact(".ai-context", "1-context.md");
    seedArtifact(".ai-context", "2-research.md");
    const p = await command.plan(makeCtx({ stage: "research" }));
    const state = findWrite(p.actions, "STATE.md");
    // research already on disk → still exactly one checked research line.
    const checked = (state?.contents ?? "")
      .split("\n")
      .filter((l) => l.includes("research") && l.includes("[x]"));
    expect(checked).toHaveLength(1);
  });
});

describe("crispy artifact contents", () => {
  it("seeds the implement artifact with the ship/skip/unverified discipline", async () => {
    for (const s of STAGES) seedArtifact(".ai-context", s.artifact);
    const p = await command.plan(makeCtx({ stage: "implement" }));
    const artifact = findWrite(p.actions, "7-implement.md");
    expect(artifact?.contents).toContain("ship-list");
    expect(artifact?.contents).toContain("Working notes");
  });
});

describe("crispy --json (executor result shape)", () => {
  it("dry-run reports two writes + one doc and applies nothing for an open stage", async () => {
    seedArtifact(".ai-context", "1-context.md");
    const ctx = makeCtx({ stage: "research" });
    const result = await executePlan(await command.plan(ctx), ctx);
    expect(result.capability).toBe("crispy");
    expect(result.applied).toBe(false);
    expect(result.writes.map((w) => w.path)).toEqual([
      ".ai-context/crispy/2-research.md",
      ".ai-context/crispy/STATE.md",
    ]);
    // Dry-run: the artifact does not exist yet, so the write is a "create".
    expect(result.writes[0]?.effect).toBe("create");
    expect(result.docs).toHaveLength(1);
    expect(result.execs).toHaveLength(0);
    expect(result.backups).toHaveLength(0);
  });

  it("dry-run reports zero writes and a single gate doc for a gated stage", async () => {
    const ctx = makeCtx({ stage: "research" });
    const result = await executePlan(await command.plan(ctx), ctx);
    expect(result.writes).toHaveLength(0);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]?.describe).toContain("complete `context`");
  });
});

describe("crispy apply path (real fs transactions)", () => {
  it("applying `context` writes the artifact that unblocks `research` with no manual seeding", async () => {
    // Apply the first stage for real, then prove its artifact satisfies the next
    // stage's gate — the stage machine's core promise, end-to-end on disk.
    const ctxA = makeCtx({ stage: "context" }, ".ai-context", true);
    const applied = await executePlan(await command.plan(ctxA), ctxA);
    expect(applied.applied).toBe(true);
    expect(existsSync(join(dir, ".ai-context", "crispy", "1-context.md"))).toBe(true);

    // research now plans a write (gate satisfied by the on-disk context artifact).
    const ctxB = makeCtx({ stage: "research" });
    const next = await command.plan(ctxB);
    expect(findWrite(next.actions, "2-research.md")).toBeDefined();
    expect(
      next.actions.some((a) => a.kind === "doc" && a.text.includes("complete `context`")),
    ).toBe(false);
  });

  it("re-applying a completed stage is idempotent: identical bytes, an overwrite effect", async () => {
    const artifactAbs = join(dir, ".ai-context", "crispy", "1-context.md");
    const ctx = makeCtx({ stage: "context" }, ".ai-context", true);

    await executePlan(await command.plan(ctx), ctx);
    const firstBytes = readFileSync(artifactAbs, "utf8");

    const second = await executePlan(await command.plan(ctx), ctx);
    const secondBytes = readFileSync(artifactAbs, "utf8");

    expect(secondBytes).toBe(firstBytes);
    // The artifact already existed on the second apply, so it is an overwrite.
    const artifactWrite = second.writes.find((w) => w.path.endsWith("1-context.md"));
    expect(artifactWrite?.effect).toBe("overwrite");
  });
});
