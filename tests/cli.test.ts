import { describe, expect, it } from "vitest";
import { ALL_COMMANDS, CAPABILITIES, READONLY } from "../src/commands/index.js";
import { buildProgram } from "../src/program.js";

describe("CLI program", () => {
  it("registers every capability and read-only command", () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== "help");
    for (const spec of ALL_COMMANDS) {
      expect(names).toContain(spec.name);
    }
  });

  it("declares 25 capabilities and 3 read-only commands", () => {
    expect(CAPABILITIES).toHaveLength(25);
    expect(READONLY).toHaveLength(3);
  });

  it("registers workspace snapshot and plan subcommands", () => {
    const workspace = buildProgram().commands.find((c) => c.name() === "workspace");
    expect(workspace?.commands.map((c) => c.name()).sort()).toEqual(["plan", "snapshot"]);
  });

  it("parses a dry-run capability invocation without throwing", async () => {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(["node", "aih", "certs", "--json"])).resolves.toBeDefined();
  }, 20000); // full-program cold start + certs dry-run can edge past the 5s default on slow Windows CI
});
