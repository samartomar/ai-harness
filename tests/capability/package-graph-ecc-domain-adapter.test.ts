import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { projectBaselinePackageGraphAuthority } from "../../src/capability/package-graph/adapters/baseline.js";
import {
  projectEccCapabilityPackageAuthority,
  projectEccMcpCapabilityPackageAuthority,
  projectEccMcpReceiptAuthority,
} from "../../src/capability/package-graph/adapters/ecc-domains.js";
import { buildPackageGraphIndex } from "../../src/capability/package-graph/build.js";
import {
  explicitEccMcpReceiptRecord,
  explicitEccMcpRenderPlan,
} from "../../src/ecc/mcp-explicit-add.js";
import { receiptJson } from "../../src/ecc/mcp-explicit-add-receipt.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";

describe("ECC capability package authority projection", () => {
  it("derives granular agent, rule, and MCP packages from the exact baseline lock", () => {
    const baseline = projectBaselinePackageGraphAuthority({
      authorityId: "lock:baseline-evidence",
      catalog: baselineCatalogById("ecc"),
      lockBytes: vendorBaselineLockBytes(),
    });

    const document = projectEccCapabilityPackageAuthority({
      authorityId: "lock:ecc-capability-packages",
      baseline,
    });
    const index = buildPackageGraphIndex([document]);
    const packages = index.claims
      .filter((claim) => claim.entityKind === "package")
      .map((claim) => [claim.id, claim.entity.members] as const);

    expect(packages).toContainEqual(["package:ecc-agent/code-reviewer", ["agent:code-reviewer"]]);
    expect(packages).toContainEqual(["package:ecc-rule/rules", ["rule:ecc/rules"]]);
    expect(packages.some(([id]) => id.startsWith("package:ecc-mcp/"))).toBe(false);
    expect(
      packages.every(([, members]) =>
        members.every((member) => /^(?:agent|rule|mcp):/.test(member)),
      ),
    ).toBe(true);
    expect(document.authority.sourceDigest).toEqual(baseline.authority.sourceDigest);
  });

  it("projects only HTTPS-configurable MCP packages from the pinned ECC MCP catalog", () => {
    const document = projectEccMcpCapabilityPackageAuthority({
      authorityId: "catalog:ecc-mcp",
    });
    const index = buildPackageGraphIndex([document]);
    const packages = index.claims
      .filter((claim) => claim.entityKind === "package")
      .map((claim) => [claim.id, claim.entity.members] as const);

    expect(packages).toContainEqual(["package:ecc-mcp/memxus", ["mcp:memxus"]]);
    expect(packages.some(([id]) => id === "package:ecc-mcp/context7")).toBe(false);
    expect(document.authority.kind).toBe("catalog");
  });

  it("projects exact MCP receipt claims without creating packages", () => {
    const catalog = projectEccMcpCapabilityPackageAuthority({ authorityId: "catalog:ecc-mcp" });
    const policy = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["claude"],
        eccMcpApprovals: [
          {
            id: "memxus",
            sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
            state: "approved",
            approvedBy: "security-admin",
            authenticationMode: "api-key",
            allowedDataClasses: ["non-sensitive-context"],
          },
        ],
      },
    };
    const record = explicitEccMcpReceiptRecord(
      explicitEccMcpRenderPlan(policy, "memxus", "claude"),
    );
    const bytes = Buffer.from(
      receiptJson({ format: "aih-ecc-mcp-explicit-add", version: 1, records: [record] }),
      "utf8",
    );
    const outcome = projectEccMcpReceiptAuthority({
      authorityId: "receipt:ecc-mcp",
      receiptBytes: bytes,
      catalog,
    });

    expect(outcome.state).toBe("ready");
    if (outcome.state !== "ready") throw new Error("expected ready MCP receipt projection");
    expect(outcome.document.graph.packages).toEqual([]);
    expect(outcome.document.graph.surfaces.map(({ id }) => id)).toEqual(["mcp:memxus"]);
  });

  it("is deterministic and does not mutate the broad baseline contract", () => {
    const baseline = projectBaselinePackageGraphAuthority({
      authorityId: "lock:baseline-evidence",
      catalog: baselineCatalogById("ecc"),
      lockBytes: vendorBaselineLockBytes(),
    });
    const before = structuredClone(baseline);

    const first = projectEccCapabilityPackageAuthority({
      authorityId: "lock:ecc-capability-packages",
      baseline,
    });
    const second = projectEccCapabilityPackageAuthority({
      authorityId: "lock:ecc-capability-packages",
      baseline,
    });

    expect(first).toEqual(second);
    expect(baseline).toEqual(before);
    expect(first.graph.packages.some(({ id }) => id === "package:baseline/ecc")).toBe(false);
  });
});
