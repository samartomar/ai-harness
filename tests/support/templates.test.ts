import { describe, expect, it } from "vitest";
import type { Check, CheckCode, Verdict } from "../../src/internals/verify.js";
import { findingsFrom, type SupportFinding, toFinding } from "../../src/support/findings.js";
import { renderTemplate, supportTemplates } from "../../src/support/render.js";
import { isToolNeutral, type SupportContext } from "../../src/support/templates.js";

/**
 * PR2 core: coded checks → routed findings → copy-ready templates. EXTERNAL
 * templates (escalation/improvement) are tool-neutral by contract; the developer
 * self-fix note is internal and may name the harness. Pure + deterministic (the
 * only seam is SupportContext, supplied here).
 */

const CTX: SupportContext = {
  projectName: "acme-web",
  root: "<home>/code/acme-web",
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

  it("routes a developer-fixable failure as an internal self-fix", () => {
    expect(
      toFinding(chk("cli.bootloader-missing", "fail", "missing"), "bootstrap-ai"),
    ).toMatchObject({ audience: "developer", kind: "self-fix", severity: "blocking" });
  });

  it("routes a developer skip as a self-fix (not an external request)", () => {
    expect(toFinding(chk("mcp.config-missing", "skip", "no .mcp.json"), "heal")).toMatchObject({
      audience: "developer",
      kind: "self-fix",
      severity: "optional",
    });
  });

  it("routes an external skip as an improvement request", () => {
    expect(toFinding(chk("mcp.uv-missing", "skip", "uv not found"), "mcp")).toMatchObject({
      audience: "dev-platform",
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

describe("templates — external tool-neutrality", () => {
  const escalation = renderTemplate(
    mustFind("cert.ca-missing", "fail", "set but missing: /x"),
    CTX,
  );

  it("escalation is tool-neutral and frames an environment issue", () => {
    expect(escalation.subject).toBe(
      "[acme-web] Development environment issue (blocking) — Corporate certificate authority not trusted by the toolchain",
    );
    expect(isToolNeutral(escalation.body)).toBe(true);
    expect(isToolNeutral(escalation.subject)).toBe(true);
    // No harness command, workspace path, AI-CLI targets, or context dir leak out.
    for (const leak of [CTX.command, CTX.root, CTX.targets, CTX.contextDir]) {
      expect(escalation.body).not.toContain(leak);
    }
    // But the project, machine, reference, live detail, and fix are present.
    for (const needle of [
      CTX.projectName,
      CTX.platform,
      CTX.runId,
      "set but missing: /x",
      "What is needed",
    ]) {
      expect(escalation.body).toContain(needle);
    }
  });

  it("falls back to a generic why-this-matters when SETUP.md gives none", () => {
    expect(escalation.body).toContain("approved dependencies");
  });

  it("weaves SETUP.md project context and a corporate-language footer when present", () => {
    const t = renderTemplate(mustFind("tls.verify-failed", "fail", "SSL problem"), {
      ...CTX,
      projectContext: "acme-web ships PCI-regulated payment flows; the toolchain must verify TLS.",
      corporateGuidance: "Address to the IT Service Desk and use British English.",
    });
    expect(t.body).toContain("PCI-regulated payment flows");
    expect(t.body).toContain("adapt before sending");
    expect(t.body).toContain("IT Service Desk");
  });

  it("improvement (external skip) is lighter and tool-neutral", () => {
    const t = renderTemplate(mustFind("mcp.uv-missing", "skip", "uv not found"), CTX);
    expect(t.subject).toBe(
      "[acme-web] Development environment improvement — Python launcher (uv) not available",
    );
    expect(isToolNeutral(t.body)).toBe(true);
    expect(t.body).not.toContain("Issue");
    expect(t.body).toContain("Requested improvement");
  });

  it("every external template is tool-neutral (sweep)", () => {
    const external: Array<[CheckCode, Verdict]> = [
      ["env.node-runtime", "fail"],
      ["cert.ca-missing", "fail"],
      ["tls.verify-failed", "fail"],
      ["npm.runtime-broken", "fail"],
      ["mcp.blocked", "fail"],
      ["mcp.unvendored-offline", "fail"],
      ["secrets.plaintext-detected", "fail"],
      ["mcp.uv-missing", "skip"],
    ];
    for (const [code, verdict] of external) {
      const t = renderTemplate(mustFind(code, verdict, "detail"), CTX);
      expect(t.kind === "escalation" || t.kind === "improvement").toBe(true);
      expect(isToolNeutral(t.body), `${code} body must be tool-neutral`).toBe(true);
      expect(isToolNeutral(t.subject), `${code} subject must be tool-neutral`).toBe(true);
    }
  });
});

describe("templates — internal self-fix", () => {
  it("is a terse runnable note that may name the harness", () => {
    const t = renderTemplate(mustFind("cli.bootloader-missing", "fail", "missing"), CTX);
    expect(t.subject).toBe("aih: CLI bootloader missing");
    expect(t.copyLabel).toBe("Self-fix — CLI bootloader missing");
    expect(t.body).toContain("Fix: Run `aih bootstrap-ai --apply`");
    expect(t.body).toContain("`aih heal --verify`");
  });

  it("renders byte-identically for the same inputs (deterministic)", () => {
    const f = mustFind("cli.bootloader-missing", "fail", "missing");
    expect(renderTemplate(f, CTX).body).toBe(renderTemplate(f, CTX).body);
  });
});

describe("templates — pipeline", () => {
  it("supportTemplates orders checks most-urgent-first and drops passes", () => {
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
    expect(templates[1]?.kind).toBe("self-fix"); // usage.no-data is developer-audience
  });
});
