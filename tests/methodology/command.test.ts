import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { runMethodologyCommand } from "../../src/methodology/command.js";
import { buildProgram } from "../../src/program.js";

let root: string;
const resolvedCommit = "a".repeat(40);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-methodology-command-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "gstack",
      engines: { bun: ">=1.0.0" },
      scripts: { test: "bun test" },
    }),
    "utf8",
  );
  for (const path of [
    "agents",
    "browse",
    "claude",
    "codex",
    "design/src",
    "gstack",
    "hosts",
    "bin",
    "open-gstack-browser",
    "scripts",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  for (const path of [
    "bin/gstack-team-init",
    "bin/gstack-gbrain-install",
    "scripts/setup-scc.sh",
    "bin/gstack-uninstall",
    "bin/gstack-brain-uninstall",
    "bin/gstack-update-check",
    "bin/gstack-ios-qa-daemon",
    "design/src/daemon.ts",
    "hosts/codex.ts",
    "bin/gstack-codex-probe",
  ]) {
    writeFileSync(join(root, path), "throw new Error('must not run');", "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runner() {
  return fakeRunner((argv) => {
    expect(argv).toEqual(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
    return { stdout: `${resolvedCommit}\n` };
  });
}

describe("methodology command surface", () => {
  it("registers only the read-only inspect, plan, qualify, and status subcommands", () => {
    const methodology = buildProgram().commands.find(
      (candidate) => candidate.name() === "methodology",
    );

    expect(methodology?.commands.map((candidate) => candidate.name()).sort()).toEqual([
      "inspect",
      "plan",
      "qualify",
      "status",
    ]);
    for (const command of methodology?.commands ?? []) {
      const flags = command.options.map((option) => option.flags);
      expect(flags).toContain("--json");
      expect(flags).not.toContain("--apply");
      expect(flags).not.toContain("--force");
    }
  });

  it("reports an unenrolled root without writing project methodology authority", async () => {
    const result = await runMethodologyCommand({ action: "status", root });

    expect(result).toMatchObject({
      status: "success",
      value: {
        enrollment: "unenrolled",
        activation: "inactive",
        selectedProvider: undefined,
        latestQualification: "unknown",
        providerCodeExecuted: false,
      },
    });
    expect(result.summary).not.toMatch(/install|activate|switch/i);
    expect(result.nextActions).not.toContain(expect.stringMatching(/install|activate|switch/i));
  });

  it("inspects the exact local gstack tree as inert data without executing provider code", async () => {
    const result = await runMethodologyCommand({
      action: "inspect",
      provider: "gstack",
      sourceRoot: root,
      runner: runner(),
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        source: { repository: "garrytan/gstack", resolvedCommit },
        topology: {
          providerKind: "hybrid-host-setup",
          methodologyClosure: ["agents", "claude", "codex", "gstack", "hosts"],
        },
        providerCodeExecuted: false,
      },
    });
  });

  it("fails closed for an unsupported provider instead of selecting a fallback", async () => {
    const result = await runMethodologyCommand({
      action: "inspect",
      provider: "unreviewed-provider",
      sourceRoot: root,
      runner: runner(),
    });

    expect(result).toMatchObject({
      status: "error",
      findings: [{ code: "PROVIDER_UNKNOWN" }],
      value: { providerCodeExecuted: false },
    });
  });

  it("rejects an unavailable source root before invoking Git", async () => {
    const result = await runMethodologyCommand({
      action: "inspect",
      provider: "gstack",
      sourceRoot: join(root, "missing"),
      runner: fakeRunner(() => {
        throw new Error("Git must not run for an unavailable source root");
      }),
    });

    expect(result).toMatchObject({
      status: "error",
      findings: [{ code: "PROVIDER_SOURCE_UNRESOLVED" }],
      value: { providerCodeExecuted: false },
    });
  });

  it("returns a blocked exact qualification report rather than any activation claim", async () => {
    const result = await runMethodologyCommand({
      action: "qualify",
      provider: "gstack",
      sourceRoot: root,
      host: "codex-0.144.1-windows-x64-v1",
      now: () => "2026-07-15T00:00:00.000Z",
      runner: runner(),
    });

    expect(result).toMatchObject({
      status: "warning",
      value: {
        providerCodeExecuted: false,
        qualification: {
          classification: "QUALIFICATION_BLOCKED",
          supportLevel: "plannable",
          findings: ["ADAPTER_COMPATIBILITY_UNKNOWN"],
        },
      },
    });
    expect(result.summary).not.toMatch(/activate|switch/i);
    expect((result.value.plan as { impacts: { uninstall: string } }).impacts.uninstall).toBe(
      "unknown",
    );
  });
});
