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
      ...(index % 3 === 0 ? { execution: { transport: "stdio", resolver: "npx" } } : {}),
    })),
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
    expect(card?.textContent).toContain("limited to 1 MiB");
    expect(card?.textContent).toContain("64 decisions per protected file");
    expect(card?.textContent).toContain("0 / 100 candidates");
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

  it("routes every organization-artifact entry point into the same queue with kind preselected", () => {
    const window = studio();

    for (const [id, kind] of [
      ["open-custom", "mcp"],
      ["open-custom-skill", "skill"],
      ["open-custom-agent", "agent"],
    ] as const) {
      click(window, window.document.getElementById(id));
      expect((window.document.body as unknown as { dataset: { view: string } }).dataset.view).toBe(
        "imports",
      );
      expect(
        (window.document.getElementById("artifact-item-kind") as unknown as { value: string })
          .value,
      ).toBe(kind);
      expect(
        (window.document.getElementById("authoring-sidebar") as unknown as { hidden: boolean })
          .hidden,
      ).toBe(true);
    }

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

  it("carries verified source, evidence, owner, and targets into protected approval", async () => {
    const window = studio();
    await api(window).importIntakeText(JSON.stringify(intake()));
    const bundle = evidence("ready for organization review");
    await api(window).mergeEvidenceText(JSON.stringify(bundle));

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
    ).toBe(bundle.evidence[0]?.id);
    expect(
      (window.document.getElementById("protected-evidence-digest") as unknown as { value: string })
        .value,
    ).toBe(bundle.evidence[0]?.evidenceDigest);
    expect(
      (window.document.getElementById("protected-actor") as unknown as { value: string }).value,
    ).toBe("platform@acme.example");
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "firecrawl-mcp",
    );
    expect(window.document.getElementById("organization-artifact-context")?.textContent).toContain(
      "64 decisions per file",
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
