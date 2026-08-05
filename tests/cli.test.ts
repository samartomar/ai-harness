import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_COMMAND_SPEC_PATHS,
  ALL_COMMAND_SPECS,
  ALL_COMMANDS,
  CAPABILITIES,
  PARENT_GROUPS,
  READONLY,
} from "../src/commands/index.js";
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

  it("declares 29 capabilities and 8 read-only commands", () => {
    expect(CAPABILITIES).toHaveLength(29);
    expect(READONLY).toHaveLength(8);
  });

  it("registers workspace acquisition, graph, snapshot, and plan subcommands", () => {
    const workspace = buildProgram().commands.find((c) => c.name() === "workspace");
    expect(workspace?.commands.map((c) => c.name()).sort()).toEqual([
      "add",
      "graph",
      "hydrate",
      "init",
      "link",
      "plan",
      "report",
      "snapshot",
    ]);
  });

  it("registers mcp approve as a nested command", () => {
    const mcp = buildProgram().commands.find((c) => c.name() === "mcp");
    expect(mcp?.commands.map((c) => c.name()).sort()).toEqual(["approve"]);
  });

  it("registers trust scan as a nested command", () => {
    const trust = buildProgram().commands.find((c) => c.name() === "trust");
    expect(trust?.commands.map((c) => c.name()).sort()).toEqual([
      "allow",
      "list",
      "pin",
      "scan",
      "skillspector-pin",
      "verify",
    ]);
  });

  it("registers skill vet, card, approve, inventory, quarantine, remove, and sync as nested commands", () => {
    const skill = buildProgram().commands.find((c) => c.name() === "skill");
    expect(skill?.commands.map((c) => c.name()).sort()).toEqual([
      "approve",
      "card",
      "inventory",
      "quarantine",
      "remove",
      "sync",
      "vet",
    ]);
  });

  it("registers pack authoring, install, plan, status, uninstall, and validate as nested commands", () => {
    const pack = buildProgram().commands.find((c) => c.name() === "pack");
    expect(pack?.commands.map((c) => c.name()).sort()).toEqual([
      "add",
      "init",
      "install",
      "plan",
      "remove-entry",
      "scaffold",
      "status",
      "uninstall",
      "validate",
    ]);
  });

  it("registers capability resolve and prune as nested commands", () => {
    const capability = buildProgram().commands.find((c) => c.name() === "capability");
    expect(capability?.commands.map((c) => c.name()).sort()).toEqual(["prune", "resolve"]);
  });

  it("registers policy starter, evaluation, projection, validation, and pin verification as nested commands", () => {
    const policy = buildProgram().commands.find((c) => c.name() === "policy");
    expect(policy?.commands.map((c) => c.name()).sort()).toEqual([
      "evaluate",
      "init",
      "project",
      "validate",
      "verify",
    ]);
  });

  it("policy subcommands accept an optional [root] like other repo-scoped commands", () => {
    const policy = buildProgram().commands.find((c) => c.name() === "policy");
    expect(policy?.commands.length).toBeGreaterThan(0);
    for (const sub of policy?.commands ?? []) {
      expect(
        sub.registeredArguments.map((a) => ({ name: a.name(), required: a.required })),
        `policy ${sub.name()} should take an optional [root]`,
      ).toEqual([{ name: "root", required: false }]);
    }
  });

  it("resolves a policy validate positional root like other repo-scoped commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-policy-root-"));
    const priorExitCode = process.exitCode;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      writeFileSync(join(dir, "aih-org-policy.json"), "{not json");
      const program = buildProgram();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await program.parseAsync(["node", "aih", "policy", "validate", dir, "--json", "--no-log"]);

      // The positional root targeted the tmp repo: its malformed policy is the finding.
      expect(process.exitCode).toBe(1);
      expect(writes.join("")).toContain("org-policy.invalid");
    } finally {
      spy.mockRestore();
      process.exitCode = priorExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers truth pack and verify as nested commands", () => {
    const truth = buildProgram().commands.find((c) => c.name() === "truth");
    expect(truth?.commands.map((c) => c.name()).sort()).toEqual(["pack", "verify"]);
  });

  it("keeps the canonical CommandSpec registry complete for every registered built-in spec", () => {
    const bareParentGroups = new Set<string>(PARENT_GROUPS.filter((name) => name !== "workspace"));
    const registeredPaths = (program: Command): string[] =>
      program.commands.flatMap((cmd) => {
        const root = cmd.name();
        const paths = bareParentGroups.has(root) ? [] : [root];
        return [...paths, ...cmd.commands.map((sub) => `${root} ${sub.name()}`)];
      });
    const expected = registeredPaths(buildProgram()).sort();
    const actual = ALL_COMMAND_SPEC_PATHS.map((path) => path.join(" ")).sort();

    expect(actual).toEqual(expected);
    expect(ALL_COMMAND_SPECS).toHaveLength(expected.length);
  });

  it("parses a dry-run capability invocation without throwing", async () => {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(["node", "aih", "certs", "--json"])).resolves.toBeDefined();
  }, 20000); // full-program cold start + certs dry-run can edge past the 5s default on slow Windows CI
});
