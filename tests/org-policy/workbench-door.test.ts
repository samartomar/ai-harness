import { createHash } from "node:crypto";
import {
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyRootSha256 } from "../../src/org-policy/binding.js";
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

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A project root bound to a policy file kept in a separate fixture folder. */
function boundProject(
  overrides: {
    state?: "active" | "revoked";
    rootSha256?: string;
    sourcePath?: (policyPath: string) => string;
    sourceSha256?: string;
  } = {},
): { root: string; policyPath: string; bytes: Buffer; sourcePath: string } {
  const root = fixtureRoot();
  const policyDir = fixtureRoot();
  const policyPath = join(policyDir, "aih-org-policy.json");
  writeFileSync(policyPath, MINIMAL_ORG_POLICY);
  const bytes = readFileSync(policyPath);
  const sourcePath = overrides.sourcePath?.(policyPath) ?? policyPath;
  const binding = {
    schemaVersion: 1,
    state: overrides.state ?? "active",
    projectId: "sample-project",
    rootSha256: overrides.rootSha256 ?? policyRootSha256(realpathSync.native(root)),
    source: { path: sourcePath, sha256: overrides.sourceSha256 ?? sha256(bytes) },
    targets: ["claude"],
  };
  writeFileSync(join(root, ".aih-config.json"), JSON.stringify({ policyBinding: binding }));
  return { root, policyPath, bytes, sourcePath };
}

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

  it("classifies a current binding as user and returns the policy parsed from the digested bytes", () => {
    const { root, policyPath, bytes } = boundProject();
    const before = readdirSync(root).sort();

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("user");
    expect(result.policySource).toEqual({
      kind: "binding",
      path: policyPath,
      sha256: sha256(bytes),
      valid: true,
    });
    expect(result.policy?.governance?.supportedClis).toEqual(["claude"]);
    expect(result.policy?.minimumPosture).toBe("enterprise");
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("fails closed when the bound policy bytes no longer match the recorded digest", () => {
    const { root } = boundProject({ sourceSha256: "b".repeat(64) });

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.door).toBe("user");
    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.sha256).toBeUndefined();
    expect(result.policySource.error).toContain("bound policy source digest changed");
    expect(result.policy).toBeUndefined();
  });

  it("fails closed when the bound policy file is missing", () => {
    const { root, policyPath } = boundProject();
    rmSync(policyPath);

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.error).toBeTruthy();
    expect(result.policy).toBeUndefined();
  });

  it("fails closed on a revoked binding with the product's wording", () => {
    const { root } = boundProject({ state: "revoked" });

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.error).toContain(
      "project policy binding for sample-project is revoked",
    );
    expect(result.policy).toBeUndefined();
  });

  it("fails closed when the binding belongs to a different canonical root", () => {
    const { root } = boundProject({ rootSha256: "a".repeat(64) });

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.error).toContain("belongs to a different canonical root");
    expect(result.policy).toBeUndefined();
  });

  it("fails closed when the bound policy file has a second hard link", () => {
    const { root, policyPath } = boundProject();
    linkSync(policyPath, `${policyPath}.link`);

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource.valid).toBe(false);
    expect(result.policySource.error).toContain("not a safe bounded single-link regular file");
    expect(result.policy).toBeUndefined();
  });

  it("follows a symlinked source path to its canonical file, as the product does", (context) => {
    let linkPath = "";
    const { root, bytes } = boundProject({
      sourcePath: (policyPath) => {
        linkPath = join(fixtureRoot(), "linked-policy.json");
        try {
          symlinkSync(policyPath, linkPath, "file");
        } catch {
          linkPath = "";
        }
        return linkPath === "" ? policyPath : linkPath;
      },
    });
    if (linkPath === "") context.skip();

    const result = classifyWorkbenchDoorV1(root, {});

    expect(result.policySource).toEqual({
      kind: "binding",
      path: linkPath,
      sha256: sha256(bytes),
      valid: true,
    });
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
