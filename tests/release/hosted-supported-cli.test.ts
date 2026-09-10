import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const { supportedAcceptArguments, supportedInspectArguments } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/run-848.mjs")).href
);

it("parses every hosted custody preview, apply, repeat and inspect argument through the real CLI", () => {
  const accept = supportedAcceptArguments(
    resolve("disposable-target"),
    "decision-fixture",
    "sha256:" + "a".repeat(64),
  );
  for (const args of [
    accept,
    [...accept, "--apply"],
    supportedInspectArguments(resolve("disposable-target")),
  ]) {
    let command = buildProgram();
    for (const name of args.slice(0, 3)) {
      const child = command.commands.find((entry) => entry.name() === name);
      expect(child).toBeDefined();
      if (!child) throw new Error("custody command missing");
      command = child;
    }
    const parsed = command.parseOptions([...args.slice(3), "--posture", "enterprise"]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.operands).toEqual([]);
    expect(command.opts()).toMatchObject({
      root: resolve("disposable-target"),
      json: true,
      posture: "enterprise",
    });
  }
});
