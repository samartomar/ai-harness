import { describe, expect, it } from "vitest";
import { parseProjectPolicyV1 } from "../../../src/org-policy/project-policy.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import {
  buildProjectPolicyV1,
  type TrimUseV1,
  userDoorViewModelV1,
} from "../../../src/org-policy/workbench/ui/user-door-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const DIGEST = "a".repeat(64);
const PIN = {
  sourceId: "source:ecc",
  sourceRevisionId: "rev-1",
  contentDigest: `sha256:${"b".repeat(64)}`,
};
const admin = { kind: "administrator" } as const;

function orgPolicy(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    governance: { supportedClis: ["claude", "codex"] },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [
        {
          assetId: "ecc/pack",
          origin: admin,
          resolvedItems: [
            { assetId: "ecc/pack", ...PIN },
            { assetId: "ecc/skill-a", ...PIN },
            { assetId: "ecc/skill-b", ...PIN },
          ],
        },
      ],
      requests: [{ assetId: "mcp/github", origin: admin }],
      exclusions: [{ assetId: "ecc/skill-b", origin: admin }],
      drafts: [],
    },
    ...extra,
  };
}

function userModel(overrides: Record<string, unknown> = {}) {
  return {
    door: "user",
    policySource: { kind: "binding", path: "/tmp/p/.aih-config.json", sha256: DIGEST, valid: true },
    initialPolicy: orgPolicy(),
    workbenchBundle: {
      assets: {
        "ecc/skill-a": { kind: "skill", label: "Skill <A>", sourceId: "source:ecc" },
      },
    },
    ...overrides,
  };
}

describe("user door view-model (P5b)", () => {
  it("lists the org policy's allowed items, minus exclusions", () => {
    const view = userDoorViewModelV1(userModel());
    expect(view.items.map((item) => item.assetId)).toEqual([
      "ecc/pack",
      "ecc/skill-a",
      "mcp/github",
    ]);
    expect(view.items[1]).toMatchObject({ kind: "skill", label: "Skill <A>" });
    expect(view.source).toMatchObject({ kind: "binding", name: ".aih-config.json", valid: true });
    expect(view.aiTools).toEqual(["claude", "codex"]);
    expect(view.saveBlocked).toBeUndefined();
  });

  it("builds a schema-valid ProjectPolicyV1; skipped items are unlisted", () => {
    const view = userDoorViewModelV1(userModel());
    const choices = new Map<string, TrimUseV1>([
      ["ecc/pack", "required"],
      ["mcp/github", "skip"],
    ]);
    const result = buildProjectPolicyV1(view, {
      choices,
      forType: "project",
      forName: " Payments API ",
      aiTools: ["codex", "claude"],
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(parseProjectPolicyV1(JSON.parse(JSON.stringify(result.policy)))).toEqual({
      schemaVersion: 1,
      kind: "aih-project-policy",
      cutFrom: { schemaVersion: 3, sha256: DIGEST },
      for: { type: "project", name: "Payments API" },
      aiTools: ["claude", "codex"],
      items: [
        { assetId: "ecc/pack", origin: admin, use: "required" },
        { assetId: "ecc/skill-a", origin: admin, use: "optional" },
      ],
    });
  });

  it("rejects a save the schema rejects (no name, no AI tool)", () => {
    const view = userDoorViewModelV1(userModel());
    const result = buildProjectPolicyV1(view, {
      choices: new Map(),
      forType: "project",
      forName: "",
      aiTools: [],
    });
    expect(result.ok).toBe(false);
  });

  it("an invalid policy source disables save and lists nothing", () => {
    const view = userDoorViewModelV1(
      userModel({
        policySource: {
          kind: "binding",
          path: "/p/.aih-config.json",
          valid: false,
          error: "bad marker",
        },
      }),
    );
    expect(view.items).toEqual([]);
    expect(view.saveBlocked).toContain("bad marker");
    const result = buildProjectPolicyV1(view, {
      choices: new Map(),
      forType: "project",
      forName: "x",
      aiTools: ["claude"],
    });
    expect(result.ok).toBe(false);
  });

  it("without a digest it lists nothing, names the missing server data, and cannot save", () => {
    const view = userDoorViewModelV1(
      userModel({ policySource: { kind: "binding", path: "/p/.aih-config.json", valid: true } }),
    );
    expect(view.items).toEqual([]);
    expect(view.missing.join("\n")).toContain("policySource.sha256");
    expect(view.saveBlocked).toBeDefined();
  });

  it("never offers an item listed under two origins", () => {
    const policy = orgPolicy();
    policy.authoringSelections.requests.push({
      assetId: "ecc/skill-a",
      origin: { kind: "legacy-unattributed" },
    } as never);
    const view = userDoorViewModelV1(userModel({ initialPolicy: policy }));
    expect(view.ambiguous).toEqual(["ecc/skill-a"]);
    expect(view.items.map((item) => item.assetId)).not.toContain("ecc/skill-a");
  });

  it("offers every supported AI tool when the org policy does not limit them", () => {
    const view = userDoorViewModelV1(userModel({ initialPolicy: orgPolicy({ governance: {} }) }));
    expect(view.aiToolsFromPolicy).toBe(false);
    expect(view.aiTools).toContain("claude");
  });

  it("a policy that lists no items cannot be saved, and says why", () => {
    const policy = orgPolicy();
    policy.authoringSelections.roots = [];
    policy.authoringSelections.requests = [];
    const view = userDoorViewModelV1(userModel({ initialPolicy: policy }));
    expect(view.items).toEqual([]);
    expect(view.saveBlocked).toBe("The org policy lists no items. Saving is disabled.");
  });

  it("shows the org's posture only once the digest proves the policy is the bound one", () => {
    const initialPolicy = orgPolicy({ minimumPosture: "enterprise" });
    expect(userDoorViewModelV1(userModel({ initialPolicy })).posture).toBe("enterprise");
    const unproven = userModel({
      initialPolicy,
      policySource: { kind: "binding", path: "/p/.aih-config.json", valid: true },
    });
    expect(userDoorViewModelV1(unproven).posture).toBeUndefined();
    const unknown = userModel({ initialPolicy: orgPolicy({ minimumPosture: "strict" }) });
    expect(userDoorViewModelV1(unknown).posture).toBeUndefined();
  });

  it("carries the launch folder's name and the core version from the model", () => {
    const view = userDoorViewModelV1(
      userModel({ folderName: "payments-api", shell: { evidence: { coreVersion: "9.9.9" } } }),
    );
    expect(view).toMatchObject({ folderName: "payments-api", coreVersion: "9.9.9" });
    const bare = userDoorViewModelV1(userModel());
    expect(bare.folderName).toBeUndefined();
    expect(bare.coreVersion).toBeUndefined();
  });
});

describe("door routing in the page markup (P5b)", () => {
  const withoutModel = (html: string) =>
    html.replace(/<script>window\.__aihWorkbenchModel=.*?<\/script>/su, "");

  it.each(["admin", "chooser"] as const)("door %s renders the unchanged admin markup", (door) => {
    const absent = policyStudioHtml(tinyStudioModel());
    const routed = policyStudioHtml({
      ...tinyStudioModel(),
      door,
      policySource: { kind: "none", valid: true },
    });
    expect(withoutModel(routed)).toBe(withoutModel(absent));
  });

  it("door user renders the project page, not the admin workspace", () => {
    const html = policyStudioHtml({
      ...tinyStudioModel(),
      door: "user",
      policySource: { kind: "binding", path: "/p/.aih-config.json", valid: true },
    });
    expect(html).toContain('id="user-door"');
    expect(html).toContain('id="theme-toggle"');
    for (const adminId of ["framework-rows", "config-preview", "download", "export"])
      expect(html).not.toContain(`id="${adminId}"`);
  });

  it("escapes model strings in the embedded data", () => {
    const html = policyStudioHtml({
      ...tinyStudioModel(),
      door: "user",
      policySource: { kind: "binding", path: "/p/</script><img>", valid: false, error: "<b>x</b>" },
    });
    expect(html).not.toContain("</script><img>");
    expect(html).not.toContain("<b>x</b>");
  });
});
