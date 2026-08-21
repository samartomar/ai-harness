import { describe, expect, it } from "vitest";
import { writeJson } from "../../src/internals/plan.js";
import { coalesceMcpProjectionMarkerActions } from "../../src/mcp/projection-marker.js";

describe("MCP projection marker coalescing", () => {
  it("refuses conflicting replacements for the same ownership receipt key", () => {
    const first = writeJson(
      ".aih-config.json",
      { managedMcpProjection: { schemaVersion: 1, state: "active" } },
      "first",
      { merge: true, replaceJsonKeys: ["managedMcpProjection"] },
    );
    const second = writeJson(
      ".aih-config.json",
      { managedMcpProjection: { schemaVersion: 2, state: "active", decisions: [] } },
      "second",
      { merge: true, replaceJsonKeys: ["managedMcpProjection"] },
    );
    expect(() => coalesceMcpProjectionMarkerActions([first, second])).toThrow(/conflicting/i);
  });

  it("refuses an ordinary ownership write combined with removal of the same key", () => {
    const set = writeJson(
      ".aih-config.json",
      { managedMcpProjection: { schemaVersion: 1, state: "active" } },
      "set",
      { merge: true },
    );
    const remove = writeJson(".aih-config.json", {}, "remove", {
      merge: true,
      removeJsonTopLevelKeys: ["managedMcpProjection"],
    });
    expect(() => coalesceMcpProjectionMarkerActions([set, remove])).toThrow(
      /both writes and removes/i,
    );
  });
});
