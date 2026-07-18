import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const addonPath = join(
  process.cwd(),
  "native",
  "methodology-fs",
  "build",
  "Release",
  "methodology_fs.node",
);

describe("native methodology filesystem feasibility", () => {
  it("loads the local addon with one synchronous probe export", () => {
    const addon = require(addonPath) as { probe?: unknown };

    expect(Object.keys(addon)).toEqual(["probe"]);
    expect(typeof addon.probe).toBe("function");
    if (typeof addon.probe !== "function") {
      throw new TypeError("expected native probe export");
    }

    expect(addon.probe()).toBe(
      '{"schemaVersion":1,"probeVersion":"phase-4a-native-fs-v1","state":"blocked","reason":"native-backend-unimplemented"}',
    );
  });
});
