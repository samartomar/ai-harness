/**
 * The engine's Additions feature (acceptance rule section 7, rows 15, 16, 17):
 * the rules and messages of `ui/shell/acme-screen.ts`, headlessly. The intent
 * is ported from `new-shell-acme.test.ts` (ECC MCP approvals, curation edit
 * state) and from the form handlers those DOM tests exercise.
 */
import { describe, expect, it } from "vitest";
import {
  type AdminEngine,
  type CurationInputV1,
  createAdminEngine,
} from "../../../src/org-policy/workbench/engine/index.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

function engineFor(model: unknown): AdminEngine {
  const created = createAdminEngine(model);
  if (!created.ok) throw new Error(created.errors.join("; "));
  return created.value;
}

function fixture(): AdminEngine {
  return engineFor(tinyStudioModel());
}

function withApproval(): AdminEngine {
  const model = tinyStudioModel();
  const catalog = model.catalog as unknown as {
    externalMcp: unknown[];
    eccMcpApproval: { sourceContentSha256: string };
  };
  catalog.externalMcp = [{ id: "jira", addability: "https-configurable" }];
  (model.initialPolicy.governance as unknown as Record<string, unknown>).eccMcpApprovals = [
    {
      id: "jira",
      sourceContentSha256: catalog.eccMcpApproval.sourceContentSha256,
      state: "approved",
      approvedBy: "owner@company.example",
      authenticationMode: HOSTILE,
      allowedDataClasses: ["issue-metadata"],
    },
  ];
  return engineFor(model);
}

const CURATION: CurationInputV1 = {
  framework: "ecc",
  kind: "agent",
  id: "review-agent",
  accountableOwner: "framework.owner@acme.example",
  repository: "acme/catalog",
  commit: "a".repeat(40),
  path: "agents/review.md",
  auditRecord: "audit-2026-08",
  auditDigest: `sha256:${"b".repeat(64)}`,
  clarification: "",
};

describe("engine additions: framework curation (row 16)", () => {
  it("lists the catalog's framework owners in the hand-built words", () => {
    expect(fixture().additions().frameworks).toEqual([
      { id: "ecc", label: "ECC - external guidance" },
    ]);
  });

  it("adds, edits and removes one curation item with the legacy messages", () => {
    const engine = fixture();
    expect(engine.saveCuration(CURATION)).toEqual({
      ok: true,
      message: "External curation intent added; it is report-only and not enforced by AIH.",
    });
    const added = engine.additions();
    expect(added.curationRows.map((row) => row.label)).toEqual(["ecc: agent / review-agent"]);
    expect(added.counts.curation).toBe(1);

    const target = { framework: "ecc", kind: "agent", id: "review-agent" };
    expect(
      engine.saveCuration({ ...CURATION, clarification: "reviewed by platform" }, target),
    ).toEqual({
      ok: true,
      message: "External curation intent updated; it is report-only and not enforced by AIH.",
    });
    expect(engine.additions().curationRows[0]?.detail).toContain(
      "Clarification: reviewed by platform",
    );

    expect(engine.removeCuration(target)).toEqual({
      ok: true,
      message: "External curation intent removed.",
    });
    expect(engine.additions().curationRows).toEqual([]);
  });

  it("refuses an incomplete item with the field message and changes nothing", () => {
    const engine = fixture();
    const before = engine.state().policyText;
    const empty = engine.saveCuration({ ...CURATION, id: "" });
    expect(empty).toMatchObject({
      ok: false,
      message:
        "Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",
      fieldErrors: [{ field: "curation-id", message: "Use an external item identifier." }],
    });
    expect(engine.saveCuration({ ...CURATION, commit: "abc" }).fieldErrors).toEqual([
      { field: "curation-id", message: "Correct the curation fields before adding." },
    ]);
    // The path rule of the hand-built form: no absolute, dotted or doubled path.
    for (const path of ["/agents/a.md", "./a.md", "a//b.md", "a/../b.md", ""])
      expect(engine.saveCuration({ ...CURATION, path }).ok).toBe(false);
    expect(engine.state().policyText).toBe(before);
  });

  it("refuses a duplicate kind/id pair in the same framework", () => {
    const engine = fixture();
    expect(engine.saveCuration(CURATION).ok).toBe(true);
    expect(engine.saveCuration(CURATION)).toEqual({
      ok: false,
      message: "That external curation item is already present.",
    });
    expect(engine.additions().counts.curation).toBe(1);
  });
});

describe("engine additions: custom and remote MCP (row 17)", () => {
  const custom = {
    id: "acme-mcp",
    accountableOwner: "owner@acme.example",
    packageName: "acme-mcp",
    version: "1.2.3",
    integrity: `sha256:${"c".repeat(64)}`,
    evidence: "acme-mcp-scan",
    clarification: "",
  };

  it("records a fully pinned pending custom MCP that cannot be activated", () => {
    const engine = fixture();
    expect(engine.addCustomMcp(custom)).toEqual({
      ok: true,
      message: "Pending custom MCP added. It cannot be activated.",
    });
    const row = engine.additions().customRows[0];
    expect(row?.kind).toBe("custom");
    expect(row?.badge).toBe("Blocked - evidence owed at this pin");
    expect(row?.detail).toContain("aih trust scan acme-mcp@1.2.3");
    expect(row?.note).toBe("Pinned custom source - no activation affordance");
    expect(engine.additions().counts.customMcp).toBe(1);

    expect(engine.addCustomMcp(custom)).toEqual({
      ok: false,
      message: "Custom candidate identifier already exists.",
    });
    expect(engine.removeCustomCandidate("acme-mcp", "custom")).toEqual({
      ok: true,
      message: "Custom candidate removed.",
    });
    expect(engine.additions().customRows).toEqual([]);
  });

  it("refuses a custom MCP without an accountable owner email", () => {
    const engine = fixture();
    expect(engine.addCustomMcp({ ...custom, accountableOwner: "nobody" })).toEqual({
      ok: false,
      message: "Use an accountable owner email address for the pending custom MCP.",
      fieldErrors: [{ field: "custom-owner", message: "Use an accountable owner email address." }],
    });
    expect(engine.additions().customRows).toEqual([]);
  });

  const remote = {
    id: "acme-remote",
    origin: "https://mcp.acme.example",
    approvedBy: "owner@acme.example",
    authenticationMode: "oauth",
    allowedDataClasses: "issue-metadata, design-metadata",
    administrativeStatus: "approved",
    evidence: "acme-remote-scan",
    clarification: "",
  };

  it("records a fenced remote MCP and keeps it non-projectable", () => {
    const engine = fixture();
    expect(engine.saveRemoteMcp(remote)).toEqual({
      ok: true,
      message:
        "Pending remote MCP recorded. It remains fenced and does not activate or contact the endpoint.",
    });
    const row = engine.additions().customRows[0];
    expect(row?.kind).toBe("remote");
    expect(row?.detail).toBe(
      "Remote origin: https://mcp.acme.example · Administrative status: approved · Content scan: none · Accountable owner: owner@acme.example",
    );
    expect(row?.remote?.allowedDataClasses).toBe("issue-metadata, design-metadata");
    expect(engine.additions().counts.remoteMcp).toBe(1);
  });

  it("refuses an origin that is not an exact HTTPS origin", () => {
    const engine = fixture();
    for (const origin of [
      "http://mcp.acme.example",
      "https://mcp.acme.example/path",
      "https://user:pass@mcp.acme.example",
      "https://mcp.acme.example/?q=1",
      "not a url",
    ])
      expect(engine.saveRemoteMcp({ ...remote, origin })).toEqual({
        ok: false,
        message: "Correct the highlighted remote-endpoint fields.",
        fieldErrors: [
          {
            field: "remote-custom-origin",
            message: "Use an exact HTTPS origin without a path, credentials, query, or fragment.",
          },
        ],
      });
    expect(engine.additions().customRows).toEqual([]);
  });

  it("refuses hidden Unicode in a remote clarification and an unknown status", () => {
    const engine = fixture();
    expect(engine.saveRemoteMcp({ ...remote, clarification: "a​b" }).ok).toBe(false);
    expect(engine.saveRemoteMcp({ ...remote, administrativeStatus: "maybe" }).ok).toBe(false);
    expect(engine.saveRemoteMcp({ ...remote, allowedDataClasses: "  ,  " }).ok).toBe(false);
    expect(engine.additions().customRows).toEqual([]);
  });

  it("explains a preserved remote declaration instead of changing it", () => {
    expect(fixture().readPreservedRemote()).toEqual({
      ok: true,
      message:
        "This remote declaration is preserved read-only; record a new administrative declaration to change it.",
    });
  });
});

describe("engine additions: ECC MCP approval (row 15)", () => {
  it("lists pinned entries and recorded approvals as values, never markup", () => {
    const view = withApproval().additions();
    expect(view.eccPinned).toEqual([{ id: "jira", label: "jira — https-configurable" }]);
    expect(view.eccApprovals).toEqual([
      { id: "jira", state: "approved", authenticationMode: HOSTILE },
    ]);
    expect(view.counts.eccApprovals).toBe(1);
  });

  it("removes one recorded approval with the legacy message", () => {
    const engine = withApproval();
    expect(engine.removeEccMcpApproval("jira")).toEqual({
      ok: true,
      message: "ECC MCP approval removed for jira.",
    });
    expect(engine.additions().eccApprovals).toEqual([]);
    const policy = JSON.parse(engine.state().policyText) as {
      governance: { eccMcpApprovals?: unknown[] };
    };
    expect(policy.governance.eccMcpApprovals ?? []).toEqual([]);
  });

  it("announces a pinned selection and refuses an id that is not pinned", () => {
    const engine = withApproval();
    expect(engine.selectEccMcp("jira")).toEqual({
      ok: true,
      message:
        "ECC MCP jira selected for approval authoring only; it is not installed or contacted.",
    });
    expect(engine.selectEccMcp("not-pinned")).toEqual({
      ok: false,
      message: "Unknown pinned ECC MCP: not-pinned",
    });
  });
});

describe("engine additions: malformed input never throws", () => {
  it("returns an error result for values of the wrong shape", () => {
    const engine = fixture();
    const bad = { framework: 1, kind: null, id: undefined } as unknown as CurationInputV1;
    expect(engine.saveCuration(bad).ok).toBe(false);
    expect(engine.addCustomMcp({} as never).ok).toBe(false);
    expect(engine.saveRemoteMcp({} as never).ok).toBe(false);
    expect(engine.removeCustomCandidate("missing", "custom").ok).toBe(false);
  });
});
