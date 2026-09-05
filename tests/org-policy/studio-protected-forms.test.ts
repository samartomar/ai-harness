import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { parsePolicyBundle } from "../../src/org-policy/schema.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyEnterpriseStudioModel, tinyStudioModel } from "./studio-test-fixture.js";

const openWindows = new Set<Window>();
const sha = (character: string) => `sha256:${character.repeat(64)}`;

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
  "protected-evidence-digest": sha("b"),
  "protected-attestor": "acme-scanner",
  "protected-policy-id": "enterprise-policy",
  "protected-policy-version": "1",
  "protected-policy-digest": sha("c"),
  "protected-control-id": "tool-admission",
  "protected-control-digest": sha("d"),
  "protected-actor": "ruchi.admin@acme.example",
  "protected-reason": "Approved after attributable scanner evidence review",
} as const;

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

function studio(enterprise = false): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(enterprise ? tinyEnterpriseStudioModel() : tinyStudioModel());
  window.document.write(html);
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: globalThis.crypto,
  });
  Object.defineProperty(window, "TextEncoder", {
    configurable: true,
    value: TextEncoder,
  });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
}

function value(window: Window, id: string): string {
  const node = window.document.getElementById(id) as unknown as {
    value: string;
  } | null;
  if (node === null) throw new Error(`expected #${id}`);
  return node.value;
}

function text(window: Window, id: string): string {
  return window.document.getElementById(id)?.textContent ?? "";
}

function setValue(window: Window, id: string, entry: string): void {
  const node = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error(`expected #${id}`);
  node.value = entry;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function fillProtectedFields(
  window: Window,
  overrides: Readonly<Record<string, string>> = {},
): void {
  for (const [id, entry] of Object.entries({
    ...protectedFields,
    ...overrides,
  }))
    setValue(window, id, entry);
}

function enableEnterprise(window: Window): void {
  setValue(window, "posture", "enterprise");
  expect(JSON.parse(value(window, "config-preview")).minimumPosture).toBe("enterprise");
}

async function submitProtected(window: Window): Promise<void> {
  const pending = window as unknown as {
    __aihPolicyWorkbenchPending?: Promise<void>;
  };
  pending.__aihPolicyWorkbenchPending = undefined;
  window.document
    .getElementById("protected-form")
    ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  if (pending.__aihPolicyWorkbenchPending === undefined)
    throw new Error("protected authoring did not start");
  await pending.__aihPolicyWorkbenchPending;
}

describe("retained protected authority form obligations", () => {
  it("authors an organization-qualified protected decision through fields accepted by Core", async () => {
    const window = studio(true);
    enableEnterprise(window);
    fillProtectedFields(window);
    await submitProtected(window);

    const bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.authorityReceipt.decisions[0]).toMatchObject({
      id: "decision-acme-linter-1",
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest: sha("b"),
      },
      subject: {
        kind: "tool",
        id: "acme-linter",
        source: {
          type: "github",
          repository: "acme/linter",
          commit: "a".repeat(40),
        },
      },
      targets: ["codex"],
      allowedEffects: ["observe", "use"],
    });
  });

  it("authors the exact AIH-supported qualification binding required by a signed receipt", async () => {
    const window = studio(true);
    enableEnterprise(window);
    fillProtectedFields(window, {
      "protected-qualification-kind": "aih-supported",
      "protected-kind": "profile",
      "protected-subject-id": "default-profile",
      "protected-source-type": "aih",
      "protected-source-release": "1.0.0",
      "protected-source-revision":
        "sha256:1492fa09fc057e2e3659ca5ad3d143ba5a4b529a2b18e027b5e40a75439518c9",
      "protected-catalog-signer": "administrator:aih-supported/catalog-v2",
      "protected-catalog-digest":
        "sha256:7e4ed0d0a5b1e0c053f5f25aeb2811ece87cc06f443b6241a47806fda05e304a",
      "protected-catalog-head-digest":
        "sha256:5b27c7d7c33afa0da41e06c4e62e91c94db238b04fbedfdad6a69d21aba1880f",
      "protected-catalog-member-digest":
        "sha256:6f9a4264ba9f1efa3be4e6db78376a4c7d40d155755e02b4e4c55978bcd0a6a7",
    });
    await submitProtected(window);

    const bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.authorityReceipt.decisions[0].qualificationBasis).toMatchObject({
      kind: "aih-supported",
      catalogSignerIdentity: "administrator:aih-supported/catalog-v2",
      subjectKind: "profile",
    });
  });

  it("refuses incomplete AIH-supported catalog binding without emitting a bundle", () => {
    const window = studio(true);
    enableEnterprise(window);
    fillProtectedFields(window, {
      "protected-qualification-kind": "aih-supported",
      "protected-catalog-signer": "administrator:aih-supported/catalog-v2",
      "protected-catalog-digest": sha("1"),
      "protected-catalog-head-digest": sha("2"),
      "protected-catalog-member-digest": "",
    });

    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "protected-catalog-member-digest-error")).toContain(
      "exact catalog member digest",
    );
  });

  it("refuses inherited non-NFC custom source text without emitting a protected bundle", async () => {
    const window = studio(true);
    enableEnterprise(window);
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-owner", "mcp.owner@acme.example"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", sha("a")],
      ["custom-evidence", "acme-scan-001"],
      ["custom-note", "Cafe\u0301 review"],
    ] as const)
      setValue(window, id, entry);
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    fillProtectedFields(window);
    await submitProtected(window);

    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "announcement")).toContain("must already be NFC");
  });
  it("refuses protected authority while the ordinary posture remains Vibe", async () => {
    const window = studio();
    fillProtectedFields(window);
    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "protected-bundle-version-error")).toContain("Enterprise posture");
    expect(text(window, "announcement")).not.toContain("protected policy file is ready");
  });

  it("refuses a protected decision whose validity window exceeds 90 days", () => {
    const window = studio(true);
    enableEnterprise(window);
    fillProtectedFields(window, {
      "protected-expires-at": "2026-12-01T12:00:00Z",
    });

    window.document
      .getElementById("protected-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(value(window, "protected-bundle-preview")).toBe("");
    expect(text(window, "protected-expires-at-error")).toContain("within 90 days");
  });

  it("authors exact npm, PyPI, OCI, and remote provider identities", async () => {
    const providers = [
      {
        type: "npm",
        fields: {
          "protected-source-registry": "https://registry.npmjs.org/",
          "protected-source-package": "@acme/linter",
          "protected-source-version": "1.2.3",
          "protected-source-integrity": `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
      },
      {
        type: "pypi",
        fields: {
          "protected-source-registry": "https://pypi.org/",
          "protected-source-package": "acme-linter",
          "protected-source-version": "1!2.0rc1.post2",
          "protected-source-filename": "acme_linter-1.2.0.whl",
          "protected-source-sha256": sha("f"),
        },
      },
      {
        type: "oci",
        fields: {
          "protected-source-oci-registry": "ghcr.io",
          "protected-source-oci-repository": "acme/linter",
          "protected-source-index-digest": sha("1"),
          "protected-source-platform-os": "linux",
          "protected-source-platform-architecture": "amd64",
          "protected-source-manifest-digest": sha("2"),
        },
      },
      {
        type: "remote",
        fields: {
          "protected-source-endpoint": "https://mcp.acme.test/v1/server",
          "protected-source-content-digest": sha("3"),
        },
      },
    ] as const;

    for (const provider of providers) {
      const window = studio(true);
      enableEnterprise(window);
      fillProtectedFields(window, {
        "protected-source-type": provider.type,
        ...provider.fields,
      });
      await submitProtected(window);
      const bundle = JSON.parse(value(window, "protected-bundle-preview"));
      expect(parsePolicyBundle(bundle), provider.type).toMatchObject({
        ok: true,
      });
      expect(bundle.authorityReceipt.decisions[0].subject.source.type).toBe(provider.type);
    }
  });

  it("records distinct tool, skill, agent, MCP, and package decisions then revokes one", async () => {
    const window = studio(true);
    enableEnterprise(window);
    fillProtectedFields(window);
    await submitProtected(window);

    for (const [index, kind] of ["skill", "agent", "mcp", "package"].entries()) {
      fillProtectedFields(window, {
        "protected-decision-id": `decision-acme-${kind}-1`,
        "protected-kind": kind,
        "protected-subject-id": `acme-${kind}`,
        "protected-source-commit": String(index + 2).repeat(40),
        "protected-evidence-id": `acme-scan-00${index + 2}`,
      });
      await submitProtected(window);
    }

    let bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(
      bundle.authorityReceipt.decisions
        .map((decision: { subject: { kind: string } }) => decision.subject.kind)
        .sort(),
    ).toEqual(["agent", "mcp", "package", "skill", "tool"]);

    const revoke = window.document.querySelector('[data-protected-revoke="0"]');
    if (revoke === null) throw new Error("expected revocation control");
    revoke.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await (window as unknown as { __aihPolicyWorkbenchPending?: Promise<void> })
      .__aihPolicyWorkbenchPending;
    bundle = JSON.parse(value(window, "protected-bundle-preview"));
    expect(parsePolicyBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.authorityReceipt.decisionRevocations).toHaveLength(1);
  });
});
