import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flagKey, runCapability } from "../../src/commands/run.js";
import { executePlan } from "../../src/internals/execute.js";
import { type CommandSpec, digest, plan, probe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyValidateCommand } from "../../src/org-policy/validate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal verify-gate capability: one passing probe + one FAILING drift probe. */
const gateSpec: CommandSpec = {
  name: "gate",
  summary: "test gate",
  alwaysVerify: true,
  options: [{ flags: "--sarif <file>", description: "emit SARIF" }],
  plan: () =>
    plan(
      "gate",
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
      probe("drift", () => ({ name: "drift", verdict: "fail", detail: "drifted" })),
    ),
};

/** A capability that does NOT alwaysVerify — its probe only runs when verify is on. */
const plainSpec: CommandSpec = {
  name: "plain",
  summary: "test plain",
  options: [{ flags: "--sarif <file>", description: "emit SARIF" }],
  plan: () =>
    plan(
      "plain",
      probe("ok", () => ({ name: "ok", verdict: "pass" })),
    ),
};

/** Build a standalone commander Command for a spec, populated from `argv`. */
function command(argv: string[]): Command {
  const cmd = new Command("gate");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--posture <posture>", "", "vibe")
    // Mirror heal/certs: a commander DEFAULT of "Zscaler" so opts.caPattern is never
    // undefined — the exact condition run.ts must not let masquerade as an override.
    .option("--ca-pattern <pattern>", "", "Zscaler")
    .option("--sarif <file>")
    .option("--open")
    .option("--demo")
    .option("--refresh <sec>")
    .option("--no-cache");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

/** Run a spec (default `gateSpec`) with the given user args, capturing stdout. */
async function run(
  argv: string[],
  spec: CommandSpec = gateSpec,
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(spec, command(argv), {
    run: fakeRunner(() => undefined),
    env: {},
    write: (t) => {
      out += t;
    },
  });
  return { code, out };
}

/** A capability that echoes the resolved context dir so the ladder is observable. */
const echoSpec: CommandSpec = {
  name: "echo",
  summary: "echo the resolved context dir",
  plan: (ctx) =>
    plan(
      "echo",
      digest("context-dir", ctx.contextDir),
      digest("posture", `${ctx.posture}:${ctx.postureSource}`),
    ),
};

/** A capability that echoes the resolved CA pattern so the env/flag ladder is observable. */
const caEchoSpec: CommandSpec = {
  name: "ca-echo",
  summary: "echo the resolved ca pattern",
  plan: (ctx) => plan("ca-echo", digest("ca-pattern", String(ctx.options.caPattern))),
};

const cacheSpec: CommandSpec = {
  name: "cache",
  summary: "echo negatable custom option",
  options: [{ flags: "--no-cache", description: "disable cache" }],
  plan: (ctx) => plan("cache", digest("cache", String(ctx.options.cache))),
};

const liveSpec: CommandSpec = {
  name: "live",
  summary: "test report-style live options",
  liveModeOptions: ["open", "demo", "refresh"],
  options: [
    { flags: "--open", description: "open" },
    { flags: "--demo", description: "demo" },
    { flags: "--refresh <sec>", description: "refresh" },
  ],
  plan: (ctx) => plan("live", digest("apply", String(ctx.apply))),
};

/** Resolve the CA pattern runCapability lands on for the given argv + env. */
async function resolvedCaPattern(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  let out = "";
  await runCapability(caEchoSpec, command(argv), {
    run: fakeRunner(() => undefined),
    env,
    write: (t) => {
      out += t;
    },
  });
  return out;
}

/** Resolve the context dir runCapability lands on for the given argv + env. */
async function resolvedDir(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  let out = "";
  await runCapability(echoSpec, command(argv), {
    run: fakeRunner(() => undefined),
    env,
    write: (t) => {
      out += t;
    },
  });
  return out;
}

/** Resolve the posture runCapability lands on for the given argv + env. */
async function resolvedPosture(
  argv: string[],
  env: NodeJS.ProcessEnv,
  spec: CommandSpec = echoSpec,
): Promise<string> {
  let out = "";
  await runCapability(spec, command(argv), {
    run: fakeRunner(() => undefined),
    env,
    write: (t) => {
      out += t;
    },
  });
  return out;
}

describe("runCapability — context-dir precedence ladder (flag > marker > env > default)", () => {
  function writeMarker(contextDir: string, posture?: string): void {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir,
        targets: [],
        ...(posture ? { posture } : {}),
      }),
    );
  }

  it("explicit --context-dir flag wins over marker and env", async () => {
    writeMarker("marker-dir");
    const out = await resolvedDir(["--context-dir", "flag-dir", "--root", dir], {
      AIH_CONTEXT_DIR: "env-dir",
    });
    expect(out).toContain("flag-dir");
    expect(out).not.toContain("marker-dir");
    expect(out).not.toContain("env-dir");
  });

  it("committed marker wins over env when no flag is passed", async () => {
    writeMarker("marker-dir");
    const out = await resolvedDir(["--root", dir], { AIH_CONTEXT_DIR: "env-dir" });
    expect(out).toContain("marker-dir");
    expect(out).not.toContain("env-dir");
  });

  it("env wins over the default when neither flag nor marker is present", async () => {
    const out = await resolvedDir(["--root", dir], { AIH_CONTEXT_DIR: "env-dir" });
    expect(out).toContain("env-dir");
  });

  it("falls back to the ai-coding default when nothing else is set", async () => {
    const out = await resolvedDir(["--root", dir], {});
    expect(out).toContain("ai-coding");
  });
});

describe("runCapability — posture precedence ladder (org floor > flag > marker > env > default)", () => {
  function writeMarker(posture: string): void {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [], posture }),
    );
  }

  function writeOrgFloor(minimumPosture: string): void {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture,
        references: { repoContract: "ai-coding/project.json" },
      }),
    );
  }

  it("explicit --posture wins over marker and env", async () => {
    writeMarker("team");
    const out = await resolvedPosture(["--posture", "vibe", "--root", dir], {
      AIH_POSTURE: "enterprise",
    });
    expect(out).toContain("vibe:flag");
  });

  it("marker wins over env when no flag is passed", async () => {
    writeMarker("team");
    const out = await resolvedPosture(["--root", dir], { AIH_POSTURE: "enterprise" });
    expect(out).toContain("team:marker");
  });

  it("env wins over the default when neither flag nor marker is present", async () => {
    const out = await resolvedPosture(["--root", dir], { AIH_POSTURE: "team" });
    expect(out).toContain("team:env");
  });

  it("defaults to vibe", async () => {
    const out = await resolvedPosture(["--root", dir], {});
    expect(out).toContain("vibe:default");
  });

  it("org minimum posture clamps a lower local choice but never lowers enterprise", async () => {
    writeOrgFloor("team");
    expect(await resolvedPosture(["--posture", "vibe", "--root", dir], {})).toContain(
      "team:org-floor",
    );
    expect(await resolvedPosture(["--posture", "enterprise", "--root", dir], {})).toContain(
      "enterprise:flag",
    );
  });

  it("read-only specs accept --posture but ignore it as a posture source", async () => {
    const readOnlyEchoSpec: CommandSpec = { ...echoSpec, readOnly: true };
    const out = await resolvedPosture(
      ["--posture", "enterprise", "--root", dir],
      {},
      readOnlyEchoSpec,
    );
    expect(out).toContain("vibe:default");
  });

  it("read-only specs can explicitly honor --posture for stricter read-only probes", async () => {
    const readOnlyEchoSpec: CommandSpec = {
      ...echoSpec,
      readOnly: true,
      honorReadOnlyPostureFlag: true,
    };
    const out = await resolvedPosture(
      ["--posture", "enterprise", "--root", dir],
      {},
      readOnlyEchoSpec,
    );
    expect(out).toContain("enterprise:flag");
  });

  it("rejects malformed --posture input instead of falling back to vibe", async () => {
    let out = "";
    const code = await runCapability(
      echoSpec,
      command(["--posture", "enterprsie", "--root", dir]),
      {
        run: fakeRunner(() => undefined),
        env: {},
        write: (t) => {
          out += t;
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("invalid --posture");
  });

  it("rejects malformed AIH_POSTURE input instead of falling back to vibe", async () => {
    let out = "";
    const code = await runCapability(echoSpec, command(["--root", dir]), {
      run: fakeRunner(() => undefined),
      env: { AIH_POSTURE: "enterprsie" },
      write: (t) => {
        out += t;
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("invalid AIH_POSTURE");
  });

  it("lets policy validate report malformed org policy as a coded verification finding", async () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({ schemaVersion: 1, minimumPosture: "wild", references: {} }),
    );

    let out = "";
    const code = await runCapability(policyValidateCommand, command(["--json", "--root", dir]), {
      run: fakeRunner(() => undefined),
      env: {},
      write: (t) => {
        out += t;
      },
    });

    expect(code).toBe(1);
    const payload = JSON.parse(out) as {
      error?: unknown;
      report?: { checks: Array<{ name: string; verdict: string; code?: string; detail?: string }> };
    };
    expect(payload.error).toBeUndefined();
    const check = payload.report?.checks.find((c) => c.name === "org policy schema");
    expect(check).toMatchObject({ verdict: "fail", code: "org-policy.invalid" });
    expect(check?.detail).toContain("org-policy is invalid");
  });
});

describe("runCapability — ca-pattern env fallback (flag > env > default)", () => {
  it("honors AIH_CA_PATTERN when --ca-pattern is not passed (commander default must not shadow env)", async () => {
    // Regression: heal/certs give --ca-pattern a "Zscaler" default, so opts.caPattern is
    // never undefined. Passing that default into loadSettings shadowed AIH_CA_PATTERN and
    // always printed "Zscaler". With no flag, the env var must win.
    const out = await resolvedCaPattern(["--root", dir], { AIH_CA_PATTERN: "Netskope" });
    expect(out).toContain("Netskope");
    expect(out).not.toContain("Zscaler");
  });

  it("an explicit --ca-pattern still wins over the env var", async () => {
    const out = await resolvedCaPattern(["--ca-pattern", "Foo", "--root", dir], {
      AIH_CA_PATTERN: "Netskope",
    });
    expect(out).toContain("Foo");
    expect(out).not.toContain("Netskope");
  });

  it("falls back to the Zscaler default when neither flag nor env is set", async () => {
    const out = await resolvedCaPattern(["--root", dir], {});
    expect(out).toContain("Zscaler");
  });
});

describe("runCapability — custom option extraction", () => {
  it("uses Commander attribute names for negatable custom options", async () => {
    expect(flagKey("--no-cache")).toBe("cache");
    const { out } = await run(["--no-cache", "--root", dir], cacheSpec);
    expect(out).toContain("cache");
    expect(out).toContain("false");
  });
});

describe("runCapability — custom execution", () => {
  it("uses an injected executor with the resolved context", async () => {
    let observedRoot = "";
    const spec: CommandSpec = {
      name: "custom-execution",
      summary: "exercise the custom executor seam",
      plan: () => {
        throw new Error("the ordinary plan must not be built");
      },
    };

    const code = await runCapability(spec, command(["--root", dir, "--apply"]), {
      env: {},
      run: fakeRunner(() => undefined),
      write: () => {},
      execute: async (ctx) => {
        observedRoot = ctx.root;
        return executePlan(plan("custom-execution", digest("custom execution", "ok")), ctx);
      },
    });

    expect(code).toBe(0);
    expect(observedRoot).toBe(dir);
  });
});

describe("runCapability — live report options", () => {
  it("rejects --refresh with --json before emitting a mixed JSON/live stream", async () => {
    const { code, out } = await run(["--json", "--refresh", "1", "--root", dir], liveSpec);
    expect(code).toBe(1);
    const payload = JSON.parse(out) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("AIH_CONFIG");
    expect(payload.error.message).toContain("--refresh cannot be combined with --json");
  });

  it("rejects fractional or zero refresh intervals", async () => {
    const { code, out } = await run(["--refresh", "0.1", "--root", dir], liveSpec);
    expect(code).toBe(1);
    expect(out).toContain("--refresh must be an integer >= 1");
  });
});

describe("runCapability — root resolution", () => {
  /** A capability that echoes ctx.root so the resolution boundary is observable. */
  const rootEchoSpec: CommandSpec = {
    name: "root-echo",
    summary: "echo the resolved root",
    plan: (ctx) => plan("root-echo", digest("root", ctx.root)),
  };

  it("resolves a relative positional root ('.') to an absolute ctx.root", async () => {
    // Regression: `aih workspace . --apply` passed "." through to ctx.root, where
    // basename(".") derived "..code-workspace" and tripped AIH_PATH_CONTAINMENT.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      let out = "";
      await runCapability(rootEchoSpec, command(["."]), {
        run: fakeRunner(() => undefined),
        env: {},
        write: (t) => {
          out += t;
        },
      });
      expect(out).toContain(process.cwd());
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("resolves a relative --root to an absolute ctx.root", async () => {
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      let out = "";
      await runCapability(rootEchoSpec, command(["--root", "."]), {
        run: fakeRunner(() => undefined),
        env: {},
        write: (t) => {
          out += t;
        },
      });
      expect(out).toContain(process.cwd());
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("runCapability — --sarif wiring", () => {
  it("writes the SARIF report to a file WITHOUT --apply (drift gate runs verify-only)", async () => {
    const { code, out } = await run(["--verify", "--sarif", "aih.sarif", "--root", dir]);
    // The failing probe still drives the exit code — SARIF emission is orthogonal.
    expect(code).toBe(1);
    expect(out).toContain("[sarif] aih.sarif");
    const sarif = JSON.parse(readFileSync(join(dir, "aih.sarif"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
    const byRule = Object.fromEntries(
      sarif.runs[0].results.map((r: { ruleId: string; level: string }) => [r.ruleId, r.level]),
    );
    expect(byRule.drift).toBe("error");
    expect(byRule.ok).toBe("note");
  });

  it("streams a CLEAN SARIF document to stdout when the path is `-` (summary suppressed)", async () => {
    const { out } = await run(["--verify", "--sarif", "-", "--root", dir]);
    // stdout is pure SARIF so `… --sarif - > out.sarif` pipes a valid artifact.
    expect(out.trim().startsWith("{")).toBe(true);
    const sarif = JSON.parse(out);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toContain("drift");
    expect(out).not.toContain("[sarif]"); // the `-` path is the content, not a confirmation line
    expect(out).not.toContain("passed"); // the human summary is suppressed
  });

  it("emits no SARIF and no confirmation line when --sarif is absent", async () => {
    const { out } = await run(["--verify", "--root", dir]);
    expect(out).not.toContain("[sarif]");
    expect(existsSync(join(dir, "aih.sarif"))).toBe(false);
  });

  it("skips the confirmation line in --json mode but still writes the file", async () => {
    const { out } = await run(["--verify", "--json", "--sarif", "aih.sarif", "--root", dir]);
    expect(out).not.toContain("[sarif]"); // would corrupt the JSON stream
    expect(existsSync(join(dir, "aih.sarif"))).toBe(true);
  });

  it("implies --verify: a non-alwaysVerify capability emits SARIF from --sarif alone", async () => {
    // No `--verify` flag — naming the SARIF output is enough to run the probes.
    const { out } = await run(["--sarif", "out.sarif", "--root", dir], plainSpec);
    const sarif = JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8"));
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toContain("ok");
    expect(out).toContain("[sarif] out.sarif");
  });
});
