import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStudioPolicy } from "../../src/org-policy/studio-model.js";
import { type PolicyWorkbenchUi, startPolicyWorkbenchUi } from "../../src/org-policy/ui-server.js";

const { resolveGithubSkillMock } = vi.hoisted(() => ({ resolveGithubSkillMock: vi.fn() }));
vi.mock("../../src/org-policy/workbench/core/bounded-github-skill-resolver.js", () => ({
  resolveConnectedGithubSkillV1: resolveGithubSkillMock,
}));
// Keep the server and policy preparation in one isolated module graph. The
// connected HTTP flow stays real; this file does not load unrelated inventory.
vi.mock("../../src/org-policy/workbench/prepared-catalog.js", async () => {
  const fixture = await import("./studio-test-fixture.js");
  return {
    defaultPreparedWorkbenchCatalog: fixture.prepareTinyWorkbenchCatalogV1,
    packagedPreparedWorkbenchCatalogV1: fixture.prepareTinyWorkbenchCatalogV1,
    prepareWorkbenchCatalog: fixture.prepareTinyWorkbenchCatalogV1,
  };
});
vi.mock("../../src/org-policy/workbench/default-catalog-preassembly.js", async (original) => ({
  ...(await original<
    typeof import("../../src/org-policy/workbench/default-catalog-preassembly.js")
  >()),
  packagedDefaultCatalogPreassemblyCompanionV1: () => undefined,
}));
vi.mock("../../src/org-policy/packaged-collection-evidence-data.js", () => ({
  packagedScannerCollectionEvidenceInputV1: () => [],
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-data.js", () => ({
  catalogQualificationPackageInputV1: () => ({
    version: 1,
    records: [],
    bindings: [],
    projections: [],
  }),
}));

describe("connected Policy Workbench preparation", () => {
  let running: PolicyWorkbenchUi | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
    resolveGithubSkillMock.mockReset();
  });

  it("rebuilds the connected Workbench with a Core-prepared pending Skill policy", async () => {
    const resolved = {
      version: "aih-connected-github-skill/v1" as const,
      state: "resolved-not-scanned" as const,
      skill: "frontend-design",
      source: {
        type: "github" as const,
        repository: "anthropics/skills",
        commit: "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f",
        path: "skills/frontend-design/SKILL.md",
      },
    };
    resolveGithubSkillMock.mockResolvedValue(resolved);
    running = await startPolicyWorkbenchUi({ openBrowser: async () => {} });
    const launcher = new URL(running.url);
    const headers = {
      Origin: launcher.origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    const resolve = await fetch(new URL("/api/artifact-intake/github-skill/resolve", running.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: launcher.hash.slice(1),
        repository: resolved.source.repository,
        skill: resolved.skill,
      }),
    });
    expect(resolve.status).toBe(200);

    const prepared = await fetch(
      new URL("/api/artifact-intake/github-skill/prepare", running.url),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          token: launcher.hash.slice(1),
          policy: defaultStudioPolicy(),
          source: {
            repository: resolved.source.repository,
            skill: resolved.skill,
            commit: resolved.source.commit,
            path: resolved.source.path,
          },
        }),
      },
    );
    await expect(prepared.json()).resolves.toEqual({
      version: "aih-connected-github-skill-bridge/v1",
      state: "prepared-pending-evidence",
      reload: true,
    });
    const refreshed = await (await fetch(running.url)).text();
    expect(refreshed).toContain("Pending security review: frontend-design");
    expect(refreshed).toContain(resolved.source.commit);
    expect(refreshed).not.toContain('"approvals":[{"');
  });
});
