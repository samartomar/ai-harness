import { describe, expect, it } from "vitest";
import { writeJson, writeText } from "../../src/internals/plan.js";
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

  it("combines native target writes and removals without replacing neighboring receipts", () => {
    const set = writeJson(
      ".aih-config.json",
      { nativeMcpProjections: { cursor: { state: "active" } } },
      "cursor",
      {
        merge: true,
        replaceJsonChildKeys: { nativeMcpProjections: ["cursor"] },
        durable: true,
      },
    );
    const remove = writeJson(".aih-config.json", {}, "kimi", {
      merge: true,
      removeJsonKeys: { nativeMcpProjections: ["kimi"] },
    });
    expect(coalesceMcpProjectionMarkerActions([set, remove])).toMatchObject([
      {
        json: { nativeMcpProjections: { cursor: { state: "active" } } },
        replaceJsonChildKeys: { nativeMcpProjections: ["cursor"] },
        removeJsonKeys: { nativeMcpProjections: ["kimi"] },
        durable: true,
      },
    ]);
  });

  it("refuses conflicting native target writes, removals and snapshot pins", () => {
    const set = writeJson(
      ".aih-config.json",
      { nativeMcpProjections: { cursor: { state: "active" } } },
      "cursor",
      { merge: true, expect: { absent: true } },
    );
    const revoked = writeJson(
      ".aih-config.json",
      { nativeMcpProjections: { cursor: { state: "revoked" } } },
      "cursor",
      { merge: true, expect: { absent: true } },
    );
    const remove = writeJson(".aih-config.json", {}, "cursor", {
      merge: true,
      expect: { absent: true },
      removeJsonKeys: { nativeMcpProjections: ["cursor"] },
    });
    expect(() => coalesceMcpProjectionMarkerActions([set, revoked])).toThrow(/conflicting/);
    expect(() => coalesceMcpProjectionMarkerActions([set, remove])).toThrow(/writes and removes/);
    expect(() =>
      coalesceMcpProjectionMarkerActions([set, { ...revoked, expect: { sha256: "0".repeat(64) } }]),
    ).toThrow(/different marker snapshots/);
  });

  it("publishes coalesced ownership after every target configuration write", () => {
    const cursor = writeText(".cursor/mcp.json", "{}", "cursor config");
    const kimi = writeText(".kimi-code/mcp.json", "{}", "kimi config");
    const first = writeJson(
      ".aih-config.json",
      { nativeMcpProjections: { cursor: { state: "active" } } },
      "cursor receipt",
      { merge: true },
    );
    const second = writeJson(
      ".aih-config.json",
      { nativeMcpProjections: { kimi: { state: "active" } } },
      "kimi receipt",
      { merge: true },
    );
    expect(
      coalesceMcpProjectionMarkerActions([cursor, first, kimi, second]).map((action) =>
        action.kind === "write" ? action.path : undefined,
      ),
    ).toEqual([".cursor/mcp.json", ".kimi-code/mcp.json", ".aih-config.json"]);
  });

  it("retains companion absence assertions from every coalesced receipt", () => {
    const first = {
      ...writeJson(
        ".aih-config.json",
        { nativeMcpProjections: { cursor: { state: "active" } } },
        "cursor receipt",
        { merge: true },
      ),
      assertAbsentPaths: ["cursor-alternate.json"],
    };
    const second = {
      ...writeJson(
        ".aih-config.json",
        { nativeMcpProjections: { opencode: { state: "active" } } },
        "opencode receipt",
        { merge: true },
      ),
      assertAbsentPaths: ["opencode.jsonc"],
    };
    expect(coalesceMcpProjectionMarkerActions([first, second])).toMatchObject([
      { assertAbsentPaths: ["cursor-alternate.json", "opencode.jsonc"] },
    ]);
  });
});
