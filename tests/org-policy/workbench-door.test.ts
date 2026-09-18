import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyWorkbenchDoorV1 } from "../../src/org-policy/workbench-door.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-workbench-door-"));
  roots.push(root);
  return root;
}

const MINIMAL_ORG_POLICY = JSON.stringify({
  schemaVersion: 2,
  minimumPosture: "enterprise",
  references: { repoContract: "ai-coding/project.json" },
  governance: { supportedClis: ["claude"] },
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("classifyWorkbenchDoorV1", () => {
  it("classifies a root carrying the default org policy file as admin", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "aih-org-policy.json"), MINIMAL_ORG_POLICY);

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("admin");
    expect(result.policySource.kind).toBe("root");
    expect(result.policySource.valid).toBe(true);
    expect(result.policySource.path).toBe(join(root, "aih-org-policy.json"));
    expect(result.policySource.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.policySource.error).toBeUndefined();
  });

  it("classifies AIH_ORG_POLICY pointing at a policy file as admin with kind env", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "custom-policy.json"), MINIMAL_ORG_POLICY);

    const result = classifyWorkbenchDoorV1(root, { AIH_ORG_POLICY: "custom-policy.json" });

    expect(result.door).toBe("admin");
    expect(result.policySource.kind).toBe("env");
    expect(result.policySource.valid).toBe(true);
    expect(result.policySource.path).toBe(join(root, "custom-policy.json"));
  });

  it("classifies a root carrying a policyBinding marker as user with kind binding", () => {
    const root = fixtureRoot();
    const binding = {
      schemaVersion: 1,
      state: "active",
      projectId: "sample-project",
      rootSha256: "a".repeat(64),
      source: { path: join(root, "aih-org-policy.json"), sha256: "b".repeat(64) },
      targets: ["claude"],
    };
    writeFileSync(join(root, ".aih-config.json"), JSON.stringify({ policyBinding: binding }));

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("user");
    expect(result.policySource.kind).toBe("binding");
    expect(result.policySource.valid).toBe(true);
    expect(result.policySource.path).toBe(join(root, ".aih-config.json"));
  });

  it("classifies an empty folder as chooser with no policy source", () => {
    const root = fixtureRoot();

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("chooser");
    expect(result.policySource).toEqual({ kind: "none", valid: true });
  });

  it("fails closed on a corrupt org policy: valid:false with an error, never a guess", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "aih-org-policy.json"), "{ not json");

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.error).toBeTruthy();
    expect(result.policySource.kind).toBe("root");
    // The file's presence at the recognized policy path is what makes this an
    // admin folder in the first place; the corruption is reported, not hidden.
    expect(result.door).toBe("admin");
  });

  it("fails closed when AIH_ORG_POLICY names a file that does not exist", () => {
    const root = fixtureRoot();

    const result = classifyWorkbenchDoorV1(root, { AIH_ORG_POLICY: "missing-policy.json" });

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.kind).toBe("env");
    expect(result.policySource.error).toBeTruthy();
  });

  it("classifies a root carrying only aih-project-policy.json as user", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "aih-project-policy.json"), "{}");

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("user");
    expect(result.policySource).toEqual({ kind: "none", valid: true });
  });

  it("never writes into the classified root", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "aih-org-policy.json"), MINIMAL_ORG_POLICY);
    const before = readdirSync(root).sort();

    classifyWorkbenchDoorV1(root, {});
    classifyWorkbenchDoorV1(root, { AIH_ORG_POLICY: "does-not-exist.json" });

    const after = readdirSync(root).sort();
    expect(after).toEqual(before);
  });
});
