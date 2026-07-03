import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextStepsDigest, type NextStepsInput } from "../../src/report/nextsteps.js";

interface SurfaceArgument {
  name: string;
  required: boolean;
}

interface SurfaceOption {
  flags: string;
}

interface SurfaceCommand {
  name: string;
  arguments: SurfaceArgument[];
  options: SurfaceOption[];
  commands: SurfaceCommand[];
}

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contract",
  "command-surface.json",
);

function commandSurface(): SurfaceCommand {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SurfaceCommand;
}

function stripComment(line: string): string {
  return line.replace(/\s+#.*$/, "").trim();
}

function tokenize(command: string): string[] {
  return stripComment(command).split(/\s+/).filter(Boolean);
}

function optionNames(option: SurfaceOption): string[] {
  const flagPart = option.flags.split(/[ <[]/)[0] ?? "";
  return flagPart
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.startsWith("-"));
}

function optionTakesValue(option: SurfaceOption): boolean {
  return option.flags.includes("<") || option.flags.includes("[");
}

function validateAihCommand(command: string): string | undefined {
  const tokens = tokenize(command);
  if (tokens[0] !== "aih") return `not an aih command: ${command}`;
  let current = commandSurface();
  let index = 1;
  while (index < tokens.length) {
    const sub = current.commands.find((candidate) => candidate.name === tokens[index]);
    if (sub === undefined) break;
    current = sub;
    index += 1;
  }

  const options = new Map<string, SurfaceOption>();
  for (const option of current.options) {
    for (const name of optionNames(option)) options.set(name, option);
  }

  let positionals = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      const option = options.get(token);
      if (option === undefined) return `unknown option ${token} in ${command}`;
      if (optionTakesValue(option)) index += 1;
      continue;
    }
    positionals += 1;
  }

  const required = current.arguments.filter((arg) => arg.required).length;
  if (positionals < required) return `missing required argument for ${command}`;
  if (positionals > current.arguments.length) return `too many positional arguments for ${command}`;
  return undefined;
}

function commandsFromDigest(input: NextStepsInput): string[] {
  return nextStepsDigest(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("aih "));
}

describe("report remediation commands", () => {
  it("keeps every emitted next-step command inside the CLI contract", () => {
    const commands = commandsFromDigest({
      initialized: true,
      adoption: {
        present: 0,
        total: 5,
        absent: ["gitleaks", "pre-commit", "devcontainer", ".mcp.json", "context-dir"],
      },
      usageEvents: 0,
      toolsMissing: 2,
      scaleGraphMissing: true,
      targets: ["claude", "codex"],
      installedUntargeted: ["kiro"],
    });

    expect(commands).toContain("aih guardrails --apply");
    expect(commands).toContain("aih init --cli claude,codex,kiro --apply");
    expect(commands.map(validateAihCommand).filter(Boolean)).toEqual([]);
  });

  it("would catch the historical bootstrap-ai --scope remediation bug", () => {
    expect(validateAihCommand("aih bootstrap-ai --scope guardrails --apply")).toContain(
      "unknown option --scope",
    );
  });
});
