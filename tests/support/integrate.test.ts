import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { type CommandSpec, plan, probe } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { buildSupport, supportSummary } from "../../src/support/integrate.js";
import { isToolNeutral } from "../../src/support/templates.js";

const BASE = {
  capability: "heal",
  projectName: "acme",
  root: "/home/sam/acme",
  command: "aih heal --verify",
  contextDir: "ai-coding",
  targets: "none",
  platform: "linux",
  runId: "run_test01",
  timestamp: "2026-06-26T12:00:00Z",
  env: { HOME: "/home/sam" } as NodeJS.ProcessEnv,
};

function withChecks(checks: Check[], setupText?: string) {
  return buildSupport({ ...BASE, checks, setupText });
}

describe("buildSupport", () => {
  const certCheck: Check = {
    name: "cert: NODE_EXTRA_CA_CERTS",
    verdict: "fail",
    detail: "missing /home/sam/ca.pem",
    code: "cert.ca-missing",
  };

  it("renders a redacted escalation from a coded fail", () => {
    const b = withChecks([certCheck]);
    expect(b.templates).toHaveLength(1);
    expect(b.templates[0]?.code).toBe("cert.ca-missing");
    expect(b.templates[0]?.kind).toBe("escalation");
    // home path in the live detail is scrubbed before it reaches the ticket
    expect(b.templates[0]?.body).toContain("<home>/ca.pem");
    expect(b.templates[0]?.body).not.toContain("/home/sam/ca.pem");
  });

  it("weaves SETUP.md project context and surfaces corporate guidance", () => {
    const setup =
      "<!-- support:why -->acme is PCI-regulated.<!-- /support:why -->\n<!-- support:language -->Use British English.<!-- /support:language -->";
    const b = withChecks([certCheck], setup);
    expect(b.templates[0]?.body).toContain("acme is PCI-regulated.");
    expect(b.corporateGuidance).toBe("Use British English.");
  });

  it("redacts SETUP-derived guidance before rendering tickets and summaries", () => {
    const setup = [
      "<!-- support:why -->",
      "Workspace /home/sam/acme uses token sk-test-not-real-123456.",
      "<!-- /support:why -->",
      "<!-- support:routing -->",
      "Route /home/sam/acme to sk-test-not-real-654321.",
      "<!-- /support:routing -->",
      "<!-- support:language -->",
      "Mention /home/sam/acme but not sk-test-not-real-abcdef.",
      "<!-- /support:language -->",
    ].join("\n");

    const b = withChecks([certCheck], setup);
    const body = b.templates[0]?.body ?? "";
    const summary = supportSummary(b);

    expect(body).toContain("Workspace <home>/acme uses token [REDACTED].");
    expect(body).toContain("Route <home>/acme to [REDACTED].");
    expect(body).not.toContain("/home/sam");
    expect(body).not.toContain("sk-test-not-real");
    expect(b.corporateGuidance).toBe("Mention <home>/acme but not [REDACTED].");
    expect(summary).toContain("Mention <home>/acme but not [REDACTED].");
    expect(summary).not.toContain("/home/sam");
    expect(summary).not.toContain("sk-test-not-real");
  });

  it("neutralizes external live details and SETUP text before rendering tickets", () => {
    const setup = [
      "<!-- support:why -->",
      "AI Harness found this while running aih heal --verify.",
      "<!-- /support:why -->",
      "<!-- support:routing -->",
      "Route aih certs --apply evidence to platform.",
      "<!-- /support:routing -->",
    ].join("\n");

    const b = withChecks(
      [
        {
          ...certCheck,
          detail: "NODE_EXTRA_CA_CERTS is too long; run: aih certs --apply",
        },
      ],
      setup,
    );
    const body = b.templates[0]?.body ?? "";

    expect(isToolNeutral(body)).toBe(true);
    expect(body).toContain("the setup check");
    expect(body).not.toContain("aih certs --apply");
    expect(body).not.toContain("AI Harness");
    expect(b.findings[0]?.details[0]).toContain("the setup check");
  });

  it("neutralizes the harness repository slug in external project names", () => {
    const b = buildSupport({ ...BASE, projectName: "ai-harness", checks: [certCheck] });
    const template = b.templates[0];

    expect(template?.subject).toContain("[this project]");
    expect(template?.body).toContain("this project");
    expect(template?.subject).not.toContain("ai-harness");
    expect(template?.body).not.toContain("ai-harness");
    expect(isToolNeutral(`${template?.subject}\n${template?.body}`)).toBe(true);
  });

  it("is deterministic for fixed runId/timestamp", () => {
    expect(withChecks([certCheck]).templates[0]?.body).toBe(
      withChecks([certCheck]).templates[0]?.body,
    );
  });

  it("routes failed sandbox smoke availability as a blocking developer finding", () => {
    const b = withChecks([
      {
        name: "skill sandbox smoke test",
        verdict: "fail",
        code: "trust.sandbox-smoke-unavailable",
        detail: "promotion blocked: sandbox smoke test skipped: Docker is unavailable",
      },
    ]);

    expect(b.findings[0]).toMatchObject({
      code: "trust.sandbox-smoke-unavailable",
      audience: "developer",
      severity: "blocking",
      kind: "self-fix",
    });
  });

  it("upgrades duplicate sandbox smoke availability skips when a later gate blocks promotion", () => {
    const b = withChecks([
      {
        name: "skill sandbox smoke test",
        verdict: "skip",
        code: "trust.sandbox-smoke-unavailable",
        detail: "sandbox smoke test skipped: Docker is unavailable",
      },
      {
        name: "skill sandbox smoke test",
        verdict: "fail",
        code: "trust.sandbox-smoke-unavailable",
        detail: "promotion blocked: sandbox smoke test skipped: Docker is unavailable",
      },
    ]);

    expect(b.findings[0]).toMatchObject({
      code: "trust.sandbox-smoke-unavailable",
      severity: "blocking",
      kind: "self-fix",
    });
    expect(b.findings[0]?.details).toEqual([
      "sandbox smoke test skipped: Docker is unavailable",
      "promotion blocked: sandbox smoke test skipped: Docker is unavailable",
    ]);
  });
});

describe("supportSummary", () => {
  const b = buildSupport({
    ...BASE,
    checks: [{ name: "x", verdict: "fail", detail: "d", code: "cert.ca-missing" }],
  });

  it("lists copy labels and hints at --support-out when nothing was saved", () => {
    const s = supportSummary(b);
    expect(s).toContain("Support templates:");
    expect(s).toContain("[copy] Internal IT escalation");
    expect(s).toContain("Re-run with --support-out");
  });

  it("shows saved paths instead of the hint when files were written", () => {
    const s = supportSummary(b, { "cert.ca-missing": "tickets/cert.ca-missing.md" });
    expect(s).toContain("saved: tickets/cert.ca-missing.md");
    expect(s).not.toContain("Re-run with --support-out");
  });

  it("is empty when there are no templates", () => {
    expect(supportSummary({ findings: [], templates: [] })).toBe("");
  });
});

// --- runCapability wiring -------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-support-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A verifying capability whose probe emits a coded failure → an escalation. */
const diagSpec: CommandSpec = {
  name: "diag",
  summary: "test diag",
  alwaysVerify: true,
  options: [{ flags: "--sarif <file>", description: "emit SARIF" }],
  plan: () =>
    plan(
      "diag",
      probe("cert", () => ({
        name: "cert: NODE_EXTRA_CA_CERTS",
        verdict: "fail",
        detail: "not set",
        code: "cert.ca-missing",
      })),
    ),
};

const nestedSelfFixSpec: CommandSpec = {
  name: "verify",
  summary: "test nested self-fix command",
  alwaysVerify: true,
  plan: () =>
    plan(
      "verify",
      probe("mcp", () => ({
        name: "mcp",
        verdict: "fail",
        detail: ".mcp.json missing",
        code: "mcp.config-missing",
      })),
    ),
};

function command(argv: string[]): Command {
  const cmd = new Command("diag");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--sarif <file>")
    .option("--support-out <dir>");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(diagSpec, command(argv), {
    run: fakeRunner(() => undefined),
    env: {},
    now: () => new Date("2026-06-26T12:00:00Z"),
    newRunId: () => "run_test01",
    write: (t) => {
      out += t;
    },
  });
  return { code, out };
}

async function runNested(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  let code = 0;
  const root = new Command("aih");
  root.exitOverride();
  root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const truth = root.command("truth");
  const verify = truth.command("verify");
  verify
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .action(async (_options: Record<string, unknown>, command: Command) => {
      code = await runCapability(nestedSelfFixSpec, command, {
        run: fakeRunner(() => undefined),
        env: {},
        now: () => new Date("2026-06-26T12:00:00Z"),
        newRunId: () => "run_test01",
        write: (t) => {
          out += t;
        },
      });
    });
  await root.parseAsync(argv, { from: "user" });
  return { code, out };
}

describe("runCapability — support templates", () => {
  it("prints the tool-neutral support section in human mode", async () => {
    const { code, out } = await run(["--root", dir]);
    expect(code).toBe(1); // the coded fail still drives the exit code
    expect(out).toContain("Support templates:");
    expect(out).toContain(
      "[copy] Internal IT escalation — corporate CA not trusted by development tools",
    );
    expect(out).not.toContain("aih heal"); // the escalation body never names the harness
  });

  it("exposes findings + templates under --json", async () => {
    const { out } = await run(["--json", "--root", dir]);
    const parsed = JSON.parse(out) as {
      support?: { templates: Array<{ code: string; subject: string }> };
    };
    expect(parsed.support?.templates[0]?.code).toBe("cert.ca-missing");
    expect(parsed.support?.templates[0]?.subject).toContain("Blocking setup issue");
  });

  it("suppresses the support section when streaming SARIF to stdout", async () => {
    const { out } = await run(["--sarif", "-", "--root", dir]);
    expect(out.trim().startsWith("{")).toBe(true);
    expect(out).not.toContain("Support templates:");
  });

  it("writes full tickets to --support-out and reports the paths", async () => {
    const { out } = await run(["--support-out", "tickets", "--root", dir]);
    const file = join(dir, "tickets", "cert.ca-missing.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Blocking setup issue");
    expect(out).toContain("saved: tickets/cert.ca-missing.md");
  });

  it("pulls project context from SETUP.md on disk", async () => {
    writeFileSync(
      join(dir, "SETUP.md"),
      "<!-- support:why -->acme is PCI-regulated.<!-- /support:why -->",
    );
    const { out } = await run(["--json", "--root", dir]);
    const parsed = JSON.parse(out) as { support?: { templates: Array<{ body: string }> } };
    expect(parsed.support?.templates[0]?.body).toContain("acme is PCI-regulated.");
  });

  it("uses the full nested command path in internal self-fix support output", async () => {
    const { out } = await runNested(["truth", "verify", "--json", "--root", dir]);
    const parsed = JSON.parse(out) as { support?: { templates: Array<{ body: string }> } };
    const body = parsed.support?.templates[0]?.body ?? "";

    expect(body).toContain("Detected by `aih truth verify --verify`.");
    expect(body).not.toContain("Detected by `aih verify --verify`.");
  });
});
