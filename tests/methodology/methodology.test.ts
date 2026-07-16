import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import {
  METHODOLOGY_PHASE_ONE_BOUNDARY,
  registerMethodologyCommands,
  runMethodologyCommand,
} from "../../src/methodology/index.js";
import {
  canonicalizeMethodologyIntent,
  exactSourceIdentity,
  MethodologyIntentSchema,
  MethodologyStatusSchema,
} from "../../src/methodology/schema.js";

const tmps: string[] = [];
const TEST_PROCESS_TIMEOUT_MS = 25_000;

function fresh(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function intent(componentIds = ["method-routing", "review-loop"]): unknown {
  return {
    schemaVersion: 1,
    selection: {
      provider: "ecc",
      source: {
        host: "github.com",
        owner: "affaan-m",
        repo: "ECC",
        commit: "a".repeat(40),
        checkout: "provider-source",
      },
      components: componentIds.map((id) => ({ id })),
      providerAdapter: "ecc-static-v1",
      hostAdapter: "claude-code-static-v1",
      compatibility: {
        host: "claude-code",
        hostVersion: "2.1.183",
        executableSha256: "b".repeat(64),
        os: "win32",
        architecture: "x64",
        runtime: "node-26",
        policyContext: "unmanaged",
      },
    },
  };
}

function writeIntent(root: string, relative: string, value: unknown): void {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function runAih(
  root: string,
  command: string,
  intentPath = "methodology.intent.json",
  extra: string[] = [],
) {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(
    process.execPath,
    [
      tsx,
      "src/cli.ts",
      "methodology",
      command,
      "--root",
      root,
      "--intent",
      intentPath,
      "--json",
      ...extra,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: TEST_PROCESS_TIMEOUT_MS,
    },
  );
}

function runInProcess(
  root: string,
  command: "inspect" | "project" | "status",
  intentPath = "methodology.intent.json",
  json = true,
) {
  let stdout = "";
  let stderr = "";
  const exitCode = runMethodologyCommand(
    command,
    { root, intent: intentPath, json },
    {
      write: (text) => {
        stdout += text;
      },
      writeError: (text) => {
        stderr += text;
      },
    },
  );
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  while (tmps.length > 0) {
    const root = tmps.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("methodology Phase 1 schemas", () => {
  it("rejects an unknown intent field and keeps the exact source tuple closed", () => {
    const invalid = intent() as { selection: Record<string, unknown> };
    invalid.selection.unexpected = true;

    expect(() => MethodologyIntentSchema.parse(invalid)).toThrow();
  });

  it("canonicalizes component ordering without changing exact-source identity", () => {
    const forward = canonicalizeMethodologyIntent(MethodologyIntentSchema.parse(intent()));
    const reverse = canonicalizeMethodologyIntent(
      MethodologyIntentSchema.parse(intent(["review-loop", "method-routing"])),
    );

    expect(forward.selection.components.map((component) => component.id)).toEqual([
      "method-routing",
      "review-loop",
    ]);
    expect(exactSourceIdentity(forward)).toEqual(exactSourceIdentity(reverse));
  });

  it("rejects unknown nested adapter fields in a closed status record", () => {
    const root = fresh("aih-methodology-closed-status-");
    writeIntent(root, "methodology.intent.json", intent());
    const result = runInProcess(root, "inspect");
    const status = JSON.parse(result.stdout).status;
    status.adapters.provider.unexpected = true;

    expect(() => MethodologyStatusSchema.parse(status)).toThrow();
  });
});

describe("methodology Phase 1 in-process boundaries", () => {
  it("returns bounded statuses and exits for all three commands", () => {
    const root = fresh("aih-methodology-in-process-success-");
    writeIntent(root, "methodology.intent.json", intent());

    for (const [command, exitCode, state] of [
      ["inspect", 0, "selected"],
      ["project", 2, "blocked"],
      ["status", 0, "advisory"],
    ] as const) {
      const result = runInProcess(root, command);

      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        status: { state },
        boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
      });
    }
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("returns exit 1 for invalid and unreadable intent paths", () => {
    const root = fresh("aih-methodology-in-process-invalid-");
    writeIntent(root, "methodology.intent.json", intent());

    const invalid = runInProcess(root, "inspect", "../intent.json");
    const unreadable = runInProcess(root, "inspect", "absent.json", false);

    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).status.findings[0]).toMatchObject({
      code: "METHODOLOGY_INTENT_PATH_INVALID",
    });
    expect(unreadable.exitCode).toBe(1);
    expect(unreadable.stderr).toContain("METHODOLOGY_INTENT_UNREADABLE");
  });

  it("fails closed for malformed JSON, symbolic links, and non-regular intent paths", () => {
    const root = fresh("aih-methodology-in-process-fail-closed-");
    write(root, "invalid.json", "not JSON\n");
    write(root, "directory", "");
    mkdirSync(join(root, "intent-directory"));
    symlinkSync(join(root, "invalid.json"), join(root, "linked.json"));

    const invalidJson = runInProcess(root, "inspect", "invalid.json");
    const linked = runInProcess(root, "inspect", "linked.json");
    const directory = runInProcess(root, "inspect", "intent-directory");
    const nestedFile = runInProcess(root, "inspect", "directory/intent.json", false);

    for (const result of [invalidJson, linked, directory]) {
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout).status.findings[0]).toMatchObject({
        code: "METHODOLOGY_INTENT_MALFORMED",
      });
    }
    expect(nestedFile.exitCode).toBe(3);
    expect(nestedFile.stderr).toContain("METHODOLOGY_INTENT_MALFORMED");
  });

  it("registers only the three declarative Phase 1 subcommands", () => {
    const parent = new Command();
    registerMethodologyCommands(parent);

    expect(parent.commands.map((command) => command.name())).toEqual([
      "inspect",
      "project",
      "status",
    ]);
    expect(
      parent.commands.flatMap((command) => command.options.map((option) => option.long)),
    ).toEqual([
      "--intent",
      "--root",
      "--json",
      "--intent",
      "--root",
      "--json",
      "--intent",
      "--root",
      "--json",
    ]);
  });
});

describe("aih methodology Phase 1 child-process boundary", () => {
  it("exits 0 for read-only inspect and reports declarative no-execution boundaries", () => {
    const root = fresh("aih-methodology-inspect-");
    writeIntent(root, "methodology.intent.json", intent());
    write(
      root,
      "provider-source/package.json",
      JSON.stringify({ scripts: { postinstall: "touch provider-ran" } }),
    );
    write(root, "host-launch-canary.sh", "touch host-ran\n");

    const result = runAih(root, "inspect");

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: "inspect",
      outcome: "completed",
      status: { state: "selected" },
      boundary: {
        providerExecution: false,
        providerFetch: false,
        hostExecution: false,
        writes: false,
      },
    });
    expect(existsSync(join(root, "provider-source", "provider-ran"))).toBe(false);
    expect(existsSync(join(root, "host-ran"))).toBe(false);
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("exits 0 with identical identity for equivalent component orderings", () => {
    const root = fresh("aih-methodology-canonical-");
    writeIntent(root, "forward.json", intent());
    writeIntent(root, "reverse.json", intent(["review-loop", "method-routing"]));

    const forward = runAih(root, "inspect", "forward.json");
    const reverse = runAih(root, "inspect", "reverse.json");

    expect(forward.status, forward.stderr).toBe(0);
    expect(reverse.status, reverse.stderr).toBe(0);
    expect(JSON.parse(forward.stdout).status.identity).toEqual(
      JSON.parse(reverse.stdout).status.identity,
    );
  });

  it("exits 2 because Phase 1 project is permanently dry-run and has no write path", () => {
    const root = fresh("aih-methodology-project-");
    writeIntent(root, "methodology.intent.json", intent());

    const result = runAih(root, "project");

    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "project",
      outcome: "blocked",
      status: {
        state: "blocked",
        findings: [expect.objectContaining({ code: "METHODOLOGY_PHASE_ONE_NO_PROJECTION" })],
      },
    });
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("exits 3 fail-closed for malformed identity without creating a projection", () => {
    const root = fresh("aih-methodology-malformed-");
    const malformed = intent() as { selection: { source: { commit: string } } };
    malformed.selection.source.commit = "not-a-commit";
    writeIntent(root, "methodology.intent.json", malformed);

    const result = runAih(root, "inspect");

    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "fail-closed",
      status: {
        state: "fail-closed",
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
      },
    });
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("exits 3 fail-closed for an intent hard-linked from outside the project root", () => {
    const root = fresh("aih-methodology-hard-link-root-");
    const outside = fresh("aih-methodology-hard-link-outside-");
    writeIntent(outside, "valid.json", intent());
    linkSync(join(outside, "valid.json"), join(root, "hard-linked.json"));

    const result = runAih(root, "inspect", "hard-linked.json");

    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "fail-closed",
      status: {
        state: "fail-closed",
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
      },
    });
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("exits 1 and rejects forbidden mutation and execution flags", () => {
    const root = fresh("aih-methodology-forbidden-");
    writeIntent(root, "methodology.intent.json", intent());

    for (const flag of [
      "--apply",
      "--clean",
      "--fetch",
      "--install",
      "--activate",
      "--switch",
      "--deactivate",
      "--repair",
      "--update",
      "--preview",
      "--force",
      "--approve",
      "--suppress",
      "--host-launch",
    ]) {
      const result = runAih(root, "project", "methodology.intent.json", [flag]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unknown option '${flag}'`);
    }
    expect(existsSync(join(root, ".aih"))).toBe(false);
  }, 30_000);

  it("exits 0 for bounded advisory status without claiming runtime activation", () => {
    const root = fresh("aih-methodology-status-");
    writeIntent(root, "methodology.intent.json", intent());

    const result = runAih(root, "status");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "status",
      outcome: "completed",
      status: {
        state: "advisory",
        claims: {
          installed: false,
          active: false,
          isolated: false,
          switchable: false,
          concurrent: false,
          conflictFree: false,
        },
      },
    });
  });
});
