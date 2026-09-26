import { describe, expect, it } from "vitest";
import { loadFrameworkDescriptorBytesV1 } from "../../src/catalog-package/framework-descriptors.js";
import type { FrameworkOperationContextV1 } from "../../src/framework-plugin/contract-v1.js";
import { loadSuperpowersFromSource } from "./plugin-source.js";

/**
 * The Superpowers hook operations read their inventory only from the
 * descriptor bytes Core loads from the installed Catalog; no embedded copy.
 */
async function catalogContext(
  targets: FrameworkOperationContextV1["targets"],
): Promise<FrameworkOperationContextV1> {
  const descriptor = await loadFrameworkDescriptorBytesV1("superpowers");
  if (!descriptor.ok) throw new Error(descriptor.refusal.detail);
  const { ok: _ok, ...bytes } = descriptor;
  const unused = () => {
    throw new Error("hook operations have no effects");
  };
  return {
    frameworkId: "superpowers",
    root: "/repo",
    targets,
    mode: { apply: false, verify: true },
    descriptor: bytes,
    policy: { posture: "vibe", hookControls: { disabled: [] } },
    options: {},
    env: {},
    host: { runEvidenceGatedInstall: unused, executePlan: unused, progress: unused },
  };
}

async function plugin() {
  const loaded = await loadSuperpowersFromSource();
  if (!loaded.ok) throw new Error(loaded.refusal.detail);
  return loaded.plugin;
}

describe("Superpowers hook operations over the installed Catalog descriptor", () => {
  it("exposes the hook inventory the installed Catalog carries", async () => {
    const inventory = (await plugin()).hookInventory(await catalogContext(["claude"]));
    expect(inventory.frameworkId).toBe("superpowers");
    expect(inventory.upstream).toEqual({
      repository: "obra/Superpowers",
      commit: "5bf4e78011075bcfc0dc295f0724994cd123ee71",
    });
    expect(inventory.hooks.map((hook) => [hook.id, hook.event])).toEqual([
      ["hook:session-start", "SessionStart"],
      ["hook:skills-path", "config"],
      ["hook:skill-registration", "setup"],
      ["hook:session-context", "context"],
      ["hook:first-turn-context", "pre_llm_call"],
    ]);
    expect(inventory.hooks[0]?.declarations).toContainEqual(
      expect.objectContaining({ host: "claude", sourcePath: "hooks/hooks.json" }),
    );
  });

  it("plans hook controls from the installed Catalog descriptor", async () => {
    const planned = (await plugin()).planHookControls(await catalogContext(["claude", "codex"]), {
      disabled: [{ hookId: "hook:session-start", authority: "enterprise" }],
    });
    const [decision] = planned.decisions;
    expect(decision).toMatchObject({
      hookId: "hook:session-start",
      state: "disabled",
      authority: "enterprise",
    });
    expect(decision?.hosts.map((host) => [host.host, host.enforcement])).toEqual([
      ["claude", "unenforced"],
      ["codex", "not-applicable"],
    ]);
    expect(planned.actions).toHaveLength(1);
  });
});
