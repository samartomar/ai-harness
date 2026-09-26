import { describe, expect, it } from "vitest";
import {
  CODE_REVIEW_GRAPH_RUNTIME_PIN,
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
} from "../../src/ecc-profile/default-mcp-runtime-lock.js";
import { managedAllowlistGenerationDelta } from "../../src/mcp/allowlist.js";
import { defaultRuntimeScriptPath } from "../../src/mcp/default-native-runtime.js";

const HISTORICAL_AIH_GRAPH_LAUNCHERS = [
  { name: "pre-hardening 2.1.0", command: ["uvx", "code-review-graph@2.1.0", "serve"] },
  {
    name: "hardened 2.3.7",
    command: [
      "uvx",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.7",
      "serve",
    ],
  },
] as const;

const [PRE_HARDENING_GRAPH_LAUNCHER, HARDENED_GRAPH_LAUNCHER] = HISTORICAL_AIH_GRAPH_LAUNCHERS;

const CURRENT_NATIVE_GRAPH_LAUNCHER = [
  process.execPath,
  defaultRuntimeScriptPath(),
  "code-review-graph",
  "--package",
  CODE_REVIEW_GRAPH_RUNTIME_PIN.package,
  "--dependency-lock-sha256",
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
  "--lock-root",
  "/opt/aih/default-mcp-runtime",
  "--project",
  "/workspace/project",
  "--state-root",
  "/state/project/graph",
  "--uv-cache",
  "/state/runtime/uv-cache",
];

describe("managed allowlist generation deltas", () => {
  it.each(HISTORICAL_AIH_GRAPH_LAUNCHERS)(
    "recognizes the exact $name AIH Graph launcher before the native runtime transition",
    ({ command: historicalLauncher }) => {
      const actual = [...historicalLauncher];
      expect(managedAllowlistGenerationDelta([actual], [CURRENT_NATIVE_GRAPH_LAUNCHER])).toEqual({
        previous: [
          {
            actual,
            expected: CURRENT_NATIVE_GRAPH_LAUNCHER,
          },
        ],
        added: [],
      });
    },
  );

  it.each([
    ["a different historical Graph pin", ["uvx", "code-review-graph@2.1.1", "serve"]],
    ["an extra hardened Graph argument", [...HARDENED_GRAPH_LAUNCHER.command, "--operator"]],
    ["a different historical Graph subcommand", ["uvx", "code-review-graph@2.1.0", "status"]],
  ])("does not attribute %s to AIH", (_name, actual) => {
    expect(
      managedAllowlistGenerationDelta([actual], [CURRENT_NATIVE_GRAPH_LAUNCHER]),
    ).toBeUndefined();
  });

  it("does not attribute the historical launcher to an arbitrary native wrapper", () => {
    const unrelatedWrapper = [...CURRENT_NATIVE_GRAPH_LAUNCHER];
    unrelatedWrapper[4] = "code-review-graph==9.9.9";

    expect(
      managedAllowlistGenerationDelta(
        [[...PRE_HARDENING_GRAPH_LAUNCHER.command]],
        [unrelatedWrapper],
      ),
    ).toBeUndefined();
  });
});
