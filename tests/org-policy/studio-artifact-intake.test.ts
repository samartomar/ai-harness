import { TextEncoder } from "node:util";
import { type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import {
  artifactEvidenceRecordV1,
  createArtifactEvidenceBundleV1,
} from "../../src/trust/artifact-evidence.js";
import { ArtifactIntakeV1Schema } from "../../src/trust/artifact-intake.js";

interface IntakeApi {
  importIntakeText(text: string): Promise<void>;
  mergeEvidenceText(text: string): Promise<void>;
  snapshot(): { intake: Record<string, unknown> | null; bundleCount: number };
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

function setValue(window: Window, id: string, value: string): void {
  const input = window.document.getElementById(id) as unknown as { value: string } | null;
  if (input === null) throw new Error(`expected #${id}`);
  input.value = value;
}

function intake(version = "3.24.0") {
  return ArtifactIntakeV1Schema.parse({
    format: "aih-artifact-intake",
    version: 1,
    defaults: { accountableOwner: "platform@acme.example", targets: ["codex"] },
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
        },
        execution: { transport: "stdio", resolver: "npx" },
      },
    ],
  });
}

function evidence(detail: string) {
  const source = intake();
  const item = source.items[0];
  if (item === undefined) throw new Error("expected intake item");
  return createArtifactEvidenceBundleV1(source, [
    artifactEvidenceRecordV1({
      intake: source,
      item,
      state: "verified",
      observed: {
        type: "npm",
        tarballSha256: `sha256:${"b".repeat(64)}`,
        registryIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      },
      analyzersRun: ["aih-native"],
      checks: [{ name: "trust scan", verdict: "pass", detail }],
      findings: [],
    }),
  ]);
}

describe("Policy Workbench artifact intake", () => {
  it("offers one scalable Add/import/scan/review path for MCP, Skill, and Agent sources", () => {
    const window = studio();
    const card = window.document.getElementById("artifact-intake-review");

    expect(card?.textContent).toContain("Add MCP, Skill, or Agent");
    expect(card?.textContent).toContain("one accountable owner email");
    expect(card?.textContent).toContain(
      "aih trust scan aih-artifact-intake.json --apply --evidence-out aih-artifact-evidence.json",
    );
    expect(card?.textContent).toContain("Preflight only");
    expect(card?.textContent).not.toContain("Record Agent");
    expect(card?.querySelector('a[href="https://mcpmarket.com/"]')).not.toBeNull();
    expect(card?.querySelector('a[href="https://www.skills.sh/"]')).not.toBeNull();
    expect(window.document.getElementById("import-artifact-intake")?.textContent).toContain(
      "Import artifact intake",
    );
    expect(window.document.getElementById("import-artifact-evidence")?.textContent).toContain(
      "Merge scan evidence",
    );

    window.close();
  });

  it("builds an item without handwritten JSON and preserves evidence history across source updates", async () => {
    const window = studio();
    setValue(window, "artifact-default-owner", "platform@acme.example");
    setValue(window, "artifact-default-targets", "codex");
    setValue(window, "artifact-item-id", "firecrawl-mcp");
    setValue(window, "artifact-npm-package", "firecrawl-mcp");
    setValue(window, "artifact-npm-version", "3.24.0");
    click(window, window.document.getElementById("add-artifact-item"));

    expect(api(window).snapshot().intake).toMatchObject({
      format: "aih-artifact-intake",
      items: [expect.objectContaining({ id: "firecrawl-mcp", kind: "mcp" })],
    });
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
