import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";
import {
  type Element,
  type HTMLButtonElement,
  type HTMLInputElement,
  type HTMLTextAreaElement,
  Window,
} from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

interface EvidenceDraft {
  id: string;
  declaration: {
    kind: "imported-evidence";
    bytesBase64: string;
    byteLength: number;
    digest: string;
  };
}

interface IntakeApi {
  exportWorkspaceValue(policyFilename?: string): Record<string, unknown>;
  importIntakeText(text: string): Promise<void>;
  importWorkspaceText(text: string): Promise<void>;
  mergeEvidenceText(text: string): Promise<void>;
  snapshot(): {
    intake: Record<string, unknown> | null;
    bundleCount: number;
    evidenceDrafts: EvidenceDraft[];
  };
}

const windows = new Set<Window>();
const exactIntake = {
  format: "aih-artifact-intake",
  version: 1,
  authority: { state: "not-authority" },
  defaults: { accountableOwner: "platform@acme.example" },
  items: [
    {
      id: "firecrawl-mcp",
      kind: "mcp",
      source: {
        type: "npm",
        registry: "https://registry.npmjs.org",
        package: "firecrawl-mcp",
        version: "3.24.0",
      },
    },
  ],
};

afterEach(async () => {
  await Promise.all([...windows].map(async (window) => window.happyDOM.close()));
  windows.clear();
});

function studio(
  studioModel: PolicyStudioModel = tinyStudioModel(),
  url = "http://localhost/",
): Window {
  const window = new Window({ url });
  const html = policyStudioHtml(studioModel);
  window.document.write(html);
  Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
  Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  window.eval(scripts.join("\n"));
  windows.add(window);
  return window;
}

function api(window: Window): IntakeApi {
  const intake = (window as unknown as { __aihArtifactIntake?: IntakeApi }).__aihArtifactIntake;
  if (intake === undefined) throw new Error("expected artifact intake Workbench API");
  return intake;
}

function click(window: Window, node: Element | null): void {
  if (node === null) throw new Error("expected clickable element");
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function input(window: Window, id: string, value: string): void {
  const field = window.document.getElementById(id) as HTMLInputElement | null;
  if (field === null) throw new Error(`expected #${id}`);
  field.value = value;
  field.dispatchEvent(new window.Event("input", { bubbles: true, cancelable: true }));
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function evidenceDraft(text: string): EvidenceDraft {
  const contentDigest = digest(text);
  return {
    id: `draft:evidence-${contentDigest.slice(7)}`,
    declaration: {
      kind: "imported-evidence",
      bytesBase64: Buffer.from(text, "utf8").toString("base64"),
      byteLength: Buffer.byteLength(text, "utf8"),
      digest: contentDigest,
    },
  };
}

function preview(window: Window): Record<string, unknown> {
  const field = window.document.getElementById("config-preview") as HTMLTextAreaElement | null;
  if (field === null) throw new Error("expected policy preview");
  return JSON.parse(field.value) as Record<string, unknown>;
}

describe("Policy Workbench artifact intake", () => {
  it("retains one scalable non-authoritative MCP, Skill, and Agent intake with opaque evidence drafts", () => {
    const window = studio();
    const card = window.document.getElementById("artifact-intake-review");

    expect(card?.textContent).toContain("Add and review MCP, Skill, or Agent sources");
    expect(card?.textContent).toContain("does not choose authorized targets");
    expect(card?.textContent).toContain("does not infer launch or transport");
    expect(card?.textContent).toContain("Core preparation");
    expect(card?.textContent).not.toContain("continue to protected approval");
    expect(window.document.getElementById("artifact-evidence-file")).not.toBeNull();
    expect(window.document.getElementById("import-artifact-evidence")?.textContent).toContain(
      "Import evidence draft",
    );
  });

  it("adds exact scanner bytes as a generic imported-evidence draft without browser verification", async () => {
    const window = studio();
    const raw = '{"format":"aih-preflight-evidence-bundle","state":"verified","qualified":true}';

    await api(window).importIntakeText(JSON.stringify(exactIntake));
    await api(window).mergeEvidenceText(raw);

    const draft = api(window).snapshot().evidenceDrafts[0];
    if (draft === undefined) throw new Error("expected retained evidence draft");
    expect(draft).toEqual({
      id: `draft:evidence-${digest(raw).slice(7)}`,
      declaration: {
        kind: "imported-evidence",
        bytesBase64: Buffer.from(raw, "utf8").toString("base64"),
        byteLength: Buffer.byteLength(raw, "utf8"),
        digest: digest(raw),
      },
    });
    expect(JSON.stringify(preview(window))).toContain(draft.id);
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Core preparation required",
    );
    expect(window.document.body.textContent).not.toContain("Continue to approval");
    expect(window.document.body.textContent).not.toContain("Verified preflight");
  });

  it("treats a forged verified scanner payload as opaque data and never grants approval", async () => {
    const window = studio();
    const forged = JSON.stringify({
      format: "aih-preflight-evidence-bundle",
      version: 99,
      authority: { state: "verified" },
      verification: { state: "verified", qualified: true },
      approval: { targets: ["claude", "codex"] },
    });

    await api(window).mergeEvidenceText(forged);

    const policy = JSON.stringify(preview(window));
    expect(api(window).snapshot().bundleCount).toBe(1);
    expect(policy).toContain(digest(forged));
    expect(policy).not.toContain("qualified");
    expect(policy).not.toContain('"approval"');
    expect(policy).not.toContain('"targets"');
  });

  it("rejects empty or oversized evidence bytes before generic draft dispatch", async () => {
    const window = studio();

    await expect(api(window).mergeEvidenceText("")).rejects.toThrow(/1 to 600000 exact bytes/i);
    await expect(api(window).mergeEvidenceText("x".repeat(1_000_001))).rejects.toThrow(
      /1 to 600000 exact bytes/i,
    );
    expect(api(window).snapshot().bundleCount).toBe(0);
  });

  it("round-trips v2 workspaces with exact opaque evidence bytes and a safe policy filename", async () => {
    const source = studio();
    const raw = '{"scanner":"untrusted","observed":true}';
    await api(source).importIntakeText(JSON.stringify(exactIntake));
    await api(source).mergeEvidenceText(raw);

    const workspace = api(source).exportWorkspaceValue("payments-platform-policy.json");
    expect(workspace).toMatchObject({
      format: "aih-policy-workbench-workspace",
      version: 2,
      authority: { state: "not-authority" },
      policyFilename: "payments-platform-policy.json",
      artifactIntake: exactIntake,
    });
    expect(workspace).toHaveProperty("evidenceDrafts");

    const restored = studio();
    await api(restored).importWorkspaceText(JSON.stringify(workspace));
    expect(api(restored).snapshot().evidenceDrafts).toEqual(api(source).snapshot().evidenceDrafts);
    expect(preview(restored)).toEqual(workspace.policy);
    await expect(
      api(restored).importWorkspaceText(
        JSON.stringify({ ...workspace, policyFilename: "teams/payments-policy.json" }),
      ),
    ).rejects.toThrow(/policy filename/i);
  });

  it("rejects jointly oversized workspace drafts without changing the prior policy or review state", async () => {
    const window = studio();
    await api(window).importIntakeText(JSON.stringify(exactIntake));
    await api(window).mergeEvidenceText("previous exact bytes");
    const beforePolicy = JSON.stringify(preview(window));
    const beforeSnapshot = api(window).snapshot();
    const workspace = api(window).exportWorkspaceValue("budget-policy.json");
    const oversized = {
      ...workspace,
      evidenceDrafts: [evidenceDraft("a".repeat(350_000)), evidenceDraft("b".repeat(350_000))],
    };

    await expect(api(window).importWorkspaceText(JSON.stringify(oversized))).rejects.toThrow(
      /shared Core draft budget/i,
    );
    expect(JSON.stringify(preview(window))).toBe(beforePolicy);
    expect(api(window).snapshot()).toEqual(beforeSnapshot);
  });

  it("downgrades legacy raw evidence workspace entries into exact imported-evidence drafts", async () => {
    const source = studio();
    const current = api(source).exportWorkspaceValue("legacy-policy.json");
    const rawRecord = { state: "verified", arbitraryScannerData: ["preserve", 1] };
    const legacy = {
      format: "aih-policy-workbench-workspace",
      version: 1,
      authority: { state: "not-authority" },
      policyFilename: "legacy-policy.json",
      policy: current.policy,
      artifactIntake: null,
      evidenceBundles: [rawRecord],
    };

    const restored = studio();
    await api(restored).importWorkspaceText(JSON.stringify(legacy));
    const draft = api(restored).snapshot().evidenceDrafts[0];
    if (draft === undefined) throw new Error("expected downgraded legacy draft");
    const exactBytes = JSON.stringify(rawRecord);
    expect(draft.declaration).toMatchObject({
      kind: "imported-evidence",
      bytesBase64: Buffer.from(exactBytes, "utf8").toString("base64"),
      digest: digest(exactBytes),
    });
    expect(JSON.stringify(preview(restored))).not.toContain("arbitraryScannerData");
  });

  it("builds a pinned source intake from the retained form without handwritten JSON", () => {
    const window = studio();
    click(window, window.document.getElementById("open-artifacts"));
    input(window, "artifact-default-owner", "platform@acme.example");
    input(window, "artifact-item-id", "firecrawl-mcp");
    input(window, "artifact-npm-package", "firecrawl-mcp");
    input(window, "artifact-npm-version", "3.24.0");
    click(window, window.document.getElementById("add-artifact-item"));

    expect(api(window).snapshot().intake).toMatchObject(exactIntake);
    expect(window.document.getElementById("artifact-intake-items")?.textContent).toContain(
      "Authority absent",
    );
  });

  it("parses an exact MCP package pin locally without copying command execution", () => {
    const window = studio();
    input(window, "artifact-default-owner", "owner@company.example");
    input(window, "artifact-mcp-discovery", "npx -y firecrawl-mcp@3.24.0");
    click(window, window.document.getElementById("parse-mcp-discovery"));

    expect((window.document.getElementById("artifact-item-id") as HTMLInputElement).value).toBe(
      "firecrawl-mcp",
    );
    expect((window.document.getElementById("artifact-source-type") as HTMLInputElement).value).toBe(
      "npm",
    );
    expect(window.document.getElementById("artifact-mcp-discovery-message")?.textContent).toMatch(
      /parsed locally.*never ran/i,
    );
    click(window, window.document.getElementById("add-artifact-item"));
    expect(api(window).snapshot().intake).toMatchObject({
      ...exactIntake,
      defaults: { accountableOwner: "owner@company.example" },
    });
    expect(JSON.stringify(api(window).snapshot().intake)).not.toContain("execution");
  });

  it("accepts only a pinned GitHub Skill permalink as local discovery input", () => {
    const window = studio();
    const commit = "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f";
    const kind = window.document.getElementById("artifact-item-kind") as HTMLInputElement;
    kind.value = "skill";
    kind.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    input(window, "artifact-default-owner", "owner@company.example");
    input(
      window,
      "artifact-skill-discovery",
      `https://github.com/anthropics/skills/blob/${commit}/skills/frontend-design/SKILL.md`,
    );
    click(window, window.document.getElementById("parse-skill-discovery"));

    expect(
      (window.document.getElementById("artifact-github-commit") as HTMLInputElement).value,
    ).toBe(commit);
    expect((window.document.getElementById("artifact-source-path") as HTMLInputElement).value).toBe(
      "skills/frontend-design/SKILL.md",
    );
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("exact permalink");

    click(window, window.document.getElementById("add-artifact-item"));
    expect(api(window).snapshot().intake).toMatchObject({
      format: "aih-artifact-intake",
      version: 1,
      items: [
        {
          id: "frontend-design",
          kind: "skill",
          source: {
            type: "github",
            repository: "anthropics/skills",
            commit,
            path: "skills/frontend-design/SKILL.md",
          },
        },
      ],
    });
  });

  it("retains friendly Skill requests without enabling an unpinned import", () => {
    for (const discovery of [
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
      "npx skills add anthropics/skills --skill frontend-design",
      "https://www.skills.sh/anthropics/skills/frontend-design",
    ]) {
      const window = studio();
      const kind = window.document.getElementById("artifact-item-kind") as HTMLInputElement;
      kind.value = "skill";
      kind.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
      input(window, "artifact-default-owner", "owner@company.example");
      input(window, "artifact-skill-discovery", discovery);
      expect(window.document.getElementById("parse-skill-discovery")?.textContent).toBe(
        "Read skill link",
      );
      click(window, window.document.getElementById("parse-skill-discovery"));

      expect((window.document.getElementById("artifact-item-id") as HTMLInputElement).value).toBe(
        "frontend-design",
      );
      expect(
        (window.document.getElementById("artifact-github-repository") as HTMLInputElement).value,
      ).toBe("anthropics/skills");
      expect(
        (window.document.getElementById("artifact-github-commit") as HTMLInputElement).value,
      ).toBe("");
      expect(
        (window.document.getElementById("artifact-source-path") as HTMLInputElement).value,
      ).toBe("");
      expect(
        (window.document.getElementById("add-artifact-item") as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        window.document.getElementById("artifact-skill-discovery-message")?.textContent,
      ).toContain("exact commit and SKILL.md path are still required");
    }
  });

  it("uses the connected loopback resolver for the supported Skill without running its pasted command", async () => {
    const token = "1".repeat(64);
    const window = studio(
      tinyStudioModel(),
      `http://127.0.0.1:4311/aih-policy-workbench.html#${token}`,
    );
    expect(window.document.getElementById("parse-skill-discovery")?.textContent).toBe(
      "Resolve skill",
    );
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("Core contacts GitHub to pin this Skill");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "aih-connected-github-skill/v1",
            state: "resolved-not-scanned",
            skill: "frontend-design",
            source: {
              type: "github",
              repository: "anthropics/skills",
              commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
              path: "skills/frontend-design/SKILL.md",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "aih-connected-github-skill-bridge/v1",
            state: "prepared-pending-evidence",
            reload: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
    const kind = window.document.getElementById("artifact-item-kind") as HTMLInputElement;
    kind.value = "skill";
    kind.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    input(window, "artifact-default-owner", "owner@company.example");
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));

    await vi.waitFor(() =>
      expect(
        (window.document.getElementById("artifact-github-commit") as HTMLInputElement).value,
      ).toBe("41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifact-intake/github-skill/resolve",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      string
    >;
    expect(request).toEqual({
      token,
      repository: "anthropics/skills",
      skill: "frontend-design",
    });
    expect(
      window.document.getElementById("artifact-skill-discovery-message")?.textContent,
    ).toContain("Nothing was downloaded, run, scanned, installed, or approved");
    expect(
      (window.document.getElementById("add-artifact-item") as HTMLButtonElement).disabled,
    ).toBe(false);
    click(window, window.document.getElementById("add-artifact-item"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/artifact-intake/github-skill/prepare");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      token,
      source: {
        repository: "anthropics/skills",
        skill: "frontend-design",
        commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
        path: "skills/frontend-design/SKILL.md",
      },
    });
    expect(api(window).snapshot().intake).toBeNull();
  });

  it("does not reload over policy or review-workspace edits made while Core prepares a Skill", async () => {
    const token = "3".repeat(64);
    const window = studio(
      tinyStudioModel(),
      `http://127.0.0.1:4311/aih-policy-workbench.html#${token}`,
    );
    let releasePrepare: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: "aih-connected-github-skill/v1",
            state: "resolved-not-scanned",
            skill: "frontend-design",
            source: {
              type: "github",
              repository: "anthropics/skills",
              commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
              path: "skills/frontend-design/SKILL.md",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releasePrepare = resolve;
          }),
      );
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
    const kind = window.document.getElementById("artifact-item-kind") as HTMLInputElement;
    kind.value = "skill";
    kind.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    input(window, "artifact-default-owner", "owner@company.example");
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));
    await vi.waitFor(() =>
      expect(
        (window.document.getElementById("artifact-github-commit") as HTMLInputElement).value,
      ).toBe("41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f"),
    );
    click(window, window.document.getElementById("add-artifact-item"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const session = (
      window as unknown as {
        __aihPolicyWorkbenchSession: {
          snapshotPolicy(): unknown;
          restorePolicy(policy: unknown): void;
        };
      }
    ).__aihPolicyWorkbenchSession;
    const changedPolicy = structuredClone(session.snapshotPolicy()) as {
      governance: { policyVersion: string };
    };
    changedPolicy.governance.policyVersion = "2";
    session.restorePolicy(changedPolicy);
    await api(window).importIntakeText(JSON.stringify(exactIntake));
    releasePrepare?.(
      new Response(
        JSON.stringify({
          version: "aih-connected-github-skill-bridge/v1",
          state: "prepared-pending-evidence",
          reload: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await vi.waitFor(() =>
      expect(
        window.document.getElementById("artifact-skill-discovery-message")?.textContent,
      ).toContain("page was not reloaded"),
    );
    expect(api(window).snapshot().intake).toMatchObject(exactIntake);
    expect(
      (session.snapshotPolicy() as { governance: { policyVersion: string } }).governance
        .policyVersion,
    ).toBe("2");
  });

  it("keeps a connected Skill candidate visible but blocked when resolution fails", async () => {
    const window = studio(
      tinyStudioModel(),
      `http://127.0.0.1:4311/aih-policy-workbench.html#${"2".repeat(64)}`,
    );
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue(new Response("{}", { status: 502 })),
    });
    const kind = window.document.getElementById("artifact-item-kind") as HTMLInputElement;
    kind.value = "skill";
    kind.dispatchEvent(new window.Event("change", { bubbles: true, cancelable: true }));
    input(window, "artifact-default-owner", "owner@company.example");
    input(
      window,
      "artifact-skill-discovery",
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
    );
    click(window, window.document.getElementById("parse-skill-discovery"));

    await vi.waitFor(() =>
      expect(
        window.document.getElementById("artifact-skill-discovery-message")?.textContent,
      ).toContain("candidate remains unpinned"),
    );
    expect((window.document.getElementById("artifact-item-id") as HTMLInputElement).value).toBe(
      "frontend-design",
    );
    expect(
      (window.document.getElementById("artifact-github-repository") as HTMLInputElement).value,
    ).toBe("anthropics/skills");
    expect(
      (window.document.getElementById("artifact-github-commit") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (window.document.getElementById("add-artifact-item") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("rejects authority and target claims at the non-authoritative intake boundary", async () => {
    const window = studio();
    await expect(
      api(window).importIntakeText(
        JSON.stringify({ ...exactIntake, authority: { state: "approved" } }),
      ),
    ).rejects.toThrow(/non-authoritative/i);
    await expect(
      api(window).importIntakeText(JSON.stringify({ ...exactIntake, targets: ["codex"] })),
    ).rejects.toThrow(/unknown member targets/i);
    expect(api(window).snapshot().intake).toBeNull();
  });
});
