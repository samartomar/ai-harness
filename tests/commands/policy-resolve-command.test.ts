import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

describe("policy resolve command", () => {
  it("exposes only the bounded evidence-resolution inputs beneath policy", () => {
    const policy = buildProgram().commands.find((command) => command.name() === "policy");
    const resolve = policy?.commands.find((command) => command.name() === "resolve");

    expect(resolve?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(resolve?.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining([
        "--decision <id>",
        "--decision-digest <sha256>",
        "--target <id>",
        "--effect <effect>",
        "--evidence <root-relative-file>",
      ]),
    );
    expect(resolve?.options.map((option) => option.flags)).not.toEqual(
      expect.arrayContaining(["--observation <file>", "--verifier <path>", "--report-only"]),
    );
  });
});
