import { describe, expect, it } from "vitest";
import { aihFrameworkPluginV1 } from "../../packages/framework-superpowers/src/index.js";
import { FIXED_GENERATED_CLI_ARTIFACTS } from "../../src/uninstall/index.js";

// Core's uninstall removes plugin-written files by receipt without loading the
// plugin, so it keeps working after the plugin itself is uninstalled. Its list
// must cover every artifact the plugin declares it owns.
describe("framework plugin owned artifacts", () => {
  it("Core's uninstall covers every artifact the Superpowers plugin declares", () => {
    const owned = aihFrameworkPluginV1.describe().ownedArtifacts;
    expect(owned.length).toBeGreaterThan(0);
    for (const artifact of owned) {
      expect(FIXED_GENERATED_CLI_ARTIFACTS[artifact.host]).toContain(artifact.path);
    }
  });
});
