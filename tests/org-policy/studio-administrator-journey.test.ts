import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parsePolicyBundle, readOrgPolicy } from "../../src/org-policy/schema.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

/**
 * The workflow test the original suite never had. Every recorded product
 * failure passed CI because the tests proved the narrowed implementation
 * contract - that a function returned what it was written to return - instead
 * of walking what an administrator actually does. This file walks the journey
 * in order and asserts what they can see at each step, so a regression in any
 * one row fails here as a broken workflow rather than as a changed constant.
 */

const model = policyStudioModel();
const controls = [...model.catalog.mcp.map((item) => item.control), ...model.catalog.hooks];
const inventoryCount = model.catalog.frameworks.reduce(
  (total, framework) => total + framework.assets.length,
  0,
);
const protectedFields = {
  "protected-bundle-version": "acme-policy-1",
  "protected-issuer-repository": "acme/aih-policy",
  "protected-issuer": "acme-security",
  "protected-issued-at": "2026-08-26T12:00:00Z",
  "protected-expires-at": "2026-09-25T12:00:00Z",
  "protected-decision-id": "decision-acme-linter-1",
  "protected-kind": "tool",
  "protected-subject-id": "acme-linter",
  "protected-source-repository": "acme/linter",
  "protected-source-commit": "a".repeat(40),
  "protected-source-path": "packages/cli",
  "protected-targets": "codex",
  "protected-effects": "observe,use",
  "protected-evidence-id": "acme-scan-001",
  "protected-evidence-digest": `sha256:${"b".repeat(64)}`,
  "protected-attestor": "acme-scanner",
  "protected-policy-id": "enterprise-policy",
  "protected-policy-version": "1",
  "protected-policy-digest": `sha256:${"c".repeat(64)}`,
  "protected-control-id": "tool-admission",
  "protected-control-digest": `sha256:${"d".repeat(64)}`,
  "protected-actor": "ruchi-admin",
  "protected-reason": "Approved after attributable scanner evidence review",
} as const;

function openWorkbench(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

const text = (window: Window, id: string): string =>
  window.document.getElementById(id)?.textContent ?? "";
const rowCount = (window: Window, id: string): number =>
  window.document.getElementById(id)?.querySelectorAll(".row").length ?? 0;
const value = (window: Window, id: string): string =>
  (window.document.getElementById(id) as unknown as { value: string } | null)?.value ?? "";

function chooseProfile(window: Window, profile: string): void {
  const preset = window.document.querySelector(`[data-preset="${profile}"]`);
  if (preset === null) throw new Error(`expected ${profile} preset`);
  preset.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function click(window: Window, id: string): void {
  window.document
    .getElementById(id)
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function setValue(window: Window, id: string, entry: string): void {
  const input = window.document.getElementById(id) as unknown as {
    value: string;
  } | null;
  if (input === null) throw new Error(`expected #${id}`);
  input.value = entry;
  window.document.getElementById(id)?.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.getElementById(id)?.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function fillProtectedFields(
  window: Window,
  overrides: Readonly<Record<string, string>> = {},
): void {
  for (const [id, entry] of Object.entries({ ...protectedFields, ...overrides }))
    setValue(window, id, entry);
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

describe("policy workbench administrator journey", () => {
  it("walks open -> survey -> compose -> inspect -> extend -> export", () => {
    const window = openWorkbench();

    // 1. OPEN. Nothing is selected, and nothing pretends to be.
    expect(value(window, "config-preview"), "a starting policy is authored").toContain(
      '"schemaVersion"',
    );
    expect(text(window, "mcp-rows"), "no control claims provenance yet").not.toContain(
      "Requested by:",
    );

    // 2. SURVEY. The main plane holds the non-duplicated inventory; the four
    //    ECC namespaces owned by the rail remain selectable there.
    const railOwned = model.catalog.frameworks
      .find((framework) => framework.id === "ecc")
      ?.assets.filter((asset) =>
        ["lang", "framework", "capability", "module"].includes(asset.kind),
      ).length;
    expect(rowCount(window, "framework-rows"), "non-duplicated inventory").toBe(
      inventoryCount - (railOwned ?? 0),
    );
    expect(text(window, "framework-rows")).toContain("Selectable");
    expect(text(window, "framework-rows")).toContain("installs and runs it");
    expect(text(window, "framework-rows")).toContain("aih evidence vet-baseline");

    // 3. COMPOSE. Choosing a posture composes a selection, not a label.
    chooseProfile(window, "enterprise");
    const composed = JSON.parse(value(window, "config-preview"));
    expect(composed.minimumPosture).toBe("enterprise");
    expect(
      composed.governance.activations
        .filter((item: { state: string }) => item.state === "active")
        .map((item: { candidate: string }) => item.candidate)
        .sort(),
    ).toEqual(controls.map((control) => control.id).sort());
    expect(text(window, "composition-parts"), "the composition is named").toContain("ECC");
    // Naming is not selection: the composition authors no curation records.
    expect(composed.governance.externalCuration).toEqual([]);

    // 4. INSPECT. The administrator can see what is selected, why, and what an
    //    AIH-owned hook will actually do at event time.
    expect(text(window, "mcp-rows"), "provenance").toContain("Requested by: enterprise profile");
    const hooks = text(window, "hook-rows");
    expect(hooks, "hook trigger").toContain("PostToolUse");
    expect(hooks, "hook artifact").toContain(".aih/usage.jsonl");
    expect(hooks, "hook cannot block").toContain("never blocks");
    expect(hooks, "pinned identity").toMatch(/sha256:[0-9a-f]{64}/);

    // 5. EXTEND. A custom source is accepted, stays blocked, and ends in a
    //    command rather than in nothing.
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", `sha256:${"a".repeat(64)}`],
      ["custom-evidence", "acme-scan-001"],
    ] as const) {
      const input = window.document.getElementById(id) as unknown as {
        value: string;
      } | null;
      if (input === null) throw new Error(`expected #${id}`);
      input.value = entry;
    }
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const custom = text(window, "custom-rows");
    expect(custom, "accepted").toContain("acme-mcp");
    expect(custom, "still fenced").toContain("Blocked");
    expect(custom, "exact next command").toContain("aih trust scan");
    expect(custom, "bound to its own pin").toContain("@acme/mcp-server");

    // 6. EXPORT. What they authored validates against the real policy grammar.
    click(window, "validate");
    expect(text(window, "announcement")).toContain("validation passed");
    const exported = JSON.parse(value(window, "config-preview"));
    expect(exported.governance.catalog.custom).toHaveLength(1);
    expect(exported.governance.catalog.reviewed).toHaveLength(controls.length);
  });

  // The journey must not depend on the order the administrator happens to take.
  it("composes the same selection whether the custom source is added first", () => {
    const window = openWorkbench();
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", `sha256:${"b".repeat(64)}`],
      ["custom-evidence", "acme-scan-002"],
    ] as const) {
      const input = window.document.getElementById(id) as unknown as {
        value: string;
      } | null;
      if (input === null) throw new Error(`expected #${id}`);
      input.value = entry;
    }
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    chooseProfile(window, "enterprise");
    const policy = JSON.parse(value(window, "config-preview"));
    expect(policy.governance.catalog.custom).toHaveLength(1);
    expect(policy.governance.catalog.reviewed).toHaveLength(controls.length);
    click(window, "validate");
    expect(text(window, "announcement")).toContain("validation passed");
  });

  it("authors a protected Enterprise policy file from form fields without raw JSON", async () => {
    const window = openWorkbench();
    chooseProfile(window, "enterprise");

    fillProtectedFields(window);

    const form = window.document.getElementById("protected-form");
    expect(form, "the existing Workbench owns the protected-file authoring surface").not.toBeNull();
    expect(
      form?.querySelectorAll("textarea:not([readonly])").length,
      "the administrator does not hand-author JSON",
    ).toBe(0);
    await submitProtected(window);

    const bundle = JSON.parse(value(window, "protected-bundle-preview"));
    const parsed = parsePolicyBundle(bundle);
    expect(parsed, "Core accepts the exact file emitted by the UI").toMatchObject({ ok: true });
    expect(bundle.policy.minimumPosture).toBe("enterprise");
    expect(bundle.authorityReceipt.decisions).toHaveLength(1);
    expect(bundle.authorityReceipt.decisions[0]).toMatchObject({
      id: "decision-acme-linter-1",
      actor: "ruchi-admin",
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest: `sha256:${"b".repeat(64)}`,
        attestor: "acme-scanner",
      },
      subject: {
        kind: "tool",
        id: "acme-linter",
        source: {
          type: "github",
          repository: "acme/linter",
          commit: "a".repeat(40),
          path: "packages/cli",
        },
      },
      targets: ["codex"],
      allowedEffects: ["observe", "use"],
    });
    expect(bundle.issuedAt).toBe("2026-08-26T12:00:00.000Z");
    expect(text(window, "announcement")).toContain("protected policy file is ready");
  });

  it("refuses protected Enterprise authoring until a supported CLI is sanctioned", async () => {
    const window = openWorkbench();
    setValue(window, "posture", "enterprise");
    expect(JSON.parse(value(window, "config-preview")).governance.supportedClis).toBeUndefined();
    fillProtectedFields(window);

    const pending = window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> };
    pending.__aihPolicyWorkbenchPending = undefined;
    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await pending.__aihPolicyWorkbenchPending;

    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(
      (window.document.getElementById("download-protected-bundle") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(window.document.querySelectorAll("#protected-decision-rows .row")).toHaveLength(0);
    expect(text(window, "protected-bundle-version-error")).toContain("supported CLI");
    expect(text(window, "announcement")).toContain("highlighted protected policy fields");
    expect(text(window, "announcement")).not.toContain("protected policy file is ready");
  });

  it("downloads NFC bytes accepted by Core's strict active-policy reader", async () => {
    const window = openWorkbench();
    chooseProfile(window, "enterprise");
    fillProtectedFields(window, {
      "protected-reason": "Approved after Cafe\u0301 evidence review",
    });
    await submitProtected(window);

    let downloaded: Blob | undefined;
    window.URL.createObjectURL = (blob: Blob): string => {
      downloaded = blob;
      return "blob:aih-policy-bundle";
    };
    window.URL.revokeObjectURL = (): void => undefined;
    window.HTMLAnchorElement.prototype.click = (): void => undefined;
    click(window, "download-protected-bundle");
    const pending = (window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> })
      .__aihPolicyWorkbenchPending;
    if (pending === undefined) throw new Error("protected download did not start");
    await pending;
    if (downloaded === undefined) throw new Error("protected download was not captured");
    const bytes = await downloaded.text();

    expect(bytes).toContain("Caf\u00e9 evidence review");
    expect(bytes).not.toContain("Cafe\u0301 evidence review");
    const targetRoot = mkdtempSync(join(tmpdir(), "aih-workbench-target-"));
    const adminRoot = mkdtempSync(join(tmpdir(), "aih-workbench-admin-"));
    try {
      const policyPath = join(adminRoot, "aih-policy-bundle.json");
      writeFileSync(policyPath, bytes);
      expect(readOrgPolicy(targetRoot, { AIH_ORG_POLICY: policyPath })).toMatchObject({
        minimumPosture: "enterprise",
      });
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(adminRoot, { recursive: true, force: true });
    }
  });

  it("refuses non-NFC content inherited from the composed policy", async () => {
    const window = openWorkbench();
    chooseProfile(window, "enterprise");
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", `sha256:${"b".repeat(64)}`],
      ["custom-evidence", "acme-scan-002"],
      ["custom-note", "Cafe\u0301 review"],
    ] as const) {
      setValue(window, id, entry);
    }
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    fillProtectedFields(window);

    await submitProtected(window);

    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "announcement")).toContain("must already be NFC");
  });

  it("refuses protected-file authority in Vibe posture and outside the 90-day window", () => {
    const window = openWorkbench();
    fillProtectedFields(window);
    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "protected-bundle-version-error")).toContain("Enterprise posture");

    chooseProfile(window, "enterprise");
    setValue(window, "protected-expires-at", "2026-12-01T12:00:00Z");
    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "protected-expires-at-error")).toContain("within 90 days");
  });

  it("authors tool, skill, MCP, and package approvals and a valid revocation", async () => {
    const window = openWorkbench();
    chooseProfile(window, "enterprise");
    fillProtectedFields(window);
    await submitProtected(window);

    for (const [index, kind] of ["skill", "mcp", "package"].entries()) {
      fillProtectedFields(window, {
        "protected-decision-id": `decision-acme-${kind}-1`,
        "protected-kind": kind,
        "protected-subject-id": `acme-${kind}`,
        "protected-source-commit": String(index + 2).repeat(40),
        "protected-evidence-id": `acme-scan-00${String(index + 2)}`,
      });
      await submitProtected(window);
    }

    let bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(
      bundle.authorityReceipt.decisions
        .map((decision: { subject: { kind: string } }) => decision.subject.kind)
        .sort(),
    ).toEqual(["mcp", "package", "skill", "tool"]);

    window.document
      .querySelector('[data-protected-revoke="0"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await (window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> })
      .__aihPolicyWorkbenchPending;
    bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.authorityReceipt.decisionRevocations).toHaveLength(1);
    expect(bundle.authorityReceipt.decisionRevocations[0].revokedAt).toBe(
      "2026-08-26T12:00:00.000Z",
    );
  });

  it("authors the exact AIH release identity used by an AIH-managed adapter", async () => {
    const window = openWorkbench();
    chooseProfile(window, "enterprise");
    fillProtectedFields(window, {
      "protected-decision-id": "decision-usage-metering",
      "protected-subject-id": "usage-metering",
      "protected-source-type": "aih",
      "protected-source-release": "0.1.1",
      "protected-source-revision": `sha256:${"e".repeat(64)}`,
      "protected-effects": "configure",
      "protected-targets": "claude,codex",
    });
    await submitProtected(window);

    const bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.authorityReceipt.decisions[0].subject.source).toEqual({
      type: "aih",
      release: "0.1.1",
      revision: `sha256:${"e".repeat(64)}`,
    });
    expect(text(window, "protected-decision-rows")).toContain("AIH 0.1.1");
    expect(text(window, "protected-decision-rows")).not.toContain("undefined");
  });

  it("authors every exact Decision V2 provider identity without hand-authored JSON", async () => {
    const providers = [
      {
        type: "npm",
        fields: {
          "protected-source-registry": "https://registry.npmjs.org/",
          "protected-source-package": "@acme/linter",
          "protected-source-version": "1.2.3",
          "protected-source-integrity": `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org/",
          package: "@acme/linter",
          version: "1.2.3",
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
      },
      {
        type: "pypi",
        fields: {
          "protected-source-registry": "https://pypi.org/",
          "protected-source-package": "acme-linter",
          "protected-source-version": "1!2.0rc1.post2",
          "protected-source-filename": "acme_linter-1.2.0.whl",
          "protected-source-sha256": `sha256:${"f".repeat(64)}`,
        },
        source: {
          type: "pypi",
          registry: "https://pypi.org/",
          package: "acme-linter",
          version: "1!2.0rc1.post2",
          filename: "acme_linter-1.2.0.whl",
          sha256: `sha256:${"f".repeat(64)}`,
        },
      },
      {
        type: "oci",
        fields: {
          "protected-source-oci-registry": "ghcr.io",
          "protected-source-oci-repository": "acme/linter",
          "protected-source-index-digest": `sha256:${"1".repeat(64)}`,
          "protected-source-platform-os": "linux",
          "protected-source-platform-architecture": "amd64",
          "protected-source-manifest-digest": `sha256:${"2".repeat(64)}`,
        },
        source: {
          type: "oci",
          registry: "ghcr.io",
          repository: "acme/linter",
          indexDigest: `sha256:${"1".repeat(64)}`,
          platform: { os: "linux", architecture: "amd64" },
          manifestDigest: `sha256:${"2".repeat(64)}`,
        },
      },
      {
        type: "remote",
        fields: {
          "protected-source-endpoint": "https://mcp.acme.test/v1/server",
          "protected-source-content-digest": `sha256:${"3".repeat(64)}`,
        },
        source: {
          type: "remote",
          endpoint: "https://mcp.acme.test/v1/server",
          contentDigest: `sha256:${"3".repeat(64)}`,
        },
      },
    ] as const;

    for (const provider of providers) {
      const window = openWorkbench();
      chooseProfile(window, "enterprise");
      fillProtectedFields(window, {
        "protected-source-type": provider.type,
        ...provider.fields,
      });
      await submitProtected(window);

      const bundle = JSON.parse(value(window, "protected-bundle-preview"));
      expect(parsePolicyBundle(bundle), provider.type).toMatchObject({ ok: true });
      expect(bundle.authorityReceipt.decisions[0].subject.source).toEqual(provider.source);
      expect(
        window.document.querySelectorAll("#protected-form textarea:not([readonly])"),
      ).toHaveLength(0);
      window.close();
    }
  });
});
