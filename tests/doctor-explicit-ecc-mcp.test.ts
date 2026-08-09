import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command } from "../src/doctor.js";
import {
  explicitEccMcpReceiptRecord,
  explicitEccMcpRenderPlan,
} from "../src/ecc/mcp-explicit-add.js";
import { emptyExplicitAddReceipt, receiptJson } from "../src/ecc/mcp-explicit-add-receipt.js";
import type { Action, PlanContext, ProbeAction } from "../src/internals/plan.js";
import { fakeRunner } from "../src/internals/proc.js";
import type { Check } from "../src/internals/verify.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../src/platform/detect.js";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "aih-doctor-explicit-ecc-mcp-root-"));
  const home = mkdtempSync(join(tmpdir(), "aih-doctor-explicit-ecc-mcp-home-"));
  paths.push(root, home);
  return { root, home };
}

function context(root: string, home: string, userProfile = home): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: userProfile };
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

function approvalPolicy(supportedClis: string[] = ["claude"]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08",
      supportedClis,
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
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
}

function writeOwnedEntry(root: string): void {
  const rendered = explicitEccMcpRenderPlan(approvalPolicy(), "memxus", "claude");
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { memxus: rendered.rendered } }),
  );
  mkdirSync(join(root, ".aih"));
  writeFileSync(
    join(root, ".aih", "ecc-mcp-explicit-add-v1.json"),
    receiptJson({
      ...emptyExplicitAddReceipt(),
      records: [explicitEccMcpReceiptRecord(rendered)],
    }),
  );
}

async function receiptChecks(root: string, home: string, userProfile = home): Promise<Check[]> {
  const built = await command.plan(context(root, home, userProfile));
  const probe = (built.actions as Action[]).find(
    (action): action is ProbeAction =>
      action.kind === "probe" && action.describe === "explicit ECC MCP receipt state",
  );
  if (probe?.runMany === undefined) throw new Error("missing explicit ECC MCP receipt-state probe");
  return probe.runMany(context(root, home, userProfile));
}

describe("doctor — explicit ECC MCP receipt state", () => {
  it("uses canonical USERPROFILE before HOME for global receipt-owned configs", async () => {
    const { root, home } = fixture();
    const userProfile = mkdtempSync(join(tmpdir(), "aih-doctor-explicit-ecc-mcp-userprofile-"));
    paths.push(userProfile);
    const rendered = explicitEccMcpRenderPlan(approvalPolicy(["gemini"]), "memxus", "gemini");
    const settings = join(userProfile, ".gemini", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ mcpServers: { memxus: rendered.rendered } }));
    mkdirSync(join(root, ".aih"));
    writeFileSync(
      join(root, ".aih", "ecc-mcp-explicit-add-v1.json"),
      receiptJson({
        ...emptyExplicitAddReceipt(),
        records: [explicitEccMcpReceiptRecord(rendered)],
      }),
    );

    await expect(receiptChecks(root, home, userProfile)).resolves.toEqual([
      expect.objectContaining({
        name: "explicit-ecc-mcp:gemini/memxus",
        verdict: "pass",
        detail: expect.stringContaining("clean:"),
      }),
    ]);
  });

  it("reports local clean, absent, altered, revoked, malformed, and unsafe-path receipt states per target", async () => {
    const clean = fixture();
    writeOwnedEntry(clean.root);
    await expect(receiptChecks(clean.root, clean.home)).resolves.toEqual([
      expect.objectContaining({
        name: "explicit-ecc-mcp:claude/memxus",
        verdict: "pass",
        detail: expect.stringContaining("clean: receipt-owned entry is unchanged"),
      }),
    ]);

    const absent = fixture();
    writeOwnedEntry(absent.root);
    writeFileSync(join(absent.root, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    await expect(receiptChecks(absent.root, absent.home)).resolves.toEqual([
      expect.objectContaining({ verdict: "fail", detail: expect.stringContaining("absent:") }),
    ]);

    const altered = fixture();
    writeOwnedEntry(altered.root);
    writeFileSync(
      join(altered.root, ".mcp.json"),
      JSON.stringify({ mcpServers: { memxus: { type: "http", url: "https://changed.example" } } }),
    );
    await expect(receiptChecks(altered.root, altered.home)).resolves.toEqual([
      expect.objectContaining({ verdict: "fail", detail: expect.stringContaining("altered:") }),
    ]);

    const revoked = fixture();
    writeOwnedEntry(revoked.root);
    const receiptPath = join(revoked.root, ".aih", "ecc-mcp-explicit-add-v1.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.records[0].config.renderedSha256 = `sha256:${"0".repeat(64)}`;
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    await expect(receiptChecks(revoked.root, revoked.home)).resolves.toEqual([
      expect.objectContaining({ verdict: "fail", detail: expect.stringContaining("revoked:") }),
    ]);

    const malformed = fixture();
    mkdirSync(join(malformed.root, ".aih"));
    writeFileSync(join(malformed.root, ".aih", "ecc-mcp-explicit-add-v1.json"), "{ malformed");
    await expect(receiptChecks(malformed.root, malformed.home)).resolves.toEqual([
      expect.objectContaining({ verdict: "fail", detail: expect.stringContaining("malformed:") }),
    ]);

    const unsafe = fixture();
    writeOwnedEntry(unsafe.root);
    const external = mkdtempSync(join(tmpdir(), "aih-doctor-explicit-ecc-mcp-external-"));
    paths.push(external);
    writeFileSync(join(external, "mcp.json"), "{}");
    rmSync(join(unsafe.root, ".mcp.json"));
    symlinkSync(join(external, "mcp.json"), join(unsafe.root, ".mcp.json"), "file");
    await expect(receiptChecks(unsafe.root, unsafe.home)).resolves.toEqual([
      expect.objectContaining({ verdict: "fail", detail: expect.stringContaining("unsafe-path:") }),
    ]);
  });
});
