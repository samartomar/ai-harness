import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command } from "../../src/bootstrap/index.js";
import { PHASES } from "../../src/bootstrap/phases.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, DocAction, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type {
  CertEntry,
  GpuInfo,
  HostAdapter,
  Platform,
  VdiInfo,
} from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const ZSCALER_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBExampleZscalerRootCA\n-----END CERTIFICATE-----\n";

/**
 * Host adapter that stubs every detection method to fixed values (so no test
 * reads the real trust store / /proc / nvidia-smi / VDI env) but keeps the real
 * per-platform argv / profile-path / shell behavior. Because the stub is the
 * ONLY source of certs / cpu / gpu / vdi facts, asserting a capability-specific
 * action in the bootstrap plan proves bootstrap actually called that leaf's
 * `plan(ctx)` rather than duplicating it.
 */
interface HostOverrides {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  certs?: CertEntry[];
  cpuCores?: number;
  totalRamGb?: number;
  gpu?: GpuInfo;
  vdi?: VdiInfo;
}

const NO_GPU: GpuInfo = { vendor: "none", backend: "cpu", vramGb: 0 };

function bootstrapHost(o: HostOverrides): HostAdapter {
  const platform = o.platform ?? "linux";
  const env = o.env ?? { HOME: "/home/dev" };
  const base = makeHostAdapter({ platform, run: fakeRunner(() => undefined), env });
  const stubs: Partial<HostAdapter> = {
    trustStoreCerts: async (): Promise<CertEntry[]> =>
      o.certs ?? [{ subject: "CN=Zscaler Root CA", pem: ZSCALER_PEM }],
    cpuPhysicalCores: async (): Promise<number> => o.cpuCores ?? 8,
    totalRamGb: async (): Promise<number> => o.totalRamGb ?? 32,
    gpu: async (): Promise<GpuInfo> => o.gpu ?? NO_GPU,
    detectVdi: (): VdiInfo => o.vdi ?? { isVdi: false, reason: "no VDI markers" },
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in stubs) return stubs[prop as keyof HostAdapter];
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface CtxOverrides extends HostOverrides {
  root: string;
  options?: Record<string, unknown>;
  contextDir?: string;
  verify?: boolean;
}

function makeCtx(o: CtxOverrides): PlanContext {
  const env = o.env ?? { HOME: o.root, USERPROFILE: o.root };
  return {
    root: o.root,
    contextDir: o.contextDir ?? ".ai-context",
    apply: false,
    verify: o.verify ?? false,
    json: false,
    run: fakeRunner(() => undefined),
    host: bootstrapHost({ ...o, env }),
    env,
    options: o.options ?? {},
  };
}

// ---- typed action finders -------------------------------------------------

const isWrite = (a: Action): a is WriteAction => a.kind === "write";
const isDoc = (a: Action): a is DocAction => a.kind === "doc";
const norm = (p: string): string => p.replace(/\\/g, "/");

const writeEndingWith = (actions: Action[], suffix: string): WriteAction | undefined =>
  actions.filter(isWrite).find((a) => norm(a.path).endsWith(suffix));

const docMatching = (actions: Action[], needle: string): DocAction | undefined =>
  actions.filter(isDoc).find((a) => a.describe.includes(needle) || a.text.includes(needle));

const envBlockOf = (
  actions: Action[],
  scope: string,
): Extract<Action, { kind: "envblock" }> | undefined =>
  actions.find(
    (a): a is Extract<Action, { kind: "envblock" }> => a.kind === "envblock" && a.scope === scope,
  );

const allDocText = (actions: Action[]): string =>
  actions
    .filter(isDoc)
    .map((a) => `${a.describe}\n${a.text}`)
    .join("\n");

/**
 * A stable structural fingerprint of the emitted plan: every field that defines
 * what gets written / executed / documented, in order. The probe `run` closure is
 * intentionally excluded (functions are not part of the *emitted* plan's value) —
 * what must be deterministic is the action stream itself, which is what `init`
 * and `bootstrap` serialize/preview.
 */
const fingerprint = (actions: Action[]): string =>
  JSON.stringify(
    actions.map((a) => ({
      kind: a.kind,
      describe: a.describe,
      path: norm("path" in a && typeof a.path === "string" ? a.path : ""),
      contents: a.kind === "write" ? (a.contents ?? "") : "",
      json: a.kind === "write" ? (a.json ?? null) : null,
      text: a.kind === "doc" ? a.text : "",
      argv: a.kind === "exec" ? a.argv.map(norm) : [],
      scope: a.kind === "envblock" ? a.scope : "",
      vars: a.kind === "envblock" ? a.vars : [],
    })),
  );

let tmp = "";
const dirs: string[] = [];
function freshTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "aih-bootstrap-"));
  dirs.push(tmp);
  return tmp;
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("bootstrap command surface", () => {
  it("keeps the foundation CLI name and the --phase option", () => {
    expect(command.name).toBe("bootstrap");
    const flags = (command.options ?? []).map((opt) => opt.flags);
    expect(flags).toContain("--phase <n>");
  });

  it("describes a 4-phase workstation rollout in its summary", () => {
    expect(command.summary.toLowerCase()).toContain("4-phase");
  });
});

describe("bootstrap plan — full composition (all four phases)", () => {
  it("emits a doc header for each of the four blueprint phases, in order", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root }));

    const headerIdx = PHASES.map((meta) =>
      p.actions.findIndex((a) => a.kind === "doc" && a.describe === meta.title),
    );
    // every phase header present
    for (const idx of headerIdx) expect(idx).toBeGreaterThanOrEqual(0);
    // strictly increasing → phases appear in blueprint order
    for (let i = 1; i < headerIdx.length; i += 1) {
      expect(headerIdx[i]).toBeGreaterThan(headerIdx[i - 1] as number);
    }
  });

  it("each phase header restates the blueprint objective verbatim", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root }));
    for (const meta of PHASES) {
      const header = p.actions.find(
        (a): a is DocAction => a.kind === "doc" && a.describe === meta.title,
      );
      expect(header?.text).toContain(meta.objective);
    }
  });

  it("composes the certs PEM bundle (Phase 1 sourced from certs.plan)", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));

    const pem = writeEndingWith(p.actions, "/.config/enterprise-ca/corporate-root-ca.pem");
    expect(pem).toBeDefined();
    expect(pem?.contents).toBe(ZSCALER_PEM);
    // the certs PEM lockdown exec is carried through too
    const lockdown = p.actions.find(
      (a) => a.kind === "exec" && norm(a.argv.at(-1) ?? "").endsWith("corporate-root-ca.pem"),
    );
    expect(lockdown).toBeDefined();
  });

  it("composes hardware (OLLAMA_* block) and vdi actions for Phase 2", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));

    // hardware contributes its tuned OLLAMA_* env block (scope "hardware") to the profile
    const hwBlock = envBlockOf(p.actions, "hardware");
    expect(hwBlock).toBeDefined();
    expect(norm(hwBlock?.path ?? "").endsWith("/.bashrc")).toBe(true);
    expect(hwBlock?.vars.some((v) => v.key.startsWith("OLLAMA_"))).toBe(true);

    // vdi contributes its detection probe + redirection block
    const vdiProbe = p.actions.find((a) => a.kind === "probe" && a.describe === "VDI detection");
    expect(vdiProbe).toBeDefined();
  });

  it("composes telemetry (collector + fetcher + OTel env) for Phase 4", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root }));

    expect(writeEndingWith(p.actions, ".ai-context/telemetry/collector.yaml")).toBeDefined();
    expect(writeEndingWith(p.actions, ".ai-context/telemetry/fetch-analytics.mjs")).toBeDefined();
    const otelDoc = allDocText(p.actions);
    expect(otelDoc).toContain("cron");
  });

  it("reports capability 'bootstrap' and bundles many actions", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root }));
    expect(p.capability).toBe("bootstrap");
    // 4 headers + certs (>=6) + hardware (3) + vdi (>=2) + telemetry (>=5) + 2 cloud docs
    expect(p.actions.length).toBeGreaterThan(15);
  });
});

describe("bootstrap plan — --phase narrows to a single phase", () => {
  it("--phase 2 yields only the Phase 2 header + hardware + vdi (no certs/telemetry)", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home }, options: { phase: "2" } }));

    // exactly one phase header, and it is Phase 2
    const headers = p.actions.filter((a) => a.kind === "doc" && /^Phase \d:/.test(a.describe));
    expect(headers).toHaveLength(1);
    expect((headers[0] as DocAction).describe).toBe(PHASES[1]?.title);

    // hardware + vdi present
    expect(p.actions.some((a) => a.kind === "envblock" && a.scope === "hardware")).toBe(true);
    expect(p.actions.some((a) => a.kind === "probe" && a.describe === "VDI detection")).toBe(true);

    // certs (Phase 1) and telemetry (Phase 4) excluded
    expect(writeEndingWith(p.actions, "corporate-root-ca.pem")).toBeUndefined();
    expect(writeEndingWith(p.actions, "collector.yaml")).toBeUndefined();
  });

  it("--phase 1 yields only certs (+ its header), nothing from later phases", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home }, options: { phase: "1" } }));

    expect(writeEndingWith(p.actions, "corporate-root-ca.pem")).toBeDefined();
    expect(p.actions.some((a) => a.kind === "write" && a.describe.includes("OLLAMA_*"))).toBe(
      false,
    );
    expect(docMatching(p.actions, "MDM distribution")).toBeUndefined();
  });

  it("--phase 3 is cloud doc-only: SSO gateway guidance, zero writes and zero execs", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root, options: { phase: "3" } }));

    expect(p.actions.some((a) => a.kind === "write")).toBe(false);
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
    const sso = docMatching(p.actions, "SSO MCP gateway");
    expect(sso).toBeDefined();
    expect(sso?.text).toContain("agentgateway login --check");
  });

  it("an unknown --phase value fails closed instead of silently running every phase", async () => {
    const root = freshTmp();
    await expect(command.plan(makeCtx({ root, options: { phase: "9" } }))).rejects.toThrow(
      /--phase must be one of 1, 2, 3, or 4/,
    );
  });
});

describe("bootstrap plan — HARD BOUNDARY: cloud is doc-only", () => {
  it("Phase 3 SSO and Phase 4 MDM live in doc actions, never write/exec", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root }));

    const sso = docMatching(p.actions, "SSO MCP gateway");
    const mdm = docMatching(p.actions, "MDM distribution");
    expect(sso?.kind).toBe("doc");
    expect(mdm?.kind).toBe("doc");
    // the exact remote commands are present as guidance
    expect(sso?.text).toContain("az ad app create");
    expect(mdm?.text.toLowerCase()).toContain("intune");

    // no write or exec action targets a remote system (entra/okta/gateway/mdm/api host)
    const remoteNeedles = ["az ad", "agentgateway", "intune", "jamf", "api.claude.com", "https://"];
    for (const a of p.actions) {
      if (a.kind === "write" && a.contents) {
        for (const needle of remoteNeedles) {
          // the telemetry fetcher legitimately prints an analytics URL; exclude it
          if (norm(a.path).endsWith("fetch-analytics.mjs")) continue;
          expect(a.contents.toLowerCase()).not.toContain(needle);
        }
      }
      if (a.kind === "exec") {
        const argv = a.argv.join(" ").toLowerCase();
        expect(argv).not.toContain("az ad");
        expect(argv).not.toContain("agentgateway");
        expect(argv).not.toContain("curl http");
      }
    }
  });

  it("every probe carried up from a sub-capability stays read-only (pass/fail/skip)", async () => {
    const root = freshTmp();
    const ctx = makeCtx({ root, verify: true });
    const p = await command.plan(ctx);
    const probes = p.actions.filter((a) => a.kind === "probe");
    expect(probes.length).toBeGreaterThan(0);
    for (const pr of probes) {
      if (pr.kind !== "probe") continue;
      const check = await pr.run(ctx);
      expect(["pass", "fail", "skip"]).toContain(check.verdict);
    }
  });
});

describe("bootstrap plan — edge cases mirror the leaf capabilities", () => {
  it("threads a custom contextDir into the composed telemetry collector path", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root, contextDir: "ai-coding" }));
    expect(writeEndingWith(p.actions, "ai-coding/telemetry/collector.yaml")).toBeDefined();
    expect(writeEndingWith(p.actions, ".ai-context/telemetry/collector.yaml")).toBeUndefined();
  });

  it("no matching CA → Phase 1 degrades to a single certs doc (no PEM write)", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root, certs: [], options: { phase: "1" } }));
    expect(writeEndingWith(p.actions, "corporate-root-ca.pem")).toBeUndefined();
    expect(docMatching(p.actions, "no matching corporate CA")).toBeDefined();
  });

  it("on a VDI host, Phase 2 carries the vdi redirection write + symlink exec", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(
      makeCtx({
        root,
        env: { HOME: home, USER: "dev" },
        vdi: { isVdi: true, reason: "/scratch mount present", kind: "res" },
        options: { phase: "2" },
      }),
    );
    const redirect = p.actions.find(
      (a): a is Extract<Action, { kind: "envblock" }> =>
        a.kind === "envblock" &&
        norm(a.path).endsWith("/.bashrc") &&
        a.describe.includes("scratch"),
    );
    expect(redirect).toBeDefined();
    const symlink = p.actions.find(
      (a) => a.kind === "exec" && a.describe.includes("code-review-graph"),
    );
    expect(symlink).toBeDefined();
  });

  it("on a non-VDI host, Phase 2 vdi half is a doc + skip probe (no redirection write)", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const ctx = makeCtx({
      root,
      env: { HOME: home },
      vdi: { isVdi: false, reason: "no VDI markers" },
      options: { phase: "2" },
    });
    const p = await command.plan(ctx);

    const vdiDoc = docMatching(p.actions, "no VDI detected");
    expect(vdiDoc).toBeDefined();
    const vdiProbe = p.actions.find((a) => a.kind === "probe" && a.describe === "VDI detection");
    expect(vdiProbe).toBeDefined();
    if (vdiProbe?.kind === "probe") {
      expect((await vdiProbe.run(ctx)).verdict).toBe("skip");
    }
    // no scratch-redirection block on a non-VDI host
    const redirect = p.actions.find((a) => a.kind === "envblock" && a.scope === "vdi");
    expect(redirect).toBeUndefined();
  });

  it("is idempotent: planning twice over the same context yields an identical action stream", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const vdi: VdiInfo = { isVdi: true, reason: "/scratch mount present", kind: "res" };
    // Exercise the full four-phase composition with every leaf live (certs PEM +
    // exec lockdown, hardware OLLAMA_* block, vdi redirection, telemetry writes),
    // so the fingerprint covers write/doc/probe/exec from every composed plan.
    const first = await command.plan(
      makeCtx({ root, env: { HOME: home, USERPROFILE: home, USER: "dev" }, vdi }),
    );
    const second = await command.plan(
      makeCtx({ root, env: { HOME: home, USERPROFILE: home, USER: "dev" }, vdi }),
    );

    expect(first.actions.length).toBe(second.actions.length);
    expect(fingerprint(first.actions)).toBe(fingerprint(second.actions));
    // guard against a vacuous fingerprint: the stream must actually carry an exec
    // (certs lockdown) and a probe, not just docs
    expect(first.actions.some((a) => a.kind === "exec")).toBe(true);
    expect(first.actions.some((a) => a.kind === "probe")).toBe(true);
  });
});

describe("bootstrap composition — env blocks fold, never clobber", () => {
  it("applying the full bootstrap layers every workstation env block into one profile", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const ctx = makeCtx({
      root,
      env: { HOME: home, USERPROFILE: home, USER: "dev" },
      vdi: { isVdi: true, reason: "/scratch mount present", kind: "res" },
    });
    const profile = ctx.host.shellProfilePaths()[0] as string; // <home>/.bashrc
    mkdirSync(dirname(profile), { recursive: true });

    const applyCtx: PlanContext = { ...ctx, apply: true };
    await executePlan(await command.plan(applyCtx), applyCtx);
    const body = readFileSync(profile, "utf8");

    // The regression this guards: four capabilities write the SAME profile; the
    // executor must fold their managed blocks instead of the last clobbering the rest.
    expect(body).toContain("# >>> aih managed (certs) >>>");
    expect(body).toContain("# >>> aih managed (hardware) >>>");
    expect(body).toContain("# >>> aih managed (vdi) >>>");
    expect(body).toContain("# >>> aih managed (telemetry) >>>");
  });
});
