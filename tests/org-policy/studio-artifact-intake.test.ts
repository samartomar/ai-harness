import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextEncoder } from "node:util";
import { type Element, Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { verifyPolicyAuthorityReceipt } from "../../src/org-policy/authority.js";
import { governanceDecisionDigestV2 } from "../../src/org-policy/governance-decision-v2.js";
import {
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
  verifyOrganizationQualificationV1,
} from "../../src/org-policy/qualification-v1.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  artifactDirectoryResolutionDigestV2,
  artifactDirectoryResolutionRecordV2,
  artifactEvidenceBundleDigestV1,
  artifactEvidenceBundleDigestV2,
  artifactEvidenceDigestV1,
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
  createArtifactEvidenceBundleV2,
} from "../../src/trust/artifact-evidence.js";
import { ArtifactIntakeV1Schema, ArtifactIntakeV2Schema } from "../../src/trust/artifact-intake.js";
import {
  extractDirectoryClaimV1,
  parseDirectoryDiscoveryUrlV1,
  resolveDirectoryClaimV1,
} from "../../src/trust/directory-resolution.js";

interface IntakeApi {
  exportWorkspaceValue(policyFilename?: string): Record<string, unknown>;
  importIntakeText(text: string): Promise<void>;
  importWorkspaceText(text: string): Promise<void>;
  mergeEvidenceText(text: string): Promise<void>;
  snapshot(): { intake: Record<string, unknown> | null; bundleCount: number };
}

const REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const OTHER_REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
const openWindows = new Set<Window>();

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

function input(window: Window, id: string, value: string): void {
  setValue(window, id, value);
  window.document
    .getElementById(id)
    ?.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
}

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(policyStudioModel());
  window.document.write(html);
  Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
  Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
}

function api(window: Window): IntakeApi {
  const value = (window as unknown as { __aihArtifactIntake?: IntakeApi }).__aihArtifactIntake;
  if (value === undefined) throw new Error("expected artifact intake Workbench API");
  return value;
}

function click(window: Window, node: Element | null): void {
  if (node === null) throw new Error("expected clickable element");
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function openArtifact(window: Window, kind: "mcp" | "skill" | "agent"): void {
  click(window, window.document.getElementById("open-artifacts"));
  setValue(window, "artifact-item-kind", kind);
  window.document
    .getElementById("artifact-item-kind")
    ?.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
}

async function settle(window: Window): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function submitProtected(window: Window): Promise<void> {
  const state = window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> };
  state.__aihPolicyWorkbenchPending = undefined;
  window.document
    .getElementById("protected-form")
    ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  if (state.__aihPolicyWorkbenchPending === undefined)
    throw new Error("protected authoring did not start");
  await state.__aihPolicyWorkbenchPending;
}

function setValue(window: Window, id: string, value: string): void {
  const input = window.document.getElementById(id) as unknown as { value: string } | null;
  if (input === null) throw new Error(`expected #${id}`);
  input.value = value;
}

function intake(version = "3.24.0", integrity?: string) {
  return ArtifactIntakeV1Schema.parse({
    format: "aih-artifact-intake",
    version: 1,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        discoveryUrl: "https://mcpmarket.com/server/firecrawl",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version,
          ...(integrity === undefined ? {} : { integrity }),
        },
      },
    ],
  });
}

function intakeBatch(count: number) {
  const template = intake();
  const source = template.items[0]?.source;
  if (source === undefined) throw new Error("expected intake source");
  return ArtifactIntakeV1Schema.parse({
    ...template,
    items: Array.from({ length: count }, (_value, index) => ({
      id: `artifact-${String(index).padStart(3, "0")}`,
      kind: index % 3 === 0 ? "mcp" : index % 3 === 1 ? "skill" : "agent",
      source,
    })),
  });
}

function evidence(detail: string, source = intake()) {
  const item = source.items[0];
  if (item === undefined) throw new Error("expected intake item");
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  return createArtifactEvidenceBundleV1(source, [
    artifactEvidenceRecordV1({
      intake: source,
      item,
      state: "verified",
      observed: {
        type: "npm",
        tarballSha256: `sha256:${"b".repeat(64)}`,
        registryIntegrity:
          item.source.type === "npm" && item.source.integrity !== undefined
            ? item.source.integrity
            : REGISTRY_INTEGRITY,
      },
      analyzersRun: ["aih-native"],
      checks: [{ name: "trust scan", verdict: "pass", detail }],
      findings: [],
      scan: {
        observedAt,
        validUntil,
        posture: "enterprise",
        scanner: {
          name: "@aihq/core",
          version: "0.3.0",
          nativeIdentity: "native.aaaaaaaaaaaa",
        },
        requiredDetectors: [],
        policyDigest: `sha256:${"c".repeat(64)}`,
      },
    }),
  ]);
}

function directoryEvidence(source: ReturnType<typeof ArtifactIntakeV2Schema.parse>) {
  const item = source.items[0];
  if (item === undefined) throw new Error("expected directory intake item");
  const discovery = parseDirectoryDiscoveryUrlV1("https://www.pulsemcp.com/servers/firecrawl");
  const claim = extractDirectoryClaimV1(
    discovery,
    "<h1>Firecrawl</h1><p>NAME io.github.firecrawl/firecrawl-mcp-server</p><p>Current Version: 3.7.4</p>",
  );
  const resolution = resolveDirectoryClaimV1(claim, {
    servers: [
      {
        server: {
          name: "io.github.firecrawl/firecrawl-mcp-server",
          version: "3.24.0",
          repository: {
            url: "https://github.com/firecrawl/firecrawl-mcp-server",
            source: "github",
          },
          packages: [
            {
              registryType: "npm",
              identifier: "firecrawl-mcp",
              version: "3.24.0",
              transport: { type: "stdio" },
              environmentVariables: [{ name: "FIRECRAWL_API_KEY", isSecret: true }],
            },
          ],
        },
      },
    ],
    metadata: { count: 1 },
  });
  const record = artifactDirectoryResolutionRecordV2({ intake: source, item, resolution });
  return createArtifactEvidenceBundleV2(source, [], [record]);
}

function rehashDirectoryEvidence(bundle: ReturnType<typeof directoryEvidence>) {
  const resolution = bundle.resolutions[0];
  const result = bundle.results[0];
  if (resolution === undefined || result === undefined) {
    throw new Error("expected directory resolution bundle");
  }
  const { resolutionDigest: _resolutionDigest, ...resolutionUnsigned } = resolution;
  resolution.resolutionDigest = artifactDirectoryResolutionDigestV2(resolutionUnsigned);
  result.resolutionDigest = resolution.resolutionDigest;
  const { bundleDigest: _bundleDigest, ...bundleUnsigned } = bundle;
  bundle.bundleDigest = artifactEvidenceBundleDigestV2(bundleUnsigned);
  return bundle;
}

function atlassianDirectoryIntake() {
  return ArtifactIntakeV2Schema.parse({
    format: "aih-artifact-intake",
    version: 2,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "atlassian-directory",
        kind: "mcp",
        source: {
          type: "directory",
          provider: "mcpmarket",
          url: "https://mcpmarket.com/server/atlassian-jira-confluence",
        },
      },
    ],
  });
}

function atlassianDirectoryEvidence(source: ReturnType<typeof atlassianDirectoryIntake>) {
  const item = source.items[0];
  if (item === undefined) throw new Error("expected Atlassian intake item");
  const discovery = parseDirectoryDiscoveryUrlV1(
    "https://mcpmarket.com/server/atlassian-jira-confluence",
  );
  const claim = extractDirectoryClaimV1(
    discovery,
    "<h1>Atlassian Jira &amp; Confluence</h1><p>Endpoint https://mcp.atlassian.com/v1/sse</p>",
  );
  const resolution = resolveDirectoryClaimV1(claim, {
    servers: [
      {
        server: {
          name: "com.atlassian/atlassian-mcp-server",
          version: "1.1.3",
          remotes: [
            { type: "streamable-http", url: "https://mcp.atlassian.com/v1/mcp" },
            {
              type: "streamable-http",
              url: "https://mcp.atlassian.com/v1/mcp/authv2",
            },
          ],
        },
      },
    ],
    metadata: { count: 1 },
  });
  const record = artifactDirectoryResolutionRecordV2({ intake: source, item, resolution });
  return createArtifactEvidenceBundleV2(source, [], [record]);
}

describe("Policy Workbench artifact intake", () => {
  it("offers one scalable Add/import/scan/review path for MCP, Skill, and Agent sources", () => {
    const window = studio();
    const card = window.document.getElementById("artifact-intake-review");

    expect(card?.textContent).toContain("Add and review MCP, Skill, or Agent sources");
    expect(card?.textContent).toContain("one accountable owner email");
    expect(card?.textContent).toContain(
      "aih trust scan aih-artifact-intake.json --posture enterprise --apply --evidence-out aih-artifact-evidence.json",
    );
    expect(card?.textContent).toContain("Preflight only");
    expect(card?.textContent).toContain("limited to 1 MiB");
    expect(card?.textContent).toContain("64 decisions per protected file");
    expect(card?.textContent).toContain("0 / 100 candidates");
    expect(card?.textContent).toContain("does not choose authorized targets");
    expect(card?.textContent).toContain("does not infer launch or transport");
    expect(card?.textContent).not.toContain("Default targets");
    expect(card?.textContent).not.toContain("Record Agent");
    const pulseMcpLink = card?.querySelector('a[href="https://www.pulsemcp.com/"]');
    expect(pulseMcpLink?.textContent).toContain("AIH recommended");
    expect(card?.querySelector('a[href="https://mcpmarket.com/"]')).not.toBeNull();
    expect(card?.querySelector('a[href="https://www.skills.sh/"]')).not.toBeNull();
    expect(window.document.getElementById("import-artifact-intake")?.textContent).toContain(
      "Import existing artifact intake",
    );
    expect(window.document.getElementById("import-artifact-evidence")?.textContent).toContain(
      "Merge scan evidence",
    );
    expect(window.document.getElementById("panel-artifacts")?.firstElementChild).toBe(card);
    expect(
      window.document.getElementById("panel-imports")?.querySelector("#artifact-intake-review"),
    ).toBeNull();

    window.close();
  });

  it("saves and restores one non-authoritative team workspace with policy, intake, and evidence", async () => {
    const window = studio();
    const source = intake();
    const bundle = evidence("team review");
    await api(window).importIntakeText(JSON.stringify(source));
    await api(window).mergeEvidenceText(JSON.stringify(bundle));

    const workspace = api(window).exportWorkspaceValue("payments-platform-policy.json");
    expect(workspace).toMatchObject({
      format: "aih-policy-workbench-workspace",
      version: 1,
      authority: { state: "not-authority" },
      policyFilename: "payments-platform-policy.json",
      artifactIntake: source,
      evidenceBundles: [bundle],
    });
    expect(workspace).toHaveProperty("policy");

    const restored = studio();
    await api(restored).importWorkspaceText(JSON.stringify(workspace));
    expect(api(restored).snapshot()).toMatchObject({ intake: source, bundleCount: 1 });
    expect(
      (restored.document.getElementById("policy-download-name") as unknown as { value: string })
        .value,
    ).toBe("payments-platform-policy.json");
    expect(
      JSON.parse(
        (restored.document.getElementById("config-preview") as unknown as { value: string }).value,
      ),
    ).toEqual(workspace.policy);
    expect(restored.document.getElementById("artifact-intake-message")?.textContent).toContain(
      "policy, intake, and 1 evidence bundle",
    );

    window.close();
    restored.close();
  });

  it("rejects an unsafe or corrupted team workspace without partially replacing review state", async () => {
    const source = intake();
    const bundle = evidence("team review");
    const sourceWindow = studio();
    await api(sourceWindow).importIntakeText(JSON.stringify(source));
    await api(sourceWindow).mergeEvidenceText(JSON.stringify(bundle));
    const workspace = api(sourceWindow).exportWorkspaceValue("payments-platform-policy.json");

    const unsafeName = structuredClone(workspace);
    unsafeName.policyFilename = "teams/payments-platform-policy.json";
    const target = studio();
    await expect(api(target).importWorkspaceText(JSON.stringify(unsafeName))).rejects.toThrow(
      /policy filename/i,
    );

    const corrupted = structuredClone(workspace) as {
      evidenceBundles: Array<{ bundleDigest: string }>;
    };
    const corruptedBundle = corrupted.evidenceBundles[0];
    if (corruptedBundle === undefined) throw new Error("expected exported evidence bundle");
    corruptedBundle.bundleDigest = `sha256:${"0".repeat(64)}`;
    await expect(api(target).importWorkspaceText(JSON.stringify(corrupted))).rejects.toThrow(
      /digest mismatch/i,
    );
    expect(api(target).snapshot()).toEqual({ intake: null, bundleCount: 0 });

    sourceWindow.close();
    target.close();
  });

  it("caps cumulative evidence history at 100 bundles without losing resumable state", async () => {
    const window = studio();
    const workspace = api(window).exportWorkspaceValue("payments-platform-policy.json") as {
      evidenceBundles: Array<Record<string, unknown>>;
    };
    workspace.evidenceBundles = Array.from({ length: 100 }, (_value, index) =>
      evidence(`history-${String(index).padStart(3, "0")}`),
    );
    await api(window).importWorkspaceText(JSON.stringify(workspace));

    await expect(
      api(window).mergeEvidenceText(JSON.stringify(evidence("history-overflow"))),
    ).rejects.toThrow(/at most 100|limited to 100/i);
    expect(api(window).snapshot().bundleCount).toBe(100);
    expect(
      (
        api(window).exportWorkspaceValue("payments-platform-policy.json")
          .evidenceBundles as unknown[]
      ).length,
    ).toBe(100);

    window.close();
  });

  it("opens one dedicated Artifacts workspace and chooses kind inside it", () => {
    const window = studio();

    expect(window.document.getElementById("open-artifacts")?.textContent).toContain(
      "Organization artifacts",
    );
    expect(window.document.getElementById("open-custom")).toBeNull();
    expect(window.document.getElementById("open-custom-skill")).toBeNull();
    expect(window.document.getElementById("open-custom-agent")).toBeNull();

    click(window, window.document.getElementById("open-artifacts"));
    expect((window.document.body as unknown as { dataset: { view: string } }).dataset.view).toBe(
      "artifacts",
    );
    expect(
      window.document.querySelector('[data-view-tab="artifacts"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      [...(window.document.getElementById("artifact-item-kind")?.querySelectorAll("option") ?? [])]
        .map((option) => option.textContent)
        .filter(Boolean),
    ).toEqual(["MCP", "Skill", "Agent"]);
    expect(
      (window.document.getElementById("authoring-sidebar") as unknown as { hidden: boolean })
        .hidden,
    ).toBe(true);

    window.close();
  });

  it("closes overlays on workspace changes and gives every workspace a main landmark", () => {
    const window = studio();
    const overlays = [
      ["drawer", "scrim"],
      ["authoring-sidebar", "authoring-scrim"],
      ["ecc-mcp-sidebar", "ecc-mcp-scrim"],
    ] as const;
    const showOverlays = () => {
      for (const [panelId, scrimId] of overlays) {
        const panel = window.document.getElementById(panelId) as unknown as {
          hidden: boolean;
        } | null;
        const scrim = window.document.getElementById(scrimId);
        if (panel === null || scrim === null) throw new Error(`expected ${panelId} overlay`);
        panel.hidden = false;
        scrim.classList.add("open");
      }
    };
    const expectOverlaysClosed = () => {
      for (const [panelId, scrimId] of overlays) {
        expect(
          (window.document.getElementById(panelId) as unknown as { hidden: boolean }).hidden,
        ).toBe(true);
        expect(window.document.getElementById(scrimId)?.classList.contains("open")).toBe(false);
      }
    };

    for (const panelId of ["panel-artifacts", "panel-author", "panel-imports"]) {
      expect(window.document.getElementById(panelId)?.getAttribute("role")).toBe("main");
    }

    showOverlays();
    click(window, window.document.getElementById("open-artifacts"));
    expectOverlaysClosed();

    showOverlays();
    click(window, window.document.querySelector('[data-view-tab="imports"]'));
    expectOverlaysClosed();

    window.close();
  });

  it("offers MCP the same paste-first discovery path and routes a directory page to resolution", () => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "owner@company.example");
    const helper = window.document.getElementById("artifact-mcp-discovery-helper") as unknown as {
      hidden: boolean;
      textContent: string | null;
    } | null;

    expect(helper?.hidden).toBe(false);
    expect(helper?.textContent).toContain("Paste an MCP directory page");
    expect(helper?.textContent).toContain("never runs or installs");
    expect(
      (
        window.document.getElementById("artifact-skill-discovery-helper") as unknown as {
          hidden: boolean;
        }
      ).hidden,
    ).toBe(true);

    input(
      window,
      "artifact-mcp-discovery",
      "[https://mcpmarket.com/server/atlassian-jira-confluence](https://mcpmarket.com/server/atlassian-jira-confluence)",
    );
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect(
      (window.document.getElementById("artifact-item-id") as unknown as { value: string }).value,
    ).toBe("atlassian-jira-confluence");
    expect(
      (window.document.getElementById("artifact-source-type") as unknown as { value: string })
        .value,
    ).toBe("directory");
    expect(
      (window.document.getElementById("artifact-directory-url") as unknown as { value: string })
        .value,
    ).toBe("https://mcpmarket.com/server/atlassian-jira-confluence");
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toContain(
      "official MCP Registry",
    );
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toContain(
      "not evidence or authority",
    );

    click(window, window.document.getElementById("add-artifact-item"));
    const queued = ArtifactIntakeV2Schema.parse(api(window).snapshot().intake);
    expect(queued.items[0]).toMatchObject({
      id: "atlassian-jira-confluence",
      kind: "mcp",
      source: {
        type: "directory",
        provider: "mcpmarket",
        url: "https://mcpmarket.com/server/atlassian-jira-confluence",
      },
    });
    expect(queued.items[0]).not.toHaveProperty("execution");
    expect(queued.items[0]).not.toHaveProperty("targets");
    window.close();
  });

  it("extracts exact MCP npm intent from a pinned npx command without copying execution", () => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "owner@company.example");
    input(window, "artifact-mcp-discovery", "npx -y firecrawl-mcp@3.24.0");
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect(
      (window.document.getElementById("artifact-item-id") as unknown as { value: string }).value,
    ).toBe("firecrawl-mcp");
    expect(
      (window.document.getElementById("artifact-source-type") as unknown as { value: string })
        .value,
    ).toBe("npm");
    expect(
      (window.document.getElementById("artifact-npm-package") as unknown as { value: string })
        .value,
    ).toBe("firecrawl-mcp");
    expect(
      (window.document.getElementById("artifact-npm-version") as unknown as { value: string })
        .value,
    ).toBe("3.24.0");
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toMatch(
      /parsed locally.*never ran/i,
    );

    click(window, window.document.getElementById("add-artifact-item"));
    const queued = ArtifactIntakeV1Schema.parse(api(window).snapshot().intake);
    expect(queued.items[0]).toMatchObject({
      id: "firecrawl-mcp",
      kind: "mcp",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "firecrawl-mcp",
        version: "3.24.0",
      },
    });
    expect(queued.items[0]).not.toHaveProperty("execution");
    window.close();
  });

  it("clears helper-derived MCP discovery provenance when the exact source changes", () => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "owner@company.example");
    input(window, "artifact-mcp-discovery", "https://www.npmjs.com/package/firecrawl-mcp/v/3.24.0");
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect(
      (window.document.getElementById("artifact-discovery-url") as unknown as { value: string })
        .value,
    ).toBe("https://www.npmjs.com/package/firecrawl-mcp/v/3.24.0");

    input(window, "artifact-item-id", "other-mcp");
    input(window, "artifact-npm-package", "other-mcp");
    input(window, "artifact-npm-version", "1.2.3");

    expect(
      (window.document.getElementById("artifact-discovery-url") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toMatch(
      /source changed.*provenance was cleared/i,
    );

    click(window, window.document.getElementById("add-artifact-item"));
    const queued = ArtifactIntakeV1Schema.parse(api(window).snapshot().intake);
    expect(queued.items[0]).toMatchObject({
      id: "other-mcp",
      kind: "mcp",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "other-mcp",
        version: "1.2.3",
      },
    });
    expect(queued.items[0]).not.toHaveProperty("discoveryUrl");
    window.close();
  });

  it("extracts an exact MCP GitHub permalink without a mutable HEAD lookup", () => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "owner@company.example");
    const commit = "a".repeat(40);
    input(
      window,
      "artifact-mcp-discovery",
      `https://github.com/example/mcp-server/blob/${commit}/packages/server/package.json`,
    );
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect(
      (window.document.getElementById("artifact-item-id") as unknown as { value: string }).value,
    ).toBe("mcp-server");
    expect(
      (window.document.getElementById("artifact-source-type") as unknown as { value: string })
        .value,
    ).toBe("github");
    expect(
      (
        window.document.getElementById("artifact-github-repository") as unknown as {
          value: string;
        }
      ).value,
    ).toBe("example/mcp-server");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe(commit);
    expect(
      (window.document.getElementById("artifact-source-path") as unknown as { value: string })
        .value,
    ).toBe("packages/server/package.json");
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toContain(
      "exact GitHub permalink",
    );
    window.close();
  });

  it.each([
    ["npx firecrawl-mcp", /exact package version/i],
    ["npx -y firecrawl-mcp@3.24.0 --token secret", /command syntax is not accepted/i],
    ["npx -y firecrawl-mcp@3.24.0 && echo unsafe", /command syntax is not accepted/i],
    [
      "[https://mcpmarket.com/server/firecrawl](https://attacker.example/server/firecrawl)",
      /link text and destination must match/i,
    ],
  ])("rejects unsafe or mutable MCP discovery input %s", (raw, expected) => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "owner@company.example");
    input(window, "artifact-mcp-discovery", raw);
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toMatch(
      expected,
    );
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();
    window.close();
  });

  it("resolves a Skills CLI discovery command to one exact source without installing it", async () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    const commit = "b".repeat(40);
    const requests: Array<{ url: string; options: Record<string, unknown> }> = [];
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (url: string, options: Record<string, unknown>) => {
        requests.push({ url, options });
        if (url.endsWith("/commits/HEAD")) {
          return { ok: true, status: 200, json: async () => ({ sha: commit }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            truncated: false,
            tree: [
              { type: "blob", path: "skills/productivity/grill-me/SKILL.md" },
              { type: "blob", path: "skills/productivity/other/SKILL.md" },
            ],
          }),
        };
      },
    });

    expect(
      (
        window.document.getElementById("artifact-skill-discovery-helper") as unknown as {
          hidden: boolean;
        }
      ).hidden,
    ).toBe(false);
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add [https://github.com/mattpocock/skills](https://github.com/mattpocock/skills) --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    await settle(window);

    expect(
      (window.document.getElementById("artifact-item-id") as unknown as { value: string }).value,
    ).toBe("grill-me");
    expect(
      (window.document.getElementById("artifact-source-type") as unknown as { value: string })
        .value,
    ).toBe("github");
    expect(
      (
        window.document.getElementById("artifact-github-repository") as unknown as {
          value: string;
        }
      ).value,
    ).toBe("mattpocock/skills");
    expect(
      (window.document.getElementById("artifact-source-path") as unknown as { value: string })
        .value,
    ).toBe("skills/productivity/grill-me/SKILL.md");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe(commit);
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("GitHub public read-only metadata");
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("nothing was installed");
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("Requested Skill grill-me");
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("not evidence or authority");
    expect(api(window).snapshot().intake).toBeNull();
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/mattpocock/skills/commits/HEAD",
      `https://api.github.com/repos/mattpocock/skills/git/trees/${commit}?recursive=1`,
    ]);
    for (const request of requests) {
      expect(request.options).toMatchObject({
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    }

    click(window, window.document.getElementById("add-artifact-item"));
    expect(api(window).snapshot().intake).toMatchObject({
      authority: { state: "not-authority" },
      items: [
        {
          id: "grill-me",
          kind: "skill",
          source: {
            type: "github",
            repository: "mattpocock/skills",
            commit,
            path: "skills/productivity/grill-me/SKILL.md",
          },
        },
      ],
    });

    window.close();
  });

  it("fails closed when GitHub cannot return one complete unambiguous Skill path", async () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (url: string) =>
        url.endsWith("/commits/HEAD")
          ? { ok: true, status: 200, json: async () => ({ sha: "c".repeat(40) }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                truncated: true,
                tree: [{ type: "blob", path: "skills/grill-me/SKILL.md" }],
              }),
            },
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    await settle(window);

    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /rejected.*truncated/i,
    );
    expect(
      (window.document.getElementById("artifact-github-repository") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-source-path") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("rejects ambiguous Skill paths from public GitHub metadata", async () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (url: string) =>
        url.endsWith("/commits/HEAD")
          ? { ok: true, status: 200, json: async () => ({ sha: "d".repeat(40) }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                truncated: false,
                tree: [
                  { type: "blob", path: "skills/grill-me/SKILL.md" },
                  { type: "blob", path: "archive/grill-me/SKILL.md" },
                ],
              }),
            },
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    await settle(window);

    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /rejected.*multiple matching Skill paths/i,
    );
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("does not apply a stale GitHub response after the discovery input changes", async () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    let resolveCommit!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }) => void;
    const pendingCommit = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }>((resolve) => {
      resolveCommit = resolve;
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (url: string) =>
        url.endsWith("/commits/HEAD")
          ? pendingCommit
          : {
              ok: true,
              status: 200,
              json: async () => ({
                truncated: false,
                tree: [{ type: "blob", path: "skills/productivity/grill-me/SKILL.md" }],
              }),
            },
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );
    resolveCommit({
      ok: true,
      status: 200,
      json: async () => ({ sha: "e".repeat(40) }),
    });
    await settle(window);

    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /input changed.*resolve it again/i,
    );
    expect(
      (window.document.getElementById("artifact-github-repository") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("aborts resolution when exact-source fields change and never binds the stale response", async () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    let requestSignal: AbortSignal | undefined;
    let resolveCommit!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }) => void;
    const pendingCommit = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }>((resolve) => {
      resolveCommit = resolve;
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (_url: string, options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return pendingCommit;
      },
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    input(window, "artifact-github-repository", "vercel-labs/skills");
    resolveCommit({
      ok: true,
      status: 200,
      json: async () => ({ sha: "f".repeat(40) }),
    });
    await settle(window);

    expect(requestSignal?.aborted).toBe(true);
    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /source details changed.*resolve the Skill again/i,
    );
    expect(
      (window.document.getElementById("artifact-github-repository") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("aborts Skill resolution when the administrator changes artifact kind", async () => {
    const window = studio();
    openArtifact(window, "skill");
    let requestSignal: AbortSignal | undefined;
    let resolveCommit!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }) => void;
    const pendingCommit = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<{ sha: string }>;
    }>((resolve) => {
      resolveCommit = resolve;
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async (_url: string, options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return pendingCommit;
      },
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    setValue(window, "artifact-item-kind", "agent");
    window.document
      .getElementById("artifact-item-kind")
      ?.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    resolveCommit({
      ok: true,
      status: 200,
      json: async () => ({ sha: "a".repeat(40) }),
    });
    await settle(window);

    expect(requestSignal?.aborted).toBe(true);
    expect(
      (window.document.getElementById("artifact-item-kind") as unknown as { value: string }).value,
    ).toBe("agent");
    expect(
      (window.document.getElementById("artifact-github-repository") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it.each([
    {
      name: "an HTTP failure",
      response: { ok: false, status: 403, json: async () => ({}) },
      expected: /HTTP 403/i,
    },
    {
      name: "a malformed commit identity",
      response: { ok: true, status: 200, json: async () => ({ sha: "not-a-commit" }) },
      expected: /exact lowercase 40-character commit/i,
    },
  ])("fails closed when GitHub returns $name", async ({ response, expected }) => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: async () => response,
    });
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/mattpocock/skills --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    await settle(window);

    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      expected,
    );
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("accepts only exact GitHub Skill permalinks and rejects command syntax", () => {
    const window = studio();
    openArtifact(window, "skill");
    input(window, "artifact-default-owner", "owner@company.example");
    const commit = "a".repeat(40);
    input(
      window,
      "artifact-skill-discovery",
      `https://github.com/vercel-labs/skills/blob/${commit}/skills/find-skills/SKILL.md`,
    );
    click(window, window.document.getElementById("parse-skill-discovery"));

    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe(commit);
    expect(
      (window.document.getElementById("artifact-source-path") as unknown as { value: string })
        .value,
    ).toBe("skills/find-skills/SKILL.md");
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("exact permalink");

    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills; calc",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /rejected.*command syntax/i,
    );
    expect(
      (window.document.getElementById("artifact-item-id") as unknown as { value: string }).value,
    ).toBe("");
    expect(
      (
        window.document.getElementById("artifact-github-repository") as unknown as {
          value: string;
        }
      ).value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-github-commit") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("artifact-source-path") as unknown as { value: string })
        .value,
    ).toBe("");
    click(window, window.document.getElementById("add-artifact-item"));
    expect(api(window).snapshot().intake).toBeNull();
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add [https://github.com/mattpocock/skills](https://github.com/attacker/skills) --skill grill-me",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    expect(window.document.getElementById("artifact-skill-discovery-message")?.textContent).toMatch(
      /rejected.*link text and destination must match/i,
    );
    expect(api(window).snapshot().intake).toBeNull();

    window.close();
  });

  it("explains exact npm identity and scanner-computed integrity without trusting directory labels", () => {
    const window = studio();

    input(window, "artifact-npm-package", "@firecrawl");
    input(window, "artifact-npm-version", "4.37.0");
    expect(window.document.getElementById("artifact-source-guide")?.textContent).toContain(
      "complete @scope/package",
    );
    expect(window.document.getElementById("artifact-source-guide")?.textContent).not.toContain(
      "npm view",
    );

    input(window, "artifact-npm-package", "firecrawl-mcp");
    input(window, "artifact-npm-version", "3.24.0");
    expect(window.document.getElementById("artifact-source-guide")?.textContent).toContain(
      'npm view "firecrawl-mcp@3.24.0"',
    );
    expect(window.document.getElementById("artifact-source-guide")?.textContent).toContain(
      "computes the downloaded tarball SHA-256 and observed SHA-512 itself",
    );

    window.close();
  });

  it("turns a directory claim into a reviewable exact candidate without inferring authority or execution", async () => {
    const window = studio();
    openArtifact(window, "mcp");
    input(window, "artifact-default-owner", "platform@acme.example");
    input(window, "artifact-item-id", "firecrawl-directory");
    setValue(window, "artifact-source-type", "directory");
    window.document
      .getElementById("artifact-source-type")
      ?.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    input(window, "artifact-directory-url", "https://www.pulsemcp.com/servers/firecrawl");

    expect(window.document.getElementById("artifact-source-guide")?.textContent).toContain(
      "directory claim",
    );
    click(window, window.document.getElementById("add-artifact-item"));
    const queued = ArtifactIntakeV2Schema.parse(api(window).snapshot().intake);
    expect(queued).toMatchObject({
      version: 2,
      authority: { state: "not-authority" },
      items: [
        {
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    expect(queued.items[0]).not.toHaveProperty("targets");
    expect(queued.items[0]).not.toHaveProperty("execution");

    await api(window).mergeEvidenceText(JSON.stringify(directoryEvidence(queued)));
    await settle(window);
    const row = window.document.querySelector('[data-artifact-row="firecrawl-directory"]');
    expect(row?.textContent).toContain("Directory version mismatch");
    expect(row?.textContent).toContain("3.7.4 → 3.24.0");
    expect(row?.textContent).toContain("firecrawl-mcp@3.24.0");
    expect(row?.textContent).toContain("FIRECRAWL_API_KEY");
    expect(row?.textContent).toContain("Scan still required");

    click(window, row?.querySelector('[data-artifact-option="npm-firecrawl-mcp-3.24.0"]') ?? null);
    const selected = ArtifactIntakeV2Schema.parse(api(window).snapshot().intake);
    expect(selected.items[0]).toMatchObject({
      discoveryUrl: "https://www.pulsemcp.com/servers/firecrawl",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "firecrawl-mcp",
        version: "3.24.0",
      },
    });
    expect(selected.items[0]).not.toHaveProperty("execution");
    expect(selected.items[0]).not.toHaveProperty("targets");
    expect(window.document.getElementById("artifact-intake-message")?.textContent).toContain(
      "download the updated intake and scan",
    );

    window.close();
  }, 15_000);

  it("does not apply directory resolution history to a changed source or owner", async () => {
    const window = studio();
    const original = ArtifactIntakeV2Schema.parse({
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    await api(window).importIntakeText(JSON.stringify(original));
    await api(window).mergeEvidenceText(JSON.stringify(directoryEvidence(original)));

    const changedSource = ArtifactIntakeV2Schema.parse({
      ...original,
      items: [
        {
          ...original.items[0],
          source: {
            type: "directory",
            provider: "mcpmarket",
            url: "https://mcpmarket.com/server/firecrawl",
          },
        },
      ],
    });
    await api(window).importIntakeText(JSON.stringify(changedSource));
    await settle(window);
    let row = window.document.querySelector('[data-artifact-row="firecrawl-directory"]');
    expect(row?.textContent).toContain("Stale directory resolution");
    expect(row?.querySelectorAll("[data-artifact-option]")).toHaveLength(0);

    const changedOwner = ArtifactIntakeV2Schema.parse({
      ...original,
      defaults: { accountableOwner: "different-owner@acme.example" },
    });
    await api(window).importIntakeText(JSON.stringify(changedOwner));
    await settle(window);
    row = window.document.querySelector('[data-artifact-row="firecrawl-directory"]');
    expect(row?.textContent).toContain("Mismatched directory resolution");
    expect(row?.querySelectorAll("[data-artifact-option]")).toHaveLength(0);

    window.close();
  });

  it("blocks conflicting directory resolution history instead of choosing the last import", async () => {
    const window = studio();
    const source = ArtifactIntakeV2Schema.parse({
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    const first = directoryEvidence(source);
    const conflicting = structuredClone(first);
    const resolution = conflicting.resolutions[0];
    const result = conflicting.results[0];
    if (
      resolution === undefined ||
      result === undefined ||
      resolution.resolution.registry === undefined
    ) {
      throw new Error("expected directory resolution bundle");
    }
    resolution.resolution.registry.version = "3.25.0";
    const npmOption = resolution.resolution.options.find((option) => option.source.type === "npm");
    if (npmOption === undefined || npmOption.source.type !== "npm") {
      throw new Error("expected npm resolution option");
    }
    const registryNpmSource = resolution.resolution.registry.sources.find(
      (source) => source.type === "npm",
    );
    if (registryNpmSource === undefined || registryNpmSource.type !== "npm") {
      throw new Error("expected npm registry source");
    }
    npmOption.id = "npm-firecrawl-mcp-3.25.0";
    npmOption.source.version = "3.25.0";
    npmOption.server.version = "3.25.0";
    registryNpmSource.version = "3.25.0";
    const versionConflict = resolution.resolution.conflicts.find(
      (conflict) => conflict.field === "version",
    );
    if (versionConflict === undefined) throw new Error("expected version conflict");
    versionConflict.observed = "3.25.0";
    const { resolutionDigest: _resolutionDigest, ...resolutionUnsigned } = resolution;
    resolution.resolutionDigest = artifactDirectoryResolutionDigestV2(resolutionUnsigned);
    result.resolutionDigest = resolution.resolutionDigest;
    const { bundleDigest: _bundleDigest, ...bundleUnsigned } = conflicting;
    conflicting.bundleDigest = artifactEvidenceBundleDigestV2(bundleUnsigned);

    await api(window).importIntakeText(JSON.stringify(source));
    await api(window).mergeEvidenceText(JSON.stringify(first));
    await api(window).mergeEvidenceText(JSON.stringify(conflicting));
    await settle(window);

    const row = window.document.querySelector('[data-artifact-row="firecrawl-directory"]');
    expect(row?.textContent).toContain("Conflicting directory resolution history");
    expect(row?.querySelectorAll("[data-artifact-option]")).toHaveLength(0);
    window.close();
  });

  it("preserves every canonical remote option when a directory advertises a retired endpoint", async () => {
    const window = studio();
    const intake = atlassianDirectoryIntake();
    await api(window).importIntakeText(JSON.stringify(intake));
    await api(window).mergeEvidenceText(JSON.stringify(atlassianDirectoryEvidence(intake)));
    await settle(window);

    const row = window.document.querySelector('[data-artifact-row="atlassian-directory"]');
    expect(row?.textContent).toContain("Directory endpoint mismatch");
    expect(row?.textContent).toContain("https://mcp.atlassian.com/v1/sse");
    expect(row?.textContent).toContain("https://mcp.atlassian.com/v1/mcp");
    expect(row?.textContent).toContain("https://mcp.atlassian.com/v1/mcp/authv2");
    const remoteButtons = [...(row?.querySelectorAll("[data-artifact-option]") ?? [])];
    expect(remoteButtons).toHaveLength(2);
    expect(
      remoteButtons.every((button) => (button as unknown as { disabled: boolean }).disabled),
    ).toBe(false);
    click(window, remoteButtons[0] ?? null);
    expect((window.document.body as unknown as { dataset: { view: string } }).dataset.view).toBe(
      "author",
    );
    expect(
      (window.document.getElementById("protected-subject-id") as unknown as { value: string })
        .value,
    ).toBe("atlassian-directory");
    expect(
      (window.document.getElementById("protected-source-type") as unknown as { value: string })
        .value,
    ).toBe("remote");
    expect(
      (window.document.getElementById("protected-source-endpoint") as unknown as { value: string })
        .value,
    ).toBe("https://mcp.atlassian.com/v1/mcp");
    expect(
      (
        window.document.getElementById("protected-source-content-digest") as unknown as {
          value: string;
        }
      ).value,
    ).toBe("");
    expect(
      (window.document.getElementById("protected-actor") as unknown as { value: string }).value,
    ).toBe("");
    expect(window.document.getElementById("artifact-intake-message")?.textContent).toContain(
      "Exact hosted endpoint",
    );
    expect(api(window).snapshot().intake).toEqual(intake);

    window.close();
  });

  it("rejects a recomputed V2 bundle whose resolution state contradicts its conflicts", async () => {
    const window = studio();
    const intake = ArtifactIntakeV2Schema.parse({
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    const bundle = structuredClone(directoryEvidence(intake));
    const resolution = bundle.resolutions[0];
    const result = bundle.results[0];
    if (resolution === undefined || result === undefined) {
      throw new Error("expected directory resolution bundle");
    }
    resolution.resolution.state = "resolved";
    const { resolutionDigest: _resolutionDigest, ...resolutionUnsigned } = resolution;
    resolution.resolutionDigest = artifactDirectoryResolutionDigestV2(resolutionUnsigned);
    result.resolutionDigest = resolution.resolutionDigest;
    const { bundleDigest: _bundleDigest, ...bundleUnsigned } = bundle;
    bundle.bundleDigest = artifactEvidenceBundleDigestV2(bundleUnsigned);

    await expect(api(window).mergeEvidenceText(JSON.stringify(bundle))).rejects.toThrow(
      /resolved state cannot contain conflicts/i,
    );
    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("rejects a recomputed directory option that is not bound to the selected registry server", async () => {
    const window = studio();
    const intake = ArtifactIntakeV2Schema.parse({
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    const bundle = structuredClone(directoryEvidence(intake));
    const option = bundle.resolutions[0]?.resolution.options[0];
    if (option === undefined) throw new Error("expected directory option");
    option.server = { name: "io.attacker/unrelated-server", version: "3.24.0" };
    rehashDirectoryEvidence(bundle);

    await expect(api(window).mergeEvidenceText(JSON.stringify(bundle))).rejects.toThrow(
      /option server binding/i,
    );
    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("rejects a recomputed directory package absent from the selected registry record", async () => {
    const window = studio();
    const intake = ArtifactIntakeV2Schema.parse({
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
      ],
    });
    const bundle = structuredClone(directoryEvidence(intake));
    const option = bundle.resolutions[0]?.resolution.options[0];
    if (option === undefined || option.source.type !== "npm") {
      throw new Error("expected npm directory option");
    }
    option.source.package = "unrelated-mcp";
    rehashDirectoryEvidence(bundle);

    await expect(api(window).mergeEvidenceText(JSON.stringify(bundle))).rejects.toThrow(
      /option source binding/i,
    );
    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("rejects unsupported integrity or path fields instead of dropping them during selection", async () => {
    for (const field of ["integrity", "path"] as const) {
      const window = studio();
      const intake = ArtifactIntakeV2Schema.parse({
        format: "aih-artifact-intake",
        version: 2,
        authority: { state: "not-authority" },
        defaults: { accountableOwner: "platform@acme.example" },
        items: [
          {
            id: "firecrawl-directory",
            kind: "mcp",
            source: {
              type: "directory",
              provider: "pulsemcp",
              url: "https://www.pulsemcp.com/servers/firecrawl",
            },
          },
        ],
      });
      const bundle = structuredClone(directoryEvidence(intake)) as unknown as ReturnType<
        typeof directoryEvidence
      > & {
        resolutions: Array<{
          resolution: { options: Array<{ source: Record<string, unknown> }> };
        }>;
      };
      const option = bundle.resolutions[0]?.resolution.options[0];
      if (option === undefined) throw new Error("expected directory option");
      option.source[field] = field === "integrity" ? REGISTRY_INTEGRITY : "packages/server";
      rehashDirectoryEvidence(bundle);

      await expect(api(window).mergeEvidenceText(JSON.stringify(bundle))).rejects.toThrow(
        new RegExp(`unknown member ${field}`, "i"),
      );
      expect(api(window).snapshot().bundleCount).toBe(0);
      window.close();
    }
  });

  it("rejects credential-bearing endpoint conflicts before rendering them", async () => {
    const window = studio();
    const intake = atlassianDirectoryIntake();
    const bundle = structuredClone(atlassianDirectoryEvidence(intake));
    const conflict = bundle.resolutions[0]?.resolution.conflicts.find(
      (entry) => entry.field === "endpoint",
    );
    if (conflict === undefined) throw new Error("expected endpoint conflict");
    conflict.claimed = "https://user:secret@mcp.atlassian.com/v1/sse";
    rehashDirectoryEvidence(bundle);

    await expect(api(window).mergeEvidenceText(JSON.stringify(bundle))).rejects.toThrow(
      /endpoint conflict claimed/i,
    );
    expect(window.document.body.textContent).not.toContain("user:secret");
    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("makes the 100-item capacity usable with a visible count, source deduplication, and filtering", async () => {
    const window = studio();
    await api(window).importIntakeText(JSON.stringify(intakeBatch(100)));

    expect(window.document.getElementById("artifact-intake-summary")?.textContent).toContain(
      "100 / 100 candidates",
    );
    expect(window.document.getElementById("artifact-intake-summary")?.textContent).toContain(
      "1 unique exact source",
    );
    expect(
      (window.document.getElementById("add-artifact-item") as unknown as { disabled: boolean })
        .disabled,
    ).toBe(true);
    expect(window.document.querySelectorAll("[data-artifact-row]")).toHaveLength(100);

    input(window, "artifact-queue-filter", "artifact-099");
    expect(
      [...window.document.querySelectorAll("[data-artifact-row]")].filter(
        (row) => !(row as unknown as { hidden: boolean }).hidden,
      ),
    ).toHaveLength(1);

    window.close();
  });

  it("rejects target claims and missing non-authority markers at the browser boundary", async () => {
    const window = studio();
    const targetClaim = structuredClone(intake()) as unknown as {
      defaults: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    };
    targetClaim.defaults.targets = ["codex"];
    await expect(api(window).importIntakeText(JSON.stringify(targetClaim))).rejects.toThrow(
      /unknown member targets/i,
    );
    targetClaim.defaults = { accountableOwner: "platform@acme.example" };
    const firstItem = targetClaim.items[0];
    if (firstItem === undefined) throw new Error("expected intake item");
    firstItem.targets = ["codex"];
    await expect(api(window).importIntakeText(JSON.stringify(targetClaim))).rejects.toThrow(
      /unknown member targets/i,
    );
    delete firstItem.targets;
    firstItem.execution = { transport: "stdio", resolver: "npx" };
    await expect(api(window).importIntakeText(JSON.stringify(targetClaim))).rejects.toThrow(
      /unknown member execution/i,
    );

    const missingAuthority = structuredClone(intake()) as unknown as Record<string, unknown>;
    delete missingAuthority.authority;
    await expect(api(window).importIntakeText(JSON.stringify(missingAuthority))).rejects.toThrow(
      /missing authority/i,
    );

    expect(api(window).snapshot().intake).toBeNull();
    window.close();
  });

  it("rejects evidence summaries that contradict their records in the browser", async () => {
    const window = studio();
    await api(window).importIntakeText(JSON.stringify(intake()));
    const contradictory = structuredClone(evidence("contradictory"));
    const result = contradictory.results[0];
    if (result === undefined) throw new Error("expected evidence result");
    result.state = "failed";
    const { bundleDigest: _bundleDigest, ...unsigned } = contradictory;
    contradictory.bundleDigest = artifactEvidenceBundleDigestV1(unsigned);

    await expect(api(window).mergeEvidenceText(JSON.stringify(contradictory))).rejects.toThrow(
      /result does not match evidence record/i,
    );
    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("rejects evidence target claims and observed npm pins that differ from intake", async () => {
    const window = studio();
    const pinned = intake("3.24.0", REGISTRY_INTEGRITY);
    await api(window).importIntakeText(JSON.stringify(pinned));

    const targetClaim = structuredClone(evidence("target claim", pinned)) as unknown as {
      evidence: Array<Record<string, unknown>>;
    };
    const targetRecord = targetClaim.evidence[0];
    if (targetRecord === undefined) throw new Error("expected evidence record");
    targetRecord.targets = ["codex"];
    await expect(api(window).mergeEvidenceText(JSON.stringify(targetClaim))).rejects.toThrow(
      /unknown member targets/i,
    );

    const mismatched = structuredClone(evidence("mismatched pin", pinned));
    const record = mismatched.evidence[0];
    if (record === undefined || record.observed.type !== "npm") {
      throw new Error("expected npm evidence record");
    }
    record.observed.registryIntegrity = OTHER_REGISTRY_INTEGRITY;
    const { evidenceDigest: _evidenceDigest, ...recordUnsigned } = record;
    record.evidenceDigest = artifactEvidenceDigestV1(recordUnsigned);
    const { bundleDigest: _bundleDigest, ...bundleUnsigned } = mismatched;
    mismatched.bundleDigest = artifactEvidenceBundleDigestV1(bundleUnsigned);
    await expect(api(window).mergeEvidenceText(JSON.stringify(mismatched))).rejects.toThrow(
      /observed registry integrity mismatch/i,
    );

    expect(api(window).snapshot().bundleCount).toBe(0);
    window.close();
  });

  it("builds an item without handwritten JSON and preserves evidence history across source updates", async () => {
    const window = studio();
    input(window, "artifact-default-owner", "platform@acme.example");
    input(window, "artifact-item-id", "firecrawl-mcp");
    input(window, "artifact-npm-package", "firecrawl-mcp");
    input(window, "artifact-npm-version", "3.24.0");
    click(window, window.document.getElementById("add-artifact-item"));

    expect(api(window).snapshot().intake).toMatchObject({
      format: "aih-artifact-intake",
      authority: { state: "not-authority" },
      items: [expect.objectContaining({ id: "firecrawl-mcp", kind: "mcp" })],
    });
    expect(JSON.stringify(api(window).snapshot().intake)).not.toContain('"targets"');
    expect(JSON.stringify(api(window).snapshot().intake)).not.toContain('"execution"');
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Missing scan evidence",
    );

    await api(window).mergeEvidenceText(JSON.stringify(evidence("first")));
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Verified preflight",
    );
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Authority absent",
    );

    await api(window).importIntakeText(JSON.stringify(intake("3.25.0")));
    expect(api(window).snapshot().bundleCount).toBe(1);
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Stale evidence",
    );

    window.close();
  });

  it("carries verified source, evidence, and owner into approval but leaves targets authoritative", async () => {
    const window = studio();
    setValue(window, "preset-select", "enterprise");
    window.document
      .getElementById("preset-select")
      ?.dispatchEvent(new window.Event("change", { bubbles: true }));
    await api(window).importIntakeText(JSON.stringify(intake()));
    const bundle = evidence("ready for organization review");
    await api(window).mergeEvidenceText(JSON.stringify(bundle));
    setValue(window, "protected-targets", "claude");

    const handoff = window.document.querySelector("[data-artifact-approve]");
    expect(handoff?.textContent).toContain("Continue to approval");
    click(window, handoff);

    expect((window.document.body as unknown as { dataset: { view: string } }).dataset.view).toBe(
      "author",
    );
    expect(
      (window.document.getElementById("protected-kind") as unknown as { value: string }).value,
    ).toBe("mcp");
    expect(
      (window.document.getElementById("protected-subject-id") as unknown as { value: string })
        .value,
    ).toBe("firecrawl-mcp");
    expect(
      (window.document.getElementById("protected-source-package") as unknown as { value: string })
        .value,
    ).toBe("firecrawl-mcp");
    expect(
      (window.document.getElementById("protected-source-version") as unknown as { value: string })
        .value,
    ).toBe("3.24.0");
    expect(
      (window.document.getElementById("protected-source-integrity") as unknown as { value: string })
        .value,
    ).toBe(
      bundle.evidence[0]?.observed.type === "npm"
        ? bundle.evidence[0].observed.registryIntegrity
        : "",
    );
    expect(
      (window.document.getElementById("protected-evidence-id") as unknown as { value: string })
        .value,
    ).toMatch(/^scan-firecrawl-mcp-[a-f0-9]{12}$/);
    expect(
      (window.document.getElementById("protected-evidence-digest") as unknown as { value: string })
        .value,
    ).toBe("");
    expect(
      (window.document.getElementById("protected-actor") as unknown as { value: string }).value,
    ).toBe("platform@acme.example");
    expect(
      (window.document.getElementById("protected-targets") as unknown as { value: string }).value,
    ).toBe("");
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "firecrawl-mcp",
    );
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "64 decisions per file",
    );
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "choose authorized targets",
    );
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "separate canonical organization evidence envelope",
    );

    const now = Date.now();
    const protectedFields: Record<string, string> = {
      "protected-bundle-version": "acme-artifacts-1",
      "protected-issuer-repository": "acme/aih-policy",
      "protected-issuer": "acme-security",
      "protected-issued-at": new Date(now - 2 * 60_000).toISOString(),
      "protected-expires-at": new Date(now + 12 * 60 * 60_000).toISOString(),
      "protected-targets": "codex",
      "protected-effects": "observe,use",
      "protected-attestor": "acme-scanner",
      "protected-policy-id": "enterprise-policy",
      "protected-policy-version": "1",
      "protected-policy-digest": `sha256:${"c".repeat(64)}`,
      "protected-control-id": "artifact-admission",
      "protected-control-digest": `sha256:${"d".repeat(64)}`,
      "protected-reason": "Approved after reviewed enterprise preflight evidence",
    };
    for (const [id, value] of Object.entries(protectedFields)) input(window, id, value);
    await submitProtected(window);

    const canonicalEnvelope = (
      window.document.getElementById("protected-evidence-preview") as unknown as { value: string }
    ).value;
    const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(
      Buffer.from(canonicalEnvelope, "utf8"),
    );
    expect(envelope).toBeDefined();
    if (envelope === undefined) throw new Error("expected canonical organization evidence");
    expect(envelope?.evidence.payloadDigest).toBe(bundle.evidence[0]?.evidenceDigest);
    const organizationEvidenceDigest = organizationEvidenceEnvelopeDigestV1(envelope);
    expect(organizationEvidenceDigest).not.toBe(bundle.evidence[0]?.evidenceDigest);

    const protectedBundle = JSON.parse(
      (window.document.getElementById("protected-bundle-preview") as unknown as { value: string })
        .value,
    );
    const decision = protectedBundle.authorityReceipt.decisions[0];
    expect(decision.qualificationBasis.evidenceDigest).toBe(organizationEvidenceDigest);
    expect(decision.evidence.digest).toBe(organizationEvidenceDigest);
    expect(decision.evidence.id).toBe(envelope?.evidence.id);
    expect(decision.subject.subjectDigest).toBe(envelope?.subjectDigest);

    const root = mkdtempSync(join(tmpdir(), "aih-workbench-qualification-"));
    const bin = mkdtempSync(join(tmpdir(), "aih-workbench-gh-"));
    try {
      const authorityDir = join(root, ".aih");
      mkdirSync(authorityDir, { recursive: true });
      writeFileSync(
        join(authorityDir, "policy-authority-receipt.json"),
        JSON.stringify(protectedBundle.authorityReceipt),
      );
      const gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
      writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
      const trustedGh = realpathSync.native(gh);
      const run = fakeRunner((argv) =>
        argv[0] === trustedGh && argv[1] === "attestation" && argv[2] === "verify"
          ? { code: 0 }
          : { code: 1 },
      );
      const ctx: PlanContext = {
        root,
        contextDir: "ai-coding",
        posture: "enterprise",
        apply: false,
        verify: false,
        json: false,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/aih-policy", PATH: bin },
        options: {},
      };
      const verification = await verifyPolicyAuthorityReceipt(ctx);
      expect(verification.authority, verification.problem).toBeDefined();
      expect(
        verifyOrganizationQualificationV1({
          authority: verification.authority,
          bytes: Buffer.from(canonicalEnvelope, "utf8"),
          decisionReference: {
            id: decision.id,
            digest: governanceDecisionDigestV2(decision),
          },
          effect: "observe",
          now: new Date(now).toISOString(),
          subject: decision.subject,
          supportedTargets: ["codex"],
          target: "codex",
        }),
      ).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }

    window.close();
  });

  it("detects replayed evidence and rejects duplicate JSON members without losing history", async () => {
    const window = studio();
    await api(window).importIntakeText(JSON.stringify(intake()));
    await api(window).mergeEvidenceText(JSON.stringify(evidence("first")));
    await api(window).mergeEvidenceText(JSON.stringify(evidence("different")));

    expect(api(window).snapshot().bundleCount).toBe(2);
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Replayed/conflicting evidence",
    );
    await expect(
      api(window).mergeEvidenceText(
        '{"format":"aih-preflight-evidence-bundle","format":"other","version":1}',
      ),
    ).rejects.toThrow(/duplicate JSON object key/i);
    expect(api(window).snapshot().bundleCount).toBe(2);

    window.close();
  });
});
