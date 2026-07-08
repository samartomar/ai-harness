import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsError } from "../../src/errors.js";
import { command } from "../../src/hardware/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, DocAction, Plan, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import type { Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aih-hw-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Host profile a fake runner reports. Drives the real adapter so the plan sees
 * deterministic CPU/RAM/GPU facts without spawning a process. `vramGb < 0` is the
 * "no GPU" signal (we make nvidia-smi spawn-error).
 */
interface HostFacts {
  cores: number;
  ramGb: number;
  vramGb: number;
  gpuName?: string;
}

/** A runner that answers the Windows adapter's CIM/nvidia-smi probes from facts. */
function winRunner(f: HostFacts): (argv: string[]) => Partial<RunResult> | undefined {
  return (argv) => {
    const s = argv.join(" ");
    if (s.includes("NumberOfCores")) return { stdout: `${f.cores}\n` };
    if (s.includes("Capacity")) return { stdout: `${f.ramGb}\n` };
    if (argv[0] === "nvidia-smi") {
      if (f.vramGb < 0) return { spawnError: true, code: 127 };
      return { stdout: `${f.vramGb * 1024}, ${f.gpuName ?? "NVIDIA Test GPU"}\n` };
    }
    return undefined;
  };
}

interface CtxOverrides {
  platform?: Platform;
  facts?: HostFacts;
  root?: string;
  contextDir?: string;
  apply?: boolean;
  verify?: boolean;
  env?: NodeJS.ProcessEnv;
  options?: Record<string, unknown>;
}

const DEFAULT_FACTS: HostFacts = { cores: 8, ramGb: 32, vramGb: 12 };

function makeCtx(over: CtxOverrides = {}): PlanContext {
  const facts = over.facts ?? DEFAULT_FACTS;
  const platform = over.platform ?? "windows";
  const env = over.env ?? { USERNAME: "samar", USERPROFILE: "C:\\Users\\samar" };
  const run = fakeRunner(winRunner(facts));
  const host = makeHostAdapter({ platform, run, env });
  return {
    root: over.root ?? makeTmp(),
    contextDir: over.contextDir ?? ".ai-context",
    apply: over.apply ?? false,
    verify: over.verify ?? false,
    json: false,
    run,
    host,
    env,
    options: over.options ?? {},
  };
}

function byKind<K extends Action["kind"]>(plan: Plan, kind: K): Extract<Action, { kind: K }>[] {
  return plan.actions.filter((a): a is Extract<Action, { kind: K }> => a.kind === kind);
}

/** Env whose Windows/posix profile path lands inside a throwaway temp dir. */
function winTmpEnv(): NodeJS.ProcessEnv {
  return { USERNAME: "samar", USERPROFILE: makeTmp() };
}
function linuxTmpEnv(): NodeJS.ProcessEnv {
  return { HOME: makeTmp() };
}

/**
 * The profile env block is emitted as an `envblock` action; the executor renders
 * + folds it into the file. Apply the plan against a temp profile and return the
 * rendered profile contents so format/marker/idempotency assertions can inspect
 * the real output. `ctx` must be built with a temp-home env (winTmpEnv/linuxTmpEnv).
 */
async function renderProfile(ctx: PlanContext): Promise<string> {
  const profile = ctx.host.shellProfilePaths()[0] as string;
  mkdirSync(dirname(profile), { recursive: true });
  const applyCtx: PlanContext = { ...ctx, apply: true };
  await executePlan(await command.plan(applyCtx), applyCtx);
  return readFileSync(profile, "utf8");
}

describe("hardware command surface", () => {
  it("keeps the stub's name, summary, and options", () => {
    expect(command.name).toBe("hardware");
    expect(command.summary).toMatch(/Ollama/);
    const flags = command.options?.map((o) => o.flags) ?? [];
    expect(flags).toContain("--model-size-gb <n>");
    expect(flags).toContain("--engine <engine>");
  });
});

describe("plan shape", () => {
  it("emits exactly one envblock, one doc, and one probe", async () => {
    const p = await command.plan(makeCtx());
    expect(byKind(p, "envblock")).toHaveLength(1);
    expect(byKind(p, "write")).toHaveLength(0);
    expect(byKind(p, "doc")).toHaveLength(1);
    expect(byKind(p, "probe")).toHaveLength(1);
    expect(byKind(p, "exec")).toHaveLength(0);
  });

  it("targets the shell profile (absolute adapter path), not a repo-relative file", async () => {
    const env = { USERNAME: "samar", USERPROFILE: "C:\\Users\\samar" };
    const p = await command.plan(makeCtx({ env }));
    const eb = byKind(p, "envblock")[0];
    const profile = makeHostAdapter({
      platform: "windows",
      run: fakeRunner(() => undefined),
      env,
    }).shellProfilePaths()[0];
    expect(eb?.path).toBe(profile);
    expect(eb?.scope).toBe("hardware");
    expect(eb?.path).toMatch(/Microsoft\.PowerShell_profile\.ps1$/);
  });
});

describe("generated OLLAMA_* env block (rendered by the executor)", () => {
  it("emits the four blueprint static vars verbatim (PowerShell format)", async () => {
    const body = await renderProfile(makeCtx({ env: winTmpEnv() }));
    expect(body).toContain('$env:OLLAMA_FLASH_ATTENTION = "1"');
    expect(body).toContain('$env:OLLAMA_KV_CACHE_TYPE = "q8_0"');
    expect(body).toContain('$env:OLLAMA_CONTEXT_LENGTH = "8192"');
    expect(body).toContain('$env:OLLAMA_KEEP_ALIVE = "-1"');
  });

  it("wraps the block in the aih-managed (hardware) markers", async () => {
    const body = await renderProfile(makeCtx({ env: winTmpEnv() }));
    expect(body).toContain("# >>> aih managed (hardware) >>>");
    expect(body).toContain("# <<< aih managed (hardware) <<<");
  });

  it("writes the computed parallel-request count into OLLAMA_NUM_PARALLEL", async () => {
    // 32GB -> 25GB server; 5GB model -> floor(25/6)=4 parallel.
    const body = await renderProfile(makeCtx({ env: winTmpEnv() }));
    expect(body).toContain('$env:OLLAMA_NUM_PARALLEL = "4"');
  });

  it("recomputes parallelism for a larger --model-size-gb", async () => {
    // 12GB model on a 25GB server -> floor(25 / 14.4)=1.
    const body = await renderProfile(makeCtx({ env: winTmpEnv(), options: { modelSizeGb: "12" } }));
    expect(body).toContain('$env:OLLAMA_NUM_PARALLEL = "1"');
  });

  it("rejects malformed or non-positive --model-size-gb instead of using the default", async () => {
    await expect(command.plan(makeCtx({ options: { modelSizeGb: "bogus" } }))).rejects.toThrow(
      SettingsError,
    );
    await expect(command.plan(makeCtx({ options: { modelSizeGb: "-1" } }))).rejects.toThrow(
      "--model-size-gb must be a positive number",
    );
  });

  it("exposes the static vars and shell on the envblock action, rendering posix on linux", async () => {
    // The envblock action carries the vars + shell; the executor renders them.
    const eb = byKind(
      await command.plan(makeCtx({ platform: "linux", env: linuxTmpEnv() })),
      "envblock",
    )[0];
    expect(eb?.scope).toBe("hardware");
    expect(eb?.shell).toBe("posix");
    const keys = eb?.vars.map((v) => v.key) ?? [];
    expect(keys).toEqual(
      expect.arrayContaining([
        "OLLAMA_FLASH_ATTENTION",
        "OLLAMA_KV_CACHE_TYPE",
        "OLLAMA_CONTEXT_LENGTH",
        "OLLAMA_KEEP_ALIVE",
        "OLLAMA_NUM_PARALLEL",
      ]),
    );
    // The linux adapter reads CPU/RAM from /proc + os, so render and assert posix format.
    const body = await renderProfile(makeCtx({ platform: "linux", env: linuxTmpEnv() }));
    expect(body).toContain("export OLLAMA_FLASH_ATTENTION=1");
    expect(body).toMatch(/export OLLAMA_NUM_PARALLEL=\d+/);
  });
});

describe("profile doc", () => {
  it("reports the profiled host and derived budget and writes under contextDir", async () => {
    const p = await command.plan(makeCtx({ contextDir: ".ctx" }));
    const docs = byKind(p, "doc") as DocAction[];
    const d = docs[0];
    expect(d?.path).toBe(".ctx/hardware-profile.txt");
    expect(d?.text).toContain("Recommended quantization     : Q4_K_M");
    expect(d?.text).toContain("Max parallel requests");
    expect(d?.text).toContain("12 GB VRAM"); // DEFAULT_FACTS.vramGb surfaced in the profile
  });

  it("honors a custom contextDir for the doc path", async () => {
    const p = await command.plan(makeCtx({ contextDir: "memory/bank" }));
    const d = (byKind(p, "doc") as DocAction[])[0];
    expect(d?.path).toBe("memory/bank/hardware-profile.txt");
  });
});

describe("no-GPU host", () => {
  it("recommends Q3_K_S and still produces a valid env block", async () => {
    const ctx = makeCtx({ facts: { cores: 4, ramGb: 16, vramGb: -1 }, env: winTmpEnv() });
    const doc = (byKind(await command.plan(ctx), "doc") as DocAction[])[0];
    expect(doc?.text).toContain("Recommended quantization     : Q3_K_S");
    // 16GB -> 12GB server; 5GB model -> floor(12/6)=2.
    const body = await renderProfile(ctx);
    expect(body).toContain('$env:OLLAMA_NUM_PARALLEL = "2"');
  });
});

describe("verify probe (read-only)", () => {
  it("passes with an in-range sizing summary", async () => {
    const ctx = makeCtx({ verify: true });
    const p = await command.plan(ctx);
    const probe = byKind(p, "probe")[0];
    const check = probe ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("quant=Q4_K_M");
    expect(check?.detail).toContain("threads=6");
  });
});

describe("idempotency", () => {
  it("re-applying over its own output yields a byte-identical profile, preserving user lines", async () => {
    const ctx = makeCtx({ platform: "windows", env: winTmpEnv() });
    const profile = ctx.host.shellProfilePaths()[0] as string;
    mkdirSync(dirname(profile), { recursive: true });
    // Seed a user line, then apply the plan twice through the executor.
    writeFileSync(profile, '$env:USER_KEEP = "1"\n');
    const applyCtx: PlanContext = { ...ctx, apply: true };

    await executePlan(await command.plan(applyCtx), applyCtx);
    const first = readFileSync(profile, "utf8");
    await executePlan(await command.plan(applyCtx), applyCtx);
    const second = readFileSync(profile, "utf8");

    expect(second).toBe(first); // byte-identical re-apply
    expect(second).toContain('$env:USER_KEEP = "1"'); // user line preserved
    expect(second.match(/# >>> aih managed \(hardware\) >>>/g)).toHaveLength(1);
  });
});

describe("BOUNDARY: local-only, no remote mutation", () => {
  it("emits only envblock/doc/probe — never an exec or a remote target", async () => {
    const p = await command.plan(makeCtx());
    for (const a of p.actions) {
      expect(["envblock", "doc", "probe"]).toContain(a.kind);
    }
    // The env block targets a local profile path, not a URL.
    const eb = byKind(p, "envblock")[0];
    expect(eb?.path.startsWith("http")).toBe(false);
    // Its vars contain no host/URL — only local tuning values.
    const values = (eb?.vars ?? []).map((v) => v.value).join(" ");
    expect(values).not.toMatch(/https?:\/\//);
  });

  it("writes nothing to disk in dry-run, and the doc is the only file it would emit besides the profile", async () => {
    const ctx = makeCtx();
    const res = await executePlan(await command.plan(ctx), ctx);
    expect(res.applied).toBe(false);
    expect(res.execs).toHaveLength(0);
    // One profile write + one doc-with-path are the only file effects.
    expect(res.writes).toHaveLength(1);
    expect(res.docs).toHaveLength(1);
  });
});
