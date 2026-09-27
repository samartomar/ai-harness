import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ALL_COMMAND_SPEC_PATHS } from "../../src/commands/index.js";
import { command, executeEccCommand } from "../../src/framework-plugin/ecc-command.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "./plugin-source.js";
import { eccDescriptorLoad } from "./source-plugin-mocks.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps only the guidance and status ECC command surface", () => {
  expect(command.options?.map((option) => option.flags)).toEqual(["--status", "--cli <list>"]);
  expect(ALL_COMMAND_SPEC_PATHS).not.toContainEqual(["ecc", "mcp", "remove"]);
  expect(ALL_COMMAND_SPEC_PATHS).not.toContainEqual(["ecc", "mcp", "add"]);
});

it("runs guidance through the plugin without writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-guidance-"));
  roots.push(root);
  const run = fakeRunner(() => undefined);
  const context: PlanContext = {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { cli: "windsurf" },
  };
  const result = await executeEccCommand(context, {
    loadPlugin: () => loadEccFromSource(),
    loadDescriptor: async () => eccDescriptorLoad(),
  });
  expect(result.docs.map((entry) => entry.text).join("\n")).toContain(
    "git clone https://github.com/affaan-m/ECC.git",
  );
  expect(result.writes).toEqual([]);
  expect(result.execs).toEqual([]);
});
