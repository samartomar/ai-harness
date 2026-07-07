import { describe, expect, it } from "vitest";
import type { Check, CheckCode, Verdict } from "../../src/internals/verify.js";
import { findingsFrom, type SupportFinding, toFinding } from "../../src/support/findings.js";
import { renderTemplate, supportTemplates } from "../../src/support/render.js";
import { isToolNeutral, type SupportContext } from "../../src/support/templates.js";

/**
 * PR2 core: coded checks → routed findings → ticket-ready templates
 * (Summary → Impact → Evidence → Environment → Requested fix → Acceptance).
 * EXTERNAL tickets are tool-neutral by contract; the developer self-fix note is
 * internal and may name the harness. Pure + deterministic.
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

  it("routes a failing cert as a blocking internal-IT escalation with canned ticket fields", () => {
    const f = mustFind("cert.ca-missing", "fail", "not set");
    expect(f).toMatchObject({ audience: "internal-it", kind: "escalation", severity: "blocking" });
    expect(f.affectedArea).toContain("certificate trust");
    expect(f.evidence).toContain("approved corporate CA is not available");
    expect(f.acceptance?.length).toBeGreaterThan(0);
  });

  it("routes a developer skip as a self-fix and an external skip as an improvement", () => {
    expect(toFinding(chk("mcp.config-missing", "skip"), "heal")?.kind).toBe("self-fix");
    expect(toFinding(chk("mcp.uv-missing", "skip"), "mcp")?.kind).toBe("improvement");
  });

  it("routes docs claim-ledger failures as developer self-fix notes", () => {
    for (const code of [
      "docs.claim-mapping-missing",
      "docs.claim-matrix-row-missing",
      "docs.claim-test-missing",
      "docs.feature-ledger-drift",
      "truth.sidecar-missing",
      "truth.bound-commit-drift",
      "truth.version-drift",
      "truth.claim-matrix-row-missing",
      "truth.decision-supersession-missing",
      "truth.pack-invalid",
    ] as const) {
      const template = renderTemplate(mustFind(code, "fail", "detail"), CTX);
      expect(template.kind).toBe("self-fix");
      expect(template.subject).toContain("aih:");
    }
  });

  it("dedupes by code, merges details, sorts most-urgent-first", () => {
    const findings = findingsFrom(
      [
        chk("usage.no-data", "skip", "no data"),
        chk("cli.bootloader-missing", "fail", "CLAUDE.md missing"),
        chk("cli.bootloader-missing", "fail", "AGENTS.md missing"),
        chk("secrets.plaintext-detected", "fail", ".env"),
      ],
      "report",
    );
    expect(findings.map((f) => f.severity)).toEqual(["blocking", "blocking", "optional"]);
    const bootloader = findings.find((f) => f.code === "cli.bootloader-missing");
    expect(bootloader?.details).toEqual(["CLAUDE.md missing", "AGENTS.md missing"]);
  });
});

describe("templates — external ticket (escalation)", () => {
  const t = renderTemplate(mustFind("cert.ca-missing", "fail", "NODE_EXTRA_CA_CERTS unset"), CTX);

  it("uses a tool-neutral blocking-setup subject", () => {
    expect(t.subject).toBe(
      "[acme-web] Blocking setup issue — corporate CA not trusted by development tools",
    );
    expect(isToolNeutral(t.subject)).toBe(true);
  });

  it("is tool-neutral and never leaks harness/command/path context", () => {
    expect(isToolNeutral(t.body)).toBe(true);
    for (const leak of [CTX.command, CTX.root, CTX.targets, CTX.contextDir]) {
      expect(t.body).not.toContain(leak);
    }
  });

  it("carries the full ticket structure with canned + live evidence", () => {
    for (const section of [
      "Impact",
      "Issue",
      "Observed evidence",
      "Environment",
      "Requested fix",
      "Acceptance criteria",
      "```text",
      "Affected area:  workstation certificate trust / development toolchain trust",
      "approved corporate CA is not available", // canned evidence
      "NODE_EXTRA_CA_CERTS unset", // live detail
      "No project code changes are required.", // acceptance
    ]) {
      expect(t.body).toContain(section);
    }
    for (const field of [CTX.projectName, CTX.platform, CTX.runId, CTX.timestamp]) {
      expect(t.body).toContain(field);
    }
  });

  it("appends the security work-around guard", () => {
    expect(t.body).toContain("Please do not work around this by disabling TLS verification");
  });

  it("weaves SETUP.md project context, else a default", () => {
    expect(t.body).toContain("approved dependencies"); // default
    const withCtx = renderTemplate(mustFind("tls.verify-failed", "fail", "SSL problem"), {
      ...CTX,
      projectContext: "acme-web handles cardholder data and must stay PCI-DSS compliant.",
    });
    expect(withCtx.body).toContain("PCI-DSS compliant");
  });

  it("renders real routing metadata only when provided, never invented", () => {
    expect(t.body).not.toContain("Routing:");
    const routed = renderTemplate(mustFind("cert.ca-missing", "fail", "x"), {
      ...CTX,
      routing: "Assignment group: Corp IT L2",
    });
    expect(routed.body).toContain("Routing:        Assignment group: Corp IT L2");
  });
});

describe("templates — external ticket (improvement)", () => {
  const t = renderTemplate(mustFind("mcp.uv-missing", "skip", "uv not found"), CTX);

  it("uses the improvement subject, sections, and no security footer", () => {
    expect(t.subject).toBe(
      "[acme-web] Setup improvement request — required package launcher not available",
    );
    expect(isToolNeutral(t.body)).toBe(true);
    for (const section of [
      "Why this helps",
      "Configuration gap",
      "Requested configuration",
      "Expected result",
    ]) {
      expect(t.body).toContain(section);
    }
    expect(t.body).not.toContain("Please do not work around this");
  });
});

describe("templates — internal self-fix", () => {
  it("is a terse runnable note that may name the harness", () => {
    const t = renderTemplate(mustFind("cli.bootloader-missing", "fail", "missing"), CTX);
    expect(t.subject).toBe("aih: CLI bootloader missing");
    expect(t.body).toContain("Fix: Run `aih bootstrap-ai --apply`");
    expect(t.body).toContain("Detected by `aih heal --verify`.");
  });

  it("renders byte-identically for the same inputs (deterministic)", () => {
    const f = mustFind("cli.bootloader-missing", "fail", "missing");
    expect(renderTemplate(f, CTX).body).toBe(renderTemplate(f, CTX).body);
  });
});

describe("templates — tool-neutrality sweep + pipeline", () => {
  it("keeps every external template free of the harness name", () => {
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
