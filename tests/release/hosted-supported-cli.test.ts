import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const args = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/custody-arguments.mjs")).href
);
const root = resolve("disposable-target");
const decision = "decision-fixture";
const digest = `sha256:${"a".repeat(64)}`;
const accept = args.supportedAcceptArguments(root, decision, digest);

it.each([
  ["custody preview", accept, []],
  ["custody apply and repeat", [...accept, "--apply"], []],
  ["custody inspect", args.supportedInspectArguments(root), []],
  ["npm observe", args.npmObserveArguments(root, decision, digest), [root]],
  ["npm lifecycle preview", args.npmLifecycleArguments(root, decision, digest), [root]],
  [
    "npm lifecycle apply, repeat and revoke",
    args.npmLifecycleArguments(root, decision, digest, true),
    [root],
  ],
  ["evaluate before and after revocation", args.policyEvaluateArguments(root), [root]],
])("parses shared hosted %s arguments through the current CLI", (_label, argv, operands) => {
  let command = buildProgram();
  let offset = 0;
  while (offset < argv.length) {
    const child = command.commands.find((entry) => entry.name() === argv[offset]);
    if (!child) break;
    command = child;
    offset += 1;
  }
  expect(offset).toBeGreaterThanOrEqual(2);
  const parsed = command.parseOptions([...argv.slice(offset), "--posture", "enterprise"]);
  expect(parsed.unknown).toEqual([]);
  expect(parsed.operands).toEqual(operands);
  expect(command.opts().posture).toBe("enterprise");
  if (argv.includes("--json")) expect(command.opts().json).toBe(true);
  if (argv.includes("--apply")) expect(command.opts().apply).toBe(true);
  if (argv.includes("--root")) expect(command.opts().root).toBe(root);
});

it("keeps historical Workbench generation scoped to pinned public Core 0.6.1", () => {
  const htmlPath = resolve("workbench.html");
  expect(args.workbenchGenerateArguments(htmlPath)).toEqual([
    "policy",
    "generate",
    "--apply",
    "--out",
    htmlPath,
    "--no-log",
  ]);

  const identity = readFileSync(
    resolve(".github/public-policy-acceptance/validate-public-inputs.mjs"),
    "utf8",
  );
  const hosted = readFileSync(resolve(".github/public-policy-acceptance/run-848.mjs"), "utf8");
  expect(identity).toMatch(/version:'0\.6\.1'/u);
  expect(identity).toMatch(/tag:'v-core-0\.6\.1'/u);
  expect(hosted).toContain("assert.equal(manifest.version, '0.6.1')");
  expect(hosted).toContain("workbenchGenerateArguments(htmlPath)");

  const policy = buildProgram().commands.find((entry) => entry.name() === "policy");
  expect(policy).toBeDefined();
  expect(policy?.commands.some((entry) => entry.name() === "generate")).toBe(false);
});
