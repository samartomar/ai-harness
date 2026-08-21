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
});
