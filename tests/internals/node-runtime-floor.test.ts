import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_FLOOR_TEXT,
  nodeVersionMeetsFloor,
} from "../../src/internals/node-runtime-floor.js";

describe("Node runtime floor", () => {
  it("is 20.6, the first release with a synchronous unflagged import.meta.resolve", () => {
    expect(NODE_RUNTIME_FLOOR_TEXT).toBe("20.6");
  });

  it("refuses releases below 20.6 and accepts 20.6 and later", () => {
    expect(nodeVersionMeetsFloor("v18.19.0")).toBe(false);
    expect(nodeVersionMeetsFloor("v20.0.0")).toBe(false);
    expect(nodeVersionMeetsFloor("20.5.1")).toBe(false);
    expect(nodeVersionMeetsFloor("v20.6.0")).toBe(true);
    expect(nodeVersionMeetsFloor("20.19.2")).toBe(true);
    expect(nodeVersionMeetsFloor("v22.3.0\r\n")).toBe(true);
    expect(nodeVersionMeetsFloor("v26.4.0")).toBe(true);
  });

  it("fails closed on an unparseable version", () => {
    expect(nodeVersionMeetsFloor("")).toBe(false);
    expect(nodeVersionMeetsFloor("node")).toBe(false);
    expect(nodeVersionMeetsFloor("v20")).toBe(false);
    expect(nodeVersionMeetsFloor("v20.6.")).toBe(false);
    expect(nodeVersionMeetsFloor("garbage20.6.invalid")).toBe(false);
    expect(nodeVersionMeetsFloor("v22.3.0 extra")).toBe(false);
    expect(nodeVersionMeetsFloor("v22.3.0\nv18.0.0")).toBe(false);
  });

  it("accepts a prerelease or nightly suffix on a complete version", () => {
    expect(nodeVersionMeetsFloor("v21.0.0-nightly20230801abc")).toBe(true);
    expect(nodeVersionMeetsFloor("v20.6.0-rc.1")).toBe(true);
    expect(nodeVersionMeetsFloor("v20.5.0-rc.1")).toBe(false);
  });
});

describe("package manifest", () => {
  it("states the same floor in engines.node", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.engines.node).toBe(">=20.6.0");
  });
});
