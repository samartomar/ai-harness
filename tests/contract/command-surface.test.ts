/**
 * v1.0.0 CLI surface contract (slice 1, issue #123).
 *
 * `tests/contract/command-surface.json` is the COMMITTED snapshot of the entire
 * commander surface built by `buildProgram()` (sync — core commands only, no
 * plugins): every command and nested subcommand with its name, deprecated
 * aliases when present (old names still dispatched — aliases ARE contract),
 * description-presence, positional arguments (name + required), and options
 * (flags + string/boolean defaults). The compatibility surface began with the
 * published v1 package and is retained by `@aihq/core`; ANY drift fails
 * here and forces a conscious, reviewed decision.
 *
 * Regenerating after an INTENTIONAL, ADDITIVE change (new command/option/argument):
 *
 *   AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts
 *   (PowerShell: $env:AIH_REGEN_CONTRACT="1"; npx vitest run tests/contract/command-surface.test.ts)
 *
 * Commit the fixture diff in the same PR and label it `contract:additive`.
 * Removals/renames are breaking: majors only — see STABILITY.md.
 *
 * Determinism: the walk captures no text prose (description PRESENCE only, so
 * copy edits never churn it), no version value, no paths, and nothing
 * platform-conditional — command registration in src/commands/index.ts is a
 * static list and every spec's `options` array is a literal. Commands and
 * options are code-unit sorted at every level (never localeCompare, which is
 * locale-dependent); positional arguments keep declaration order because their
 * order IS the CLI contract.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { POSTURES } from "../../src/config/posture.js";
import { type CommandSpec, plan } from "../../src/internals/plan.js";
import { buildProgram } from "../../src/program.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "command-surface.json");

interface SurfaceArgument {
  name: string;
  required: boolean;
}

interface SurfaceOption {
  flags: string;
  /** Pinned only for string/boolean defaults — the values a user can rely on. */
  defaultValue?: string | boolean;
}

interface SurfaceCommand {
  name: string;
  /**
   * Alternate names this command answers to (CommandSpec aliases and
   * deprecatedAliases). Key present only when non-empty, so alias-free commands
   * stay byte-identical.
   */
  aliases?: string[];
  /** Presence only, never the text — reworded help must not be a contract change. */
  hasDescription: boolean;
  arguments: SurfaceArgument[];
  options: SurfaceOption[];
  commands: SurfaceCommand[];
}

/** Code-unit comparison — byte-stable across OS and locale, unlike localeCompare. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shapeOption(flags: string, defaultValue: unknown): SurfaceOption {
  return typeof defaultValue === "string" || typeof defaultValue === "boolean"
    ? { flags, defaultValue }
    : { flags };
}

/** `aliases` key only when non-empty (sorted) — absent-vs-empty must not churn the fixture. */
function shapeAliases(aliases: readonly string[] | undefined): { aliases?: string[] } {
  return aliases !== undefined && aliases.length > 0
    ? { aliases: [...aliases].sort(byCodeUnit) }
    : {};
}

/** Walk one commander Command into its canonical (sorted, fixed-key-order) surface node. */
function surfaceOf(cmd: Command): SurfaceCommand {
  return {
    name: cmd.name(),
    ...shapeAliases(cmd.aliases()),
    hasDescription: cmd.description().length > 0,
    // Positional order is part of the CLI contract — do NOT sort arguments.
    arguments: cmd.registeredArguments.map((a) => ({ name: a.name(), required: a.required })),
    options: cmd.options
      .map((o) => shapeOption(o.flags, o.defaultValue))
      .sort((x, y) => byCodeUnit(x.flags, y.flags)),
    commands: cmd.commands.map((c) => surfaceOf(c)).sort((x, y) => byCodeUnit(x.name, y.name)),
  };
}

/** Re-shape an already-parsed surface node into canonical form (for fixture linting). */
function canonicalize(node: SurfaceCommand): SurfaceCommand {
  return {
    name: node.name,
    ...shapeAliases(node.aliases),
    hasDescription: node.hasDescription,
    arguments: node.arguments.map((a) => ({ name: a.name, required: a.required })),
    options: node.options
      .map((o) => shapeOption(o.flags, o.defaultValue))
      .sort((x, y) => byCodeUnit(x.flags, y.flags)),
    commands: node.commands.map((c) => canonicalize(c)).sort((x, y) => byCodeUnit(x.name, y.name)),
  };
}

/** The one true fixture serialization: 2-space indent, trailing newline. */
function canonicalJson(surface: SurfaceCommand): string {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

function liveSurface(): SurfaceCommand {
  return surfaceOf(buildProgram());
}

function readFixtureRaw(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

const REGEN = process.env.AIH_REGEN_CONTRACT === "1";

const DRIFT_GUIDANCE = [
  "CLI surface drift: the live commander surface no longer matches tests/contract/command-surface.json.",
  "That fixture is the AIH CLI compatibility contract; the @aihq/core package transition does not reset it.",
  "- ADDITIVE change (new command/subcommand/option/argument)? Regenerate the fixture IN THIS PR:",
  "    AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts",
  "  commit the fixture diff, and label the PR `contract:additive`.",
  "- REMOVAL or RENAME of any command/option/argument is a BREAKING change: majors only — see STABILITY.md.",
].join("\n");

describe("v1 contract — CLI command surface", () => {
  it("matches the committed command-surface fixture", () => {
    const live = liveSurface();
    if (REGEN) {
      writeFileSync(FIXTURE_PATH, canonicalJson(live));
      return; // fixture freshly regenerated from the live surface — nothing to compare
    }
    const fixture = JSON.parse(readFixtureRaw()) as SurfaceCommand;
    expect(live, DRIFT_GUIDANCE).toEqual(fixture);
  });

  it("fixture file itself stays canonical (sorted, stable key order, 2-space indent, trailing \\n)", () => {
    const raw = readFixtureRaw();
    const reserialized = canonicalJson(canonicalize(JSON.parse(raw) as SurfaceCommand));
    expect(
      raw,
      "tests/contract/command-surface.json is not in canonical form (hand edit?). " +
        "Regenerate it: AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts",
    ).toBe(reserialized);
  });

  it("surface is OS-deterministic: no absolute paths, drive letters, or home dirs", () => {
    const text = canonicalJson(liveSurface());
    expect(text).not.toMatch(/[A-Za-z]:\\/); // Windows drive-letter paths
    expect(text).not.toMatch(/\/(?:home|Users)\//); // POSIX home dirs
    expect(text).not.toContain("\\\\"); // UNC / escaped backslashes
  });

  it("advertises only vibe and enterprise posture options in CLI help", () => {
    expect(POSTURES).toEqual(["vibe", "enterprise"]);

    const commands = (command: Command): Command[] => [
      command,
      ...command.commands.flatMap((child) => commands(child)),
    ];
    const postureHelp = commands(buildProgram())
      .flatMap((command) => command.options)
      .filter((option) => option.flags === "--posture <posture>")
      .map((option) => option.description);

    expect(postureHelp.length).toBeGreaterThan(0);
    expect([...new Set(postureHelp)]).toEqual(["governance posture: vibe | enterprise"]);
  });

  it("read-only top-level commands accept the posture flag without changing apply behavior", () => {
    const root = liveSurface();
    for (const name of [
      "doctor",
      "docs-lint",
      "governance-doctor",
      "status",
      "verify-bundle",
      "verify-release",
    ]) {
      const cmd = root.commands.find((c) => c.name === name);
      expect(cmd?.options.map((o) => o.flags)).toContain("--posture <posture>");
      expect(cmd?.options.map((o) => o.flags)).toContain("--context-dir <dir>");
    }
  });

  it("exposes one explicit policy-file selector on repo-scoped policy consumers", () => {
    const root = liveSurface();
    const paths = [
      ["policy", "validate"],
      ["policy", "evaluate"],
      ["policy", "project"],
      ["policy", "resolve"],
      ["trust", "scan"],
    ];
    for (const [parentName, childName] of paths) {
      const parent = root.commands.find((command) => command.name === parentName);
      const child = parent?.commands.find((command) => command.name === childName);
      expect(
        child?.options.map((option) => option.flags),
        `${parentName} ${childName}`,
      ).toContain("--policy <file>");
    }
  });

  it("keeps the zero-write governance-doctor route free of mutating and artifact flags", () => {
    const node = liveSurface().commands.find((c) => c.name === "governance-doctor");
    const flags = node?.options.map((o) => o.flags) ?? [];
    // `--repair-plan` is the preview-only presentation flag: it mints no
    // authority and makes nothing executable. Mutating and artifact flags stay
    // absent.
    expect(flags.sort()).toEqual([
      "--context-dir <dir>",
      "--json",
      "--policy <file>",
      "--posture <posture>",
      "--repair-plan",
      "--root <dir>",
    ]);
    expect(node?.commands).toEqual([]);
  });

  it("exposes repair as an isolated explicit-apply route without shared bypass flags", () => {
    const node = liveSurface().commands.find((c) => c.name === "repair");
    const flags = node?.options.map((o) => o.flags) ?? [];
    expect(flags.sort()).toEqual([
      "--apply",
      "--context-dir <dir>",
      "--json",
      "--policy <file>",
      "--posture <posture>",
      "--root <dir>",
    ]);
    expect(node?.arguments).toEqual([{ name: "root", required: false }]);
    expect(node?.commands).toEqual([]);
  });

  it("read-only nested commands do not expose ignored mutating flags", () => {
    const root = liveSurface();
    for (const [parentName, childName] of [
      ["skill", "inventory"],
      ["pack", "plan"],
      ["pack", "status"],
      ["pack", "validate"],
      ["marketplace", "validate"],
      ["policy", "validate"],
      ["policy", "verify"],
    ]) {
      const parent = root.commands.find((c) => c.name === parentName);
      const child = parent?.commands.find((c) => c.name === childName);
      const flags = child?.options.map((o) => o.flags) ?? [];
      expect(flags).not.toContain("--apply");
      expect(flags).not.toContain("--force");
      expect(flags).toContain("--context-dir <dir>");
    }
    const capabilityPackage = root.commands
      .find((command) => command.name === "capability")
      ?.commands.find((command) => command.name === "package");
    expect(capabilityPackage?.commands.map(({ name }) => name)).toEqual([
      "add",
      "doctor",
      "list",
      "remove",
      "show",
      "status",
      "update",
    ]);
    for (const command of capabilityPackage?.commands ?? []) {
      const flags = command.options.map(({ flags }) => flags);
      if (["add", "update", "remove"].includes(command.name)) {
        expect(flags).toContain("--apply");
      } else {
        expect(flags).not.toContain("--apply");
      }
      expect(flags).not.toContain("--force");
      expect(flags).toContain("--json");
    }
  });

  it("walk captures aliases (aliases ARE contract)", () => {
    const root = liveSurface();
    const uninstall = root.commands.find((c) => c.name === "uninstall");
    expect(uninstall?.aliases).toEqual(["clean"]);

    // The moment a spec declares deprecatedAliases, the walked surface pins them —
    // so removing an alias before its major is a fixture diff, not a silent break.
    const renamed: CommandSpec = {
      name: "renamed-demo",
      summary: "surface-walk alias capture demo",
      deprecatedAliases: ["old-demo"],
      plan: () => plan("renamed-demo"),
    };
    const node = surfaceOf(buildProgram([renamed])).commands.find((c) => c.name === "renamed-demo");
    expect(node?.aliases).toEqual(["old-demo"]);
  });
});
