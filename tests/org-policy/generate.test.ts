import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyGenerateCommand } from "../../src/org-policy/generate.js";
import {
  canonicalGovernanceDecisionV1,
  governanceDecisionDigestV1,
  parseGovernanceDecisionV1,
} from "../../src/org-policy/governance-decision-v1.js";
import {
  defaultStudioPolicy,
  exportStudioDecision,
  exportStudioPolicy,
  parseStudioDecisionImport,
  parseStudioPolicyImport,
  policyStudioModel,
} from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;

/**
 * FileReader resolves on its own schedule, so a fixed sleep is a race the suite
 * outgrew: these waits passed alone and failed once the file count rose. Poll
 * the condition instead, with the old delay as the ceiling rather than the bet.
 */
async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-policy-generate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

const sha = (character: string) => `sha256:${character.repeat(64)}`;

function governanceDecision(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-governance-decision",
    version: 1,
    id: "decision-workbench",
    disposition: "accepted-with-conditions",
    candidate: "code-review-graph",
    kind: "mcp",
    targets: ["claude"],
    effects: ["managed-settings"],
    policyVersion: "2026.08",
    sourceDigest: sha("a"),
    evidenceDigest: sha("b"),
    reviewedControlDigest: sha("c"),
    issuer: "platform-security",
    actor: "security-admin",
    reason: "<img src=x onerror=alert(1)> Decision reason",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    reviewBy: "2026-08-05T00:00:00+00:00",
    acceptedFindings: ["prompt-injection"],
    acceptedGaps: [],
    conditions: ["<img src=x onerror=alert(1)> Review before expiry"],
    ...overrides,
  };
}

function loadStudio(window: Window, html: string, setup = ""): void {
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0 || scripts.some((script) => script === undefined)) {
    throw new Error("expected generated workbench script");
  }
  window.eval(`${scripts.join("\n")}\n${setup}`);
}

function fullAuthoringPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08",
      supportedClis: ["claude"],
      catalog: {
        reviewed: [],
        custom: [
          {
            id: "custom-mcp",
            kind: "mcp",
            description: "Pinned custom MCP candidate",
            capabilities: ["documentation lookup"],
            risks: ["external egress"],
            source: {
              type: "stdio",
              resolver: "npx",
              registry: "https://registry.npmjs.org",
              package: "@example/custom-mcp",
              version: "1.2.3",
              integrity: sha("a"),
            },
            targets: ["claude"],
            projector: "mcp-managed-settings",
            lifecycle: "supported",
            evidence: { record: "audit-2026-08" },
            clarification: "Candidate is retained for evaluation.",
            annotation: "Admin supplied note.",
          },
        ],
      },
      activations: [],
      authority: {
        approvals: [
          {
            id: "gap-approval",
            candidate: "custom-mcp",
            kind: "mcp",
            source: {
              type: "stdio",
              resolver: "npx",
              registry: "https://registry.npmjs.org",
              package: "@example/custom-mcp",
              version: "1.2.3",
              integrity: sha("a"),
            },
            issuer: "security-admin",
            sourceDigest: sha("b"),
            evidenceDigest: sha("c"),
            projector: "mcp-managed-settings",
            policyVersion: "2026.08",
            reason: "Time-bounded evidence gap approval.",
            clarification: "Follow-up review is required before expiry.",
            scope: ["claude"],
            notBefore: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-08-31T00:00:00.000Z",
            github: {
              repository: "acme/governance",
              attestationId: "github-attestation-123",
              subjectDigest: sha("d"),
            },
          },
        ],
      },
      externalCuration: [
        {
          framework: "ecc",
          items: [
            {
              kind: "agent",
              id: "security-review-agent",
              source: {
                repository: "acme/ecc-catalog",
                commit: "e".repeat(40),
                path: "agents/review.md",
              },
              audit: { record: "audit-2026-08", digest: sha("e") },
              clarification: "External guidance only.",
            },
            {
              kind: "skill",
              id: "threat-modeling",
              source: {
                repository: "acme/ecc-catalog",
                commit: "e".repeat(40),
                path: "skills/threat-modeling.md",
              },
              audit: { record: "audit-2026-08", digest: sha("f") },
            },
            {
              kind: "command",
              id: "review-command",
              source: {
                repository: "acme/ecc-catalog",
                commit: "e".repeat(40),
                path: "commands/review.md",
              },
              audit: { record: "audit-2026-08", digest: sha("a") },
            },
          ],
        },
      ],
    },
  };
}

function policyWithCommandArgument(
  argument: string,
  sourceRegistry?: string,
): Record<string, unknown> {
  const policy = fullAuthoringPolicy();
  const governance = policy.governance as {
    catalog: { custom: Array<Record<string, unknown>> };
  };
  if (sourceRegistry !== undefined) {
    const existingCustom = governance.catalog.custom[0];
    if (existingCustom === undefined) throw new Error("expected custom candidate fixture");
    (existingCustom.source as { registry?: string }).registry = sourceRegistry;
  }
  governance.catalog.custom.push({
    id: "external-command-candidate",
    kind: "framework",
    description: "External command guidance",
    capabilities: [],
    risks: [],
    source: {
      type: "command",
      command: "npx",
      args: [argument],
      executableDigest: sha("f"),
    },
    targets: ["claude"],
    projector: "framework-contract",
    lifecycle: "supported",
    evidence: { record: "audit-2026-08" },
    framework: "ecc",
    autoExecute: false,
  });
  return policy;
}

function policyWithoutGovernance(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
  };
}

function baselineOverride(bundle: string, approvedAt = "2026-08-01T00:00:00.000Z") {
  return {
    catalog: "ecc",
    owner: "acme",
    repo: "catalog",
    pinnedSha: "a".repeat(40),
    bundle,
    signingRepository: "acme/governance",
    reason: "Signed override",
    reviewer: "security-admin",
    approvedAt,
  };
}

describe("policy generate", () => {
  it("creates a portable workbench in a temporary fixture without inspecting a repository", async () => {
    const context = ctx({ apply: true });
    const planned = await policyGenerateCommand.plan(context);
    const write = planned.actions.find((action) => action.kind === "write");
    expect(write).toMatchObject({ path: "aih-policy-workbench.html" });
    expect(write?.kind === "write" ? write.contents : "").toContain("AIH Policy Workbench");
    await executePlan(planned, context, { skipWorktreeGate: true });

    const artifact = readFileSync(join(dir, "aih-policy-workbench.html"), "utf8");
    expect(artifact).toContain("portable intent without repository access");
    expect(artifact).toContain("ECC / Superpowers curation");
    expect(artifact).not.toMatch(/gstack/i);
  });

  it("uses the actual policy grammar for exact semantic import/export", () => {
    const imported = parseStudioPolicyImport(JSON.stringify(fullAuthoringPolicy()));
    const reparsed = parseStudioPolicyImport(exportStudioPolicy(imported));
    expect(reparsed).toEqual(imported);
    expect(reparsed.governance?.externalCuration[0]?.items.map((item) => item.kind)).toEqual([
      "agent",
      "skill",
      "command",
    ]);
    expect(reparsed.governance?.authority.approvals[0]?.clarification).toContain("Follow-up");
    expect(() => parseStudioPolicyImport('{"schemaVersion":2,"unknown":true}')).toThrow();
    const unsafe = fullAuthoringPolicy();
    const curation = (
      unsafe.governance as {
        externalCuration: Array<{ items: Array<{ source: { path: string } }> }>;
      }
    ).externalCuration[0];
    if (curation === undefined) throw new Error("expected external curation fixture");
    const firstCurationItem = curation.items[0];
    if (firstCurationItem === undefined) throw new Error("expected external curation item");
    firstCurationItem.source.path = "../unsafe.md";
    expect(() => parseStudioPolicyImport(JSON.stringify(unsafe))).toThrow(/safe repo-relative/i);
  });

  it("round-trips one standalone governance decision through canonical UI-only transport", () => {
    const decision = parseStudioDecisionImport(JSON.stringify(governanceDecision()));
    const exported = exportStudioDecision(decision);
    expect(exported).toBe(`${canonicalGovernanceDecisionV1(decision)}\n`);
    const reparsed = parseStudioDecisionImport(exported);
    expect(reparsed).toEqual(decision);
    expect(governanceDecisionDigestV1(reparsed)).toBe(governanceDecisionDigestV1(decision));
  });

  it("keeps standalone decision import strict, inert, and parity-checked in the browser", async () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    const decisionFile = document.getElementById("decision-file");
    if (decisionFile === null) throw new Error("expected decision file input");
    const configPreview = document.getElementById("config-preview") as unknown as { value: string };
    const policyPreview = configPreview.value;
    const importDecision = async (value: unknown) => {
      const announcement = document.getElementById("announcement");
      if (announcement !== null) announcement.textContent = "";
      Object.defineProperty(decisionFile, "files", {
        configurable: true,
        value: [
          new window.File([JSON.stringify(value)], "decision.json", { type: "application/json" }),
        ],
      });
      decisionFile.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle(
        window,
        () => (document.getElementById("announcement")?.textContent ?? "") !== "",
      );
    };
    const policyBefore = exportStudioPolicy(defaultStudioPolicy());
    const valid = governanceDecision();
    expect(() => parseGovernanceDecisionV1(valid)).not.toThrow();
    await importDecision(valid);
    expect(document.getElementById("decision-state")?.textContent).toContain("imported");
    expect(document.getElementById("decision-state")?.textContent).toContain("unverified");
    expect(document.getElementById("decision-state")?.textContent).toContain("not effective");
    expect(document.getElementById("decision-rows")?.textContent).toContain("decision-workbench");
    expect(document.querySelector("#decision-rows img")).toBeNull();
    expect(document.getElementById("decision-rows")?.innerHTML).toContain("&lt;img");
    expect(document.getElementById("decision-export")?.textContent).toBe(
      canonicalGovernanceDecisionV1(parseGovernanceDecisionV1(valid)),
    );
    expect(configPreview.value).toBe(policyPreview);
    expect(policyPreview).not.toContain("decision-workbench");
    expect(exportStudioPolicy(defaultStudioPolicy())).toBe(policyBefore);

    const adversaries = [
      null,
      { ...valid, format: "other" },
      { ...valid, version: 2 },
      { ...valid, unknown: true },
      { ...valid, id: "not-a-decision-id" },
      { ...valid, sourceDigest: "sha256:ABC" },
      { ...valid, issuedAt: "2026-08-32T00:00:00+00:00" },
      { ...valid, notBefore: "2026-07-31T00:00:00+00:00" },
      { ...valid, reviewBy: "2026-08-11T00:00:00+00:00" },
      { ...valid, targets: ["kiro", "claude"] },
      { ...valid, acceptedFindings: ["prompt-injection", "prompt-injection"] },
      { ...valid, acceptedGaps: ["prompt-injection"] },
      { ...valid, conditions: [] },
      { ...valid, conditions: [["nested"]] },
    ];
    for (const adversary of adversaries) {
      const accepted = (() => {
        try {
          parseGovernanceDecisionV1(adversary);
          return true;
        } catch {
          return false;
        }
      })();
      expect(accepted).toBe(false);
      await importDecision(adversary);
      expect(document.getElementById("announcement")?.textContent).toContain(
        "Decision import rejected",
      );
      expect(document.getElementById("decision-rows")?.textContent).toContain("decision-workbench");
    }

    const maxLengthApproved = {
      ...valid,
      id: `decision-${"a".repeat(55)}`,
      disposition: "approved",
      acceptedFindings: [],
      acceptedGaps: [],
      conditions: [],
    };
    delete (maxLengthApproved as Record<string, unknown>).reviewBy;
    const rejected = {
      ...maxLengthApproved,
      id: "decision-rejected-browser",
      disposition: "rejected",
    };
    expect(() => parseGovernanceDecisionV1(maxLengthApproved)).not.toThrow();
    expect(() => parseGovernanceDecisionV1(rejected)).not.toThrow();
    await importDecision(maxLengthApproved);
    expect(document.getElementById("decision-rows")?.textContent).toContain(maxLengthApproved.id);
    await importDecision(rejected);
    expect(document.getElementById("decision-rows")?.textContent).toContain(
      "decision-rejected-browser",
    );
  });

  it("keeps decision import deterministic across out-of-order file reads", async () => {
    const window = new Window({ url: "http://localhost/" });
    const readers: Array<{
      result: string | null;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      onabort: (() => void) | null;
      complete: (text: string) => void;
      fail: () => void;
      abort: () => void;
    }> = [];
    class ControlledFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsText(): void {
        readers.push(this);
      }

      complete(text: string): void {
        this.result = text;
        this.onload?.();
      }

      fail(): void {
        this.onerror?.();
      }

      abort(): void {
        this.onabort?.();
      }
    }
    Object.defineProperty(window, "FileReader", {
      configurable: true,
      value: ControlledFileReader,
    });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    const decisionFile = document.getElementById("decision-file");
    if (decisionFile === null) throw new Error("expected decision file input");
    const select = (value: unknown) => {
      Object.defineProperty(decisionFile, "files", {
        configurable: true,
        value: [
          new window.File([JSON.stringify(value)], "decision.json", { type: "application/json" }),
        ],
      });
      decisionFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    const initial = governanceDecision({ id: "decision-initial" });
    select(initial);
    readers[0]?.complete(JSON.stringify(initial));
    await settle(window, () =>
      (document.getElementById("decision-rows")?.textContent ?? "").includes("decision-initial"),
    );

    const older = governanceDecision({ id: "decision-older" });
    const newest = governanceDecision({ id: "decision-newest" });
    select(older);
    select(newest);
    readers[2]?.complete(JSON.stringify(newest));
    await settle(window, () =>
      (document.getElementById("decision-rows")?.textContent ?? "").includes("decision-newest"),
    );
    readers[1]?.complete(JSON.stringify(older));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.getElementById("decision-rows")?.textContent).toContain("decision-newest");

    const inFlightOlder = governanceDecision({ id: "decision-in-flight" });
    const invalidNewest = { ...newest, version: 2 };
    select(inFlightOlder);
    select(invalidNewest);
    readers[3]?.complete(JSON.stringify(inFlightOlder));
    readers[4]?.complete(JSON.stringify(invalidNewest));
    await settle(window, () =>
      (document.getElementById("announcement")?.textContent ?? "").includes(
        "Decision import rejected",
      ),
    );
    expect(document.getElementById("decision-rows")?.textContent).toContain("decision-newest");

    select(governanceDecision({ id: "decision-stale-read-error" }));
    select(governanceDecision({ id: "decision-latest-read-error" }));
    readers[5]?.fail();
    readers[6]?.fail();
    await settle(window, () =>
      (document.getElementById("announcement")?.textContent ?? "").includes(
        "Decision import rejected: unable to read decision file",
      ),
    );
    expect(document.getElementById("announcement")?.textContent).toContain(
      "Decision import rejected: unable to read decision file",
    );
    expect(document.getElementById("decision-rows")?.textContent).toContain("decision-newest");

    select(governanceDecision({ id: "decision-latest-read-abort" }));
    readers[7]?.abort();
    await settle(window, () =>
      (document.getElementById("announcement")?.textContent ?? "").includes(
        "Decision import rejected: unable to read decision file",
      ),
    );
    expect(document.getElementById("announcement")?.textContent).toContain(
      "Decision import rejected: unable to read decision file",
    );
    expect(document.getElementById("decision-rows")?.textContent).toContain("decision-newest");
  });

  it("preserves valid optional governance absence and rejects root trust refinements in browser import", async () => {
    const noGovernance = policyWithoutGovernance();
    expect(parseStudioPolicyImport(JSON.stringify(noGovernance))).toEqual(noGovernance);
    const invalidPolicies = [
      {
        ...policyWithoutGovernance(),
        trust: { baselineOverrides: [baselineOverride("../unsafe.md")] },
      },
      {
        ...policyWithoutGovernance(),
        trust: { baselineOverrides: [baselineOverride("catalog/override.md", "invalid-time")] },
      },
    ];
    for (const policy of invalidPolicies) {
      expect(() => parseStudioPolicyImport(JSON.stringify(policy))).toThrow();
    }
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const policyFile = window.document.getElementById("policy-file");
    if (policyFile === null) throw new Error("expected policy file input");
    const importPolicy = async (policy: Record<string, unknown>) => {
      const announcement = window.document.getElementById("announcement");
      if (announcement !== null) announcement.textContent = "";
      Object.defineProperty(policyFile, "files", {
        configurable: true,
        value: [
          new window.File([JSON.stringify(policy)], "policy.json", { type: "application/json" }),
        ],
      });
      policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle(
        window,
        () => (window.document.getElementById("announcement")?.textContent ?? "") !== "",
      );
    };
    await importPolicy(noGovernance);
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "without transformation",
    );
    expect(
      JSON.parse(
        (window.document.getElementById("config-preview") as unknown as { value: string }).value,
      ),
    ).toEqual(noGovernance);
    window.document
      .getElementById("add-curation")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "Correct the highlighted curation fields.",
    );
    window.document
      .getElementById("validate")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      "validation passed",
    );
    expect(
      JSON.parse(
        (window.document.getElementById("config-preview") as unknown as { value: string }).value,
      ),
    ).toEqual(noGovernance);
    for (const policy of invalidPolicies) {
      await importPolicy(policy);
      expect(window.document.getElementById("announcement")?.textContent).toContain(
        "Policy import rejected",
      );
    }
  });

  it("round-trips administrator-managed remote status without inventing legacy drift fields", async () => {
    const imported = fullAuthoringPolicy();
    const governance = imported.governance as {
      catalog: { custom: Array<Record<string, unknown>> };
    };
    governance.catalog.custom.push({
      id: "figma-remote",
      kind: "mcp",
      description: "Approved hosted design MCP",
      capabilities: [],
      risks: ["hosted endpoint"],
      source: {
        type: "remote",
        origin: "https://mcp.figma.com",
        approval: {
          approvedBy: "approver@example.com",
          authenticationMode: "oauth",
          allowedDataClasses: ["design-metadata"],
        },
        administrativeStatus: "approved",
        contentScanned: false,
      },
      targets: ["claude"],
      projector: "mcp-managed-settings",
      lifecycle: "supported",
      evidence: { record: "audit-remote-2026" },
    });

    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    const policyFile = document.getElementById("policy-file");
    if (policyFile === null) throw new Error("expected policy file input");
    Object.defineProperty(policyFile, "files", {
      configurable: true,
      value: [
        new window.File([JSON.stringify(imported)], "remote-policy.json", {
          type: "application/json",
        }),
      ],
    });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      Boolean(
        document.getElementById("announcement")?.textContent?.includes("without transformation"),
      ),
    );

    document
      .querySelector('[data-workbench-action="edit"][data-workbench-kind="remote"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const status = document.getElementById("remote-custom-administrative-status") as unknown as {
      value: string;
    } | null;
    expect(status?.value).toBe("approved");
    expect(document.getElementById("remote-custom-tool-surface-digest")).toBeNull();
    expect(document.getElementById("remote-custom-verdict")).toBeNull();
    if (status === null) throw new Error("expected administrative status select");
    status.value = "revoked";
    document
      .getElementById("remote-custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    const exported = JSON.parse(
      (document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as {
      governance: { catalog: { custom: Array<{ id: string; source: Record<string, unknown> }> } };
    };
    const remote = exported.governance.catalog.custom.find((item) => item.id === "figma-remote");
    expect(remote?.source).toMatchObject({
      type: "remote",
      origin: "https://mcp.figma.com",
      administrativeStatus: "revoked",
      contentScanned: false,
    });
    expect(remote?.source).not.toHaveProperty("toolSurfaceDigest");
    expect(remote?.source).not.toHaveProperty("verdict");
    expect(document.getElementById("custom-rows")?.textContent).toContain(
      "Administrative status: revoked",
    );
    expect(document.getElementById("custom-rows")?.textContent).toContain("Content scan: none");

    const legacy = structuredClone(imported);
    const legacyRemote = (
      legacy.governance as {
        catalog: { custom: Array<{ id: string; source: Record<string, unknown> }> };
      }
    ).catalog.custom.find((item) => item.id === "figma-remote");
    if (legacyRemote === undefined) throw new Error("expected legacy remote fixture");
    legacyRemote.source = {
      type: "remote",
      origin: "https://mcp.figma.com",
      approval: {
        approvedBy: "security-admin",
        authenticationMode: "oauth",
        allowedDataClasses: ["design-metadata"],
      },
      toolSurfaceDigest: sha("d"),
      verdict: "drifted",
      contentScanned: false,
    };
    Object.defineProperty(policyFile, "files", {
      configurable: true,
      value: [new window.File([JSON.stringify(legacy)], "legacy-remote-policy.json")],
    });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      Boolean(
        (
          document.getElementById("config-preview") as unknown as { value?: string } | null
        )?.value?.includes('"verdict": "drifted"'),
      ),
    );
    const readOnly = document.querySelector(
      '[data-workbench-action="readonly"][data-workbench-kind="remote"]',
    );
    expect(readOnly).not.toBeNull();
    readOnly?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("announcement")?.textContent).toContain("preserved read-only");
    const preserved = JSON.parse(
      (document.getElementById("config-preview") as unknown as { value: string }).value,
    ) as {
      governance: { catalog: { custom: Array<{ id: string; source: Record<string, unknown> }> } };
    };
    expect(
      preserved.governance.catalog.custom.find((item) => item.id === "figma-remote")?.source,
    ).toEqual(legacyRemote.source);
  });

  it("derives catalog data and embeds all authored workbench surfaces without persistent catalog prose", () => {
    const model = policyStudioModel();
    expect(model.catalog.mcp.length).toBeGreaterThan(0);
    const assets = model.catalog.frameworks.flatMap((framework) => framework.assets);
    // Inventory kinds span the whole component-id namespace; the three-kind
    // vocabulary belongs to external curation and is carried separately.
    expect(assets.map((asset) => asset.kind)).toEqual(
      expect.arrayContaining(["agent", "skill", "module", "lang", "framework", "capability"]),
    );
    expect(assets.flatMap((asset) => asset.curationKind ?? [])).toEqual(
      expect.arrayContaining(["agent", "skill", "command"]),
    );
    const html = policyStudioHtml(model);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).toContain("Escape");
    expect(html).toContain("Blocked - evidence owed at this pin");
    expect(html).toContain("report-only and not enforced by AIH");
    expect(html).toContain("Preserve approval subjects in policy (not effective)");
    expect(html).toContain("summary{cursor:pointer");
    expect(html).toContain("min-height:28px");
    expect(html).toContain("const unsafePath=");
    expect(html).not.toMatch(/gstack/i);
  });

  it("has semantic controls and a usable accessible help interaction in the generated DOM", () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    expect(document.querySelector("main#workbench")).not.toBeNull();
    expect(document.querySelectorAll("section.group").length).toBeGreaterThanOrEqual(6);
    expect(document.querySelector("button#add-curation")).not.toBeNull();
    expect(document.querySelector("textarea#config-preview")).not.toBeNull();
    expect(document.querySelector("textarea#report-preview")).not.toBeNull();
    expect(document.querySelector("summary button, summary input, summary select")).toBeNull();
    const help = document.querySelector("button[data-tooltip-button]");
    const describedBy = help?.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.getAttribute("role")).toBe("tooltip");
    expect(document.querySelector(".tooltip")?.getAttribute("role")).toBe("tooltip");
    help?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(
      document
        .getElementById(help?.getAttribute("aria-describedby") ?? "")
        ?.getAttribute("data-open"),
    ).toBe("true");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(
      document
        .getElementById(help?.getAttribute("aria-describedby") ?? "")
        ?.getAttribute("data-open"),
    ).toBe("false");
    expect(help?.getAttribute("aria-expanded")).toBe("false");
    expect(
      Array.from(document.querySelectorAll("[tabindex]")).map((element) =>
        element.getAttribute("tabindex"),
      ),
    ).toEqual(["-1"]);
    expect(defaultStudioPolicy().governance?.externalCuration).toEqual([]);
  });

  it("rejects invalid browser imports and invalid authored custom text before it can become downloadable policy", async () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    const policyFile = document.getElementById("policy-file");
    if (policyFile === null) throw new Error("expected policy file input");
    const invalid = new window.File(
      [
        JSON.stringify({
          schemaVersion: 2,
          minimumPosture: "vibe",
          references: { repoContract: "ai-coding/project.json", invented: true },
        }),
      ],
      "invalid-policy.json",
      { type: "application/json" },
    );
    Object.defineProperty(policyFile, "files", { configurable: true, value: [invalid] });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      (document.getElementById("announcement")?.textContent ?? "").includes(
        "Policy import rejected",
      ),
    );
    expect(document.getElementById("announcement")?.textContent).toContain(
      "Policy import rejected",
    );
    expect(
      (document.getElementById("config-preview") as unknown as { value?: string } | null)?.value,
    ).not.toContain("invented");

    const unsafeCuration = fullAuthoringPolicy();
    const curation = (
      unsafeCuration.governance as {
        externalCuration: Array<{ items: Array<{ source: { path: string } }> }>;
      }
    ).externalCuration[0];
    if (curation === undefined) throw new Error("expected external curation fixture");
    const curationItem = curation.items[0];
    if (curationItem === undefined) throw new Error("expected external curation item");
    curationItem.source.path = "agents\\review.md";
    const unsafeFile = new window.File([JSON.stringify(unsafeCuration)], "unsafe-path.json", {
      type: "application/json",
    });
    Object.defineProperty(policyFile, "files", { configurable: true, value: [unsafeFile] });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      (document.getElementById("announcement")?.textContent ?? "").includes(
        "safe repo-relative POSIX path",
      ),
    );
    expect(document.getElementById("announcement")?.textContent).toContain(
      "safe repo-relative POSIX path",
    );

    const setValue = (id: string, value: string) => {
      const input = document.getElementById(id);
      if (input === null) throw new Error(`expected ${id}`);
      (input as unknown as { value: string }).value = value;
    };
    setValue("custom-id", "custom-mcp");
    setValue("custom-owner", "mcp.owner@example.com");
    setValue("custom-package", "@example/custom-mcp");
    setValue("custom-version", "1.2.3");
    setValue("custom-integrity", sha("a"));
    setValue("custom-evidence", "audit-2026-08");
    setValue("custom-note", "hidden\u200bunicode");
    const customForm = document.getElementById("custom-form");
    if (customForm === null) throw new Error("expected custom form");
    customForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(document.getElementById("announcement")?.textContent).toContain(
      "Correct the highlighted custom-candidate fields.",
    );
    expect(document.getElementById("custom-note")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.id).toBe("custom-note");
    expect(document.getElementById("custom-rows")?.textContent).toContain("No custom candidates");
    setValue("remote-custom-id", "figma-remote");
    setValue("remote-custom-origin", "https://mcp.figma.com/mcp");
    setValue("remote-custom-approved-by", "approver@example.com");
    setValue("remote-custom-authentication-mode", "oauth");
    setValue("remote-custom-data-classes", "design-metadata");
    setValue("remote-custom-evidence", "audit-remote-2026");
    const remoteForm = document.getElementById("remote-custom-form");
    if (remoteForm === null) throw new Error("expected remote custom form");
    remoteForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(document.getElementById("announcement")?.textContent).toContain(
      "Correct the highlighted remote-endpoint fields.",
    );
    expect(document.getElementById("remote-custom-origin")?.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement?.id).toBe("remote-custom-origin");
    expect(document.getElementById("custom-rows")?.textContent).toContain("No custom candidates");
    expect(html).toContain("Download blocked:");
    expect(html).toContain("schemaErrors(model.schema");
  });

  it("provides field recovery and safe edit/remove disclosures for pending and report-only rows", async () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(document.getElementById("announcement")?.getAttribute("aria-live")).toBe("polite");
    expect(document.getElementById("status")?.nodeName).toBe("SPAN");

    document
      .getElementById("add-curation")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("curation-id")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.id).toBe("curation-id");
    expect(document.getElementById("curation-id")?.getAttribute("aria-describedby")).toBe(
      "curation-id-error",
    );

    const set = (id: string, value: string) => {
      const input = document.getElementById(id) as {
        value: string;
        dispatchEvent: (event: unknown) => boolean;
      } | null;
      if (input === null) throw new Error(`expected ${id}`);
      input.value = value;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    set("curation-id", "review-agent");
    set("curation-owner", "framework.owner@acme.example");
    expect(document.getElementById("curation-id")?.getAttribute("aria-invalid")).toBeNull();
    expect(document.getElementById("curation-id")?.getAttribute("aria-describedby")).toBeNull();
    set("curation-repository", "acme/catalog");
    set("curation-commit", "a".repeat(40));
    set("curation-path", "agents/review.md");
    set("audit-record", "audit-2026-08");
    set("audit-digest", sha("b"));
    set("curation-note", "External review guidance");
    document
      .getElementById("add-curation")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.getElementById("curation-rows")?.textContent).toContain("report-only");
    expect(document.getElementById("curation-rows")?.textContent).toContain("acme/catalog");
    expect(
      document.querySelectorAll('[data-workbench-kind="curation"][data-workbench-action]').length,
    ).toBe(2);
    const editCuration = document.querySelector(
      '[data-workbench-action="edit"][data-workbench-kind="curation"]',
    ) as unknown as { dispatchEvent: (event: unknown) => boolean } | null;
    editCuration?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect((document.getElementById("curation-id") as unknown as { value: string }).value).toBe(
      "review-agent",
    );
    const framework = document.getElementById("curation-framework") as {
      disabled: boolean;
      value: string;
      dispatchEvent: (event: unknown) => boolean;
    } | null;
    if (framework === null) throw new Error("expected framework selector");
    expect(framework.disabled).toBe(true);
    expect(document.getElementById("curation-framework-label")?.textContent).toContain("locked");
    expect(
      (document.getElementById("cancel-curation-edit") as unknown as { hidden: boolean } | null)
        ?.hidden,
    ).toBe(false);
    document
      .getElementById("cancel-curation-edit")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(framework.disabled).toBe(false);
    expect(document.getElementById("curation-framework-label")?.textContent).toBe(
      "External framework owner",
    );
    editCuration?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(framework.disabled).toBe(true);
    framework.value = "superpowers";
    framework.dispatchEvent(new window.Event("change", { bubbles: true }));
    document
      .getElementById("add-curation")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("curation-rows")?.textContent).toContain(
      "ecc: agent / review-agent",
    );
    expect(framework.disabled).toBe(false);
    expect(document.getElementById("curation-framework-label")?.textContent).toBe(
      "External framework owner",
    );
    expect(
      (document.getElementById("cancel-curation-edit") as unknown as { hidden: boolean } | null)
        ?.hidden,
    ).toBe(true);
    expect(document.getElementById("curation-rows")?.textContent).toContain("review-agent");
    document
      .querySelector('[data-workbench-action="remove"][data-workbench-kind="curation"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("curation-rows")?.textContent).toContain(
      "No external curation intent",
    );

    set("custom-id", "custom-mcp");
    set("custom-owner", "mcp.owner@example.com");
    set("custom-package", "@example/custom-mcp");
    set("custom-version", "1.2.3");
    set("custom-integrity", sha("c"));
    set("custom-evidence", "audit-2026-08");
    const customForm = document.getElementById("custom-form");
    customForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.getElementById("custom-rows")?.textContent).toContain("Blocked");
    expect(document.getElementById("custom-rows")?.textContent).toContain("Integrity");
    expect(
      document.querySelectorAll('[data-workbench-kind="custom"][data-workbench-action]').length,
    ).toBe(2);
    document
      .querySelector('[data-workbench-action="edit"][data-workbench-kind="custom"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect((document.getElementById("custom-id") as unknown as { value: string }).value).toBe(
      "custom-mcp",
    );
    set("remote-custom-id", "figma-remote");
    set("remote-custom-origin", "https://mcp.figma.com");
    set("remote-custom-approved-by", "approver@example.com");
    set("remote-custom-authentication-mode", "oauth");
    set("remote-custom-data-classes", "design-metadata");
    set("remote-custom-administrative-status", "approved");
    set("remote-custom-evidence", "audit-remote-2026");
    const remoteForm = document.getElementById("remote-custom-form");
    remoteForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.getElementById("custom-rows")?.textContent).toContain("Remote origin:");
    expect(document.getElementById("custom-rows")?.textContent).toContain("Content scan: none");
    expect(
      document.querySelectorAll('[data-workbench-kind="remote"][data-workbench-action]').length,
    ).toBe(2);
    document
      .querySelector('[data-workbench-action="edit"][data-workbench-kind="remote"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(
      (document.getElementById("remote-custom-origin") as unknown as { value: string }).value,
    ).toBe("https://mcp.figma.com");
    document
      .querySelector('[data-workbench-action="remove"][data-workbench-kind="remote"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("custom-rows")?.textContent).toContain("custom-mcp");
    document
      .querySelector('[data-workbench-action="remove"][data-workbench-kind="custom"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("custom-rows")?.textContent).toContain("No custom candidates");
  });

  it("keeps curation and preserved evidence detail in compact accessible disclosures", async () => {
    const window = new Window({ url: "http://localhost/" });
    const html = policyStudioHtml(policyStudioModel());
    window.document.write(html);
    loadStudio(window, html);
    const document = window.document;
    const policy = fullAuthoringPolicy();
    const policyFile = document.getElementById("policy-file");
    if (policyFile === null) throw new Error("expected policy file input");
    Object.defineProperty(policyFile, "files", {
      configurable: true,
      value: [
        new window.File([JSON.stringify(policy)], "policy.json", { type: "application/json" }),
      ],
    });
    policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      (document.getElementById("curation-rows")?.textContent ?? "").includes("Repository:"),
    );
    expect(document.getElementById("curation-rows")?.textContent).toContain("Repository:");
    expect(document.getElementById("curation-rows")?.textContent).toContain("Commit:");
    expect(document.getElementById("curation-rows")?.textContent).toContain("Path:");
    expect(document.getElementById("curation-rows")?.textContent).toContain("Audit record:");
    expect(document.getElementById("curation-rows")?.textContent).toContain("Audit digest:");
    expect(document.getElementById("curation-rows")?.textContent).toContain("Clarification:");

    const approval = (policy.governance as { authority: { approvals: unknown[] } }).authority
      .approvals[0];
    const evidence = {
      id: "audit-evidence-2026-08",
      candidate: "custom-mcp",
      kind: "mcp",
      source: {
        type: "stdio",
        resolver: "npx",
        registry: "https://registry.npmjs.org",
        package: "@example/custom-mcp",
        version: "1.2.3",
        integrity: sha("a"),
      },
      sourceDigest: sha("b"),
      identityDigest: sha("c"),
      evidenceDigest: sha("d"),
      state: "failed",
      waivable: true,
      detectors: [{ id: "semgrep", required: true, status: "pass", reportDigest: sha("e") }],
      findings: ["prompt-injection"],
      futureInspectorField: "<img src=x onerror=alert(1)>",
    };
    const evidenceFile = document.getElementById("evidence-file");
    if (evidenceFile === null) throw new Error("expected evidence file input");
    Object.defineProperty(evidenceFile, "files", {
      configurable: true,
      value: [
        new window.File(
          [
            JSON.stringify({
              approvals: [approval],
              evidence: [evidence],
            }),
          ],
          "audit.json",
          { type: "application/json" },
        ),
      ],
    });
    evidenceFile.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle(window, () =>
      (document.getElementById("approval-rows")?.textContent ?? "").includes('"candidate"'),
    );
    const receiptText = document.getElementById("approval-rows")?.textContent;
    for (const label of [
      '"candidate": "custom-mcp"',
      '"kind": "mcp"',
      '"source": {',
      '"sourceDigest"',
      '"projector": "mcp-managed-settings"',
      '"policyVersion": "2026.08"',
      '"identityDigest"',
      '"waivable": true',
      '"detectors"',
      '"findings"',
      '"futureInspectorField"',
      "preserved/preflight-only; not verified or effective",
    ]) {
      expect(receiptText).toContain(label);
    }
    expect(document.querySelector("#approval-rows img")).toBeNull();
    expect(document.getElementById("approval-rows")?.innerHTML).toContain("&lt;img");
    expect(document.querySelectorAll("#approval-rows .row-details[open]")).toHaveLength(0);
  });

  it("matches runtime rejection for each org-policy custom refinement layer", async () => {
    const cases: Array<{ name: string; mutate: (policy: Record<string, unknown>) => void }> = [
      {
        name: "candidate source/kind refinement",
        mutate: (policy) => {
          const governance = policy.governance as {
            catalog: { custom: Array<{ source: unknown }> };
          };
          const candidate = governance.catalog.custom[0];
          if (candidate === undefined) throw new Error("expected custom candidate fixture");
          candidate.source = {
            type: "command",
            command: "npx",
            args: [],
            executableDigest: sha("a"),
          };
        },
      },
      {
        name: "external curation duplicate refinement",
        mutate: (policy) => {
          const governance = policy.governance as {
            externalCuration: Array<{ items: unknown[] }>;
          };
          const group = governance.externalCuration[0];
          if (group === undefined || group.items[0] === undefined) {
            throw new Error("expected external curation fixture");
          }
          group.items.push(structuredClone(group.items[0]));
        },
      },
      {
        name: "external selection duplicate item refinement",
        mutate: (policy) => {
          const governance = policy.governance as {
            externalSelections?: Array<{ framework: string; items: unknown[] }>;
          };
          const item = {
            kind: "skill",
            id: "duplicate-skill",
            source: {
              repository: "acme/ecc-catalog",
              commit: "e".repeat(40),
              path: "skills/duplicate-skill.md",
            },
          };
          governance.externalSelections = [
            { framework: "ecc", items: [item, structuredClone(item)] },
          ];
        },
      },
      {
        name: "multiple selected framework refinement",
        mutate: (policy) => {
          const governance = policy.governance as {
            externalSelections?: Array<{ framework: string; items: unknown[] }>;
          };
          governance.externalSelections = [
            {
              framework: "ecc",
              items: [
                {
                  kind: "skill",
                  id: "ecc-skill",
                  source: {
                    repository: "acme/ecc-catalog",
                    commit: "e".repeat(40),
                    path: "skills/ecc-skill.md",
                  },
                },
              ],
            },
            {
              framework: "superpowers",
              items: [
                {
                  kind: "skill",
                  id: "superpowers-skill",
                  source: {
                    repository: "acme/superpowers-catalog",
                    commit: "f".repeat(40),
                    path: "skills/superpowers-skill.md",
                  },
                },
              ],
            },
          ];
        },
      },
      {
        name: "selection and curation overlap refinement",
        mutate: (policy) => {
          const governance = policy.governance as {
            externalCuration: Array<{ items: Array<Record<string, unknown>> }>;
            externalSelections?: Array<{ framework: string; items: unknown[] }>;
          };
          const curated = governance.externalCuration[0]?.items[1];
          if (curated === undefined) throw new Error("expected curated Skill fixture");
          governance.externalSelections = [
            {
              framework: "ecc",
              items: [
                {
                  kind: curated.kind,
                  id: curated.id,
                  source: structuredClone(curated.source),
                },
              ],
            },
          ];
        },
      },
      {
        name: "governance activation reference refinement",
        mutate: (policy) => {
          const governance = policy.governance as { activations: unknown[] };
          governance.activations.push({
            candidate: "unknown-candidate",
            state: "active",
            targets: ["claude"],
          });
        },
      },
    ];
    for (const fixture of cases) {
      const policy = fullAuthoringPolicy();
      fixture.mutate(policy);
      expect(() => parseStudioPolicyImport(JSON.stringify(policy)), fixture.name).toThrow();
      const window = new Window({ url: "http://localhost/" });
      const html = policyStudioHtml(policyStudioModel());
      window.document.write(html);
      loadStudio(window, html);
      const policyFile = window.document.getElementById("policy-file");
      if (policyFile === null) throw new Error("expected policy file input");
      Object.defineProperty(policyFile, "files", {
        configurable: true,
        value: [
          new window.File([JSON.stringify(policy)], "policy.json", { type: "application/json" }),
        ],
      });
      policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle(window, () =>
        (window.document.getElementById("announcement")?.textContent ?? "").includes(
          "Policy import rejected",
        ),
      );
      expect(window.document.getElementById("announcement")?.textContent, fixture.name).toContain(
        "Policy import rejected",
      );
    }
  });

  it("keeps browser import, validate, and download parity with command registry/index argument grammar", async () => {
    const cases = [
      { argument: "--registry=https://registry.npmjs.org", accepted: true },
      { argument: "--index-url=https://pypi.org", accepted: true },
      { argument: "--registry=http:", accepted: false },
      { argument: "--index-url=https://pypi.org/simple", accepted: false },
      { argument: "local\\path", accepted: false },
      {
        argument: "--registry=https://registry.npmjs.org",
        sourceRegistry: "http:",
        accepted: false,
      },
      {
        argument: "--index-url=https://pypi.org",
        sourceRegistry: "https://registry.npmjs.org/simple",
        accepted: false,
      },
    ];
    for (const fixture of cases) {
      const policy = policyWithCommandArgument(fixture.argument, fixture.sourceRegistry);
      if (fixture.accepted) {
        expect(() => parseStudioPolicyImport(JSON.stringify(policy))).not.toThrow();
      } else {
        expect(() => parseStudioPolicyImport(JSON.stringify(policy))).toThrow();
      }
      const window = new Window({ url: "http://localhost/" });
      const html = policyStudioHtml(policyStudioModel());
      window.document.write(html);
      loadStudio(window, html, fixture.accepted ? "" : `state.policy=${JSON.stringify(policy)};`);
      const document = window.document;
      const policyFile = document.getElementById("policy-file");
      if (policyFile === null) throw new Error("expected policy file input");
      const file = new window.File([JSON.stringify(policy)], "policy.json", {
        type: "application/json",
      });
      Object.defineProperty(policyFile, "files", { configurable: true, value: [file] });
      policyFile.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle(
        window,
        () => (document.getElementById("announcement")?.textContent ?? "") !== "",
      );
      const announcement = document.getElementById("announcement");
      if (fixture.accepted) {
        expect(announcement?.textContent).toContain("without transformation");
        document
          .getElementById("validate")
          ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        expect(announcement?.textContent).toContain("validation passed");
        const preset = document.getElementById("preset-select") as unknown as {
          value: string;
          dispatchEvent(event: unknown): boolean;
        } | null;
        if (preset === null) throw new Error("expected Vibe preset");
        // Presets compose selections; posture-only behavior is covered separately.
        // This assertion is about the canonical rail control still working after an import.
        preset.value = "vibe";
        preset.dispatchEvent(new window.Event("change", { bubbles: true }));
        expect(announcement?.textContent).toContain("Vibe composed:");
      } else {
        expect(
          announcement?.textContent,
          `${fixture.argument} / ${fixture.sourceRegistry ?? "default"}`,
        ).toContain("Policy import rejected");
        expect(
          (document.getElementById("config-preview") as unknown as { value: string }).value,
        ).not.toContain(fixture.argument);
        document
          .getElementById("download")
          ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        expect(announcement?.textContent).toContain("Download blocked");
      }
    }
  }, 10_000);
});
