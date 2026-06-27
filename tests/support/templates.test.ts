import { describe, expect, it } from "vitest";
import type { Check, CheckCode, Verdict } from "../../src/internals/verify.js";
import { findingsFrom, type SupportFinding, toFinding } from "../../src/support/findings.js";
import { renderTemplate, supportTemplates } from "../../src/support/render.js";
import type { SupportContext } from "../../src/support/templates.js";

/**
 * PR2 core: coded checks → routed findings → copy-ready templates. Pure +
 * deterministic (the only seam is SupportContext, supplied here), so the bodies
 * are asserted by substring and re-render byte-identically.
 */

const CTX: SupportContext = {
  projectName: "my-repo",
  root: "<home>/code/my-repo",
  command: "aih heal --verify",
  contextDir: "ai-coding",
  targets: "claude, cursor",
  platform: "win32",
  runId: "run_abc123",
  timestamp: "2026-06-26T12:00:00Z",
};

function chk(code: CheckCode | undefined, verdict: Verdict, detail?: string, name = "x"): Check {
  return { name, verdict, detail, code };
}

/** Build the finding a coded fail/skip is guaranteed to produce (narrows away undefined). */
function mustFind(code: CheckCode, verdict: Verdict, detail?: string): SupportFinding {
  const f = toFinding(chk(code, verdict, detail), "heal");
  if (!f) throw new Error(`expected a finding for ${code}`);
  return f;
}

describe("findings — routing", () => {
  it("ignores a pass and a code-less check", () => {
    expect(toFinding(chk("cert.ca-missing", "pass"), "certs")).toBeUndefined();
    expect(toFinding(chk(undefined, "fail", "boom"), "doctor")).toBeUndefined();
  });

  it("routes a failing cert as an internal-IT escalation", () => {
    const f = toFinding(chk("cert.ca-missing", "fail", "set but missing: /x"), "heal");
    expect(f).toMatchObject({
      code: "cert.ca-missing",
      audience: "internal-it",
      kind: "escalation",
      severity: "blocking",
    });
    expect(f?.details).toEqual(["set but missing: /x"]);
  });

  it("routes a plaintext secret as a security escalation", () => {
    expect(toFinding(chk("secrets.plaintext-detected", "fail", ".env"), "secrets")).toMatchObject({
      audience: "security",
      kind: "escalation",
      severity: "blocking",
    });
  });

  it("routes a developer-fixable failure as a self-fix", () => {
    expect(
      toFinding(chk("cli.bootloader-missing", "fail", "missing"), "bootstrap-ai"),
    ).toMatchObject({ audience: "developer", kind: "self-fix", severity: "blocking" });
  });

  it("downgrades every skip to an optional improvement", () => {
    expect(toFinding(chk("mcp.config-missing", "skip", "no .mcp.json"), "heal")).toMatchObject({
      kind: "improvement",
      severity: "optional",
    });
  });

  it("dedupes by code and merges details", () => {
    const findings = findingsFrom(
      [
        chk("cli.bootloader-missing", "fail", "CLAUDE.md missing", "bootloader CLAUDE.md"),
        chk("cli.bootloader-missing", "fail", "AGENTS.md missing", "bootloader AGENTS.md"),
      ],
      "bootstrap-ai",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toEqual(["CLAUDE.md missing", "AGENTS.md missing"]);
  });

  it("sorts most-urgent-first", () => {
    const findings = findingsFrom(
      [
        chk("usage.no-data", "skip", "no data"),
        chk("secrets.plaintext-detected", "fail", ".env"),
        chk("cli.bootloader-drift", "fail", "drifted"),
      ],
      "report",
    );
    expect(findings.map((f) => f.severity)).toEqual(["blocking", "degraded", "optional"]);
  });
});

describe("templates — rendering", () => {
  const escalation = renderTemplate(
    mustFind("cert.ca-missing", "fail", "set but missing: /x"),
    CTX,
  );

  it("escalation carries full run context + the live detail", () => {
    expect(escalation.subject).toBe(
      "[AI Harness] blocking — Corporate CA not trusted by Node (my-repo)",
    );
    expect(escalation.copyLabel).toBe(
      "[copy] Internal IT escalation — Corporate CA not trusted by Node",
    );
    expect(escalation.id).toBe("escalation:cert.ca-missing");
    for (const needle of [
      CTX.command,
      CTX.runId,
      CTX.platform,
      CTX.root,
      CTX.contextDir,
      CTX.targets,
      "set but missing: /x",
      "Requested help",
    ]) {
      expect(escalation.body).toContain(needle);
    }
  });

  it("improvement is lighter — no workspace path or command-run line", () => {
    const t = renderTemplate(mustFind("mcp.config-missing", "skip", "no .mcp.json"), CTX);
    expect(t.subject).toBe("[AI Harness] improvement — No .mcp.json configured (my-repo)");
    expect(t.body).toContain("Run `aih mcp --apply`");
    expect(t.body).not.toContain("Workspace path:");
    expect(t.body).not.toContain(CTX.root);
  });

  it("self-fix is a terse runnable note", () => {
    const t = renderTemplate(mustFind("cli.bootloader-missing", "fail", "missing"), CTX);
    expect(t.subject).toBe("aih: CLI bootloader missing");
    expect(t.copyLabel).toBe("Self-fix — CLI bootloader missing");
    expect(t.body).toContain("Fix: Run `aih bootstrap-ai --apply`");
    expect(t.body).toContain("`aih heal --verify`");
  });

  it("renders byte-identically for the same inputs (deterministic)", () => {
    const f = mustFind("tls.verify-failed", "fail", "SSL problem");
    expect(renderTemplate(f, CTX).body).toBe(renderTemplate(f, CTX).body);
  });

  it("supportTemplates pipelines checks → ordered templates", () => {
    const templates = supportTemplates(
      [
        chk("usage.no-data", "skip", "no data"),
        chk("secrets.plaintext-detected", "fail", ".env"),
        chk(undefined, "pass"),
      ],
      "report",
      CTX,
    );
    expect(templates.map((t) => t.code)).toEqual(["secrets.plaintext-detected", "usage.no-data"]);
    expect(templates[0]?.kind).toBe("escalation");
    expect(templates[1]?.kind).toBe("improvement");
  });
});
