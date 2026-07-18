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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  METHODOLOGY_PHASE_ONE_BOUNDARY,
  methodologyCommandSpecs,
  registerMethodologyCommands,
  runMethodologyCommand,
  writeMethodologyParserFailure,
} from "../../src/methodology/index.js";
import {
  canonicalizeMethodologyIntent,
  exactSourceIdentity,
  hostAdapterFor,
  MethodologyCommandEnvelopeSchema,
  MethodologyFailureEnvelopeSchema,
  MethodologyIntentSchema,
  MethodologyStatusSchema,
  providerAdapterFor,
} from "../../src/methodology/schema.js";

const tmps: string[] = [];
const TEST_PROCESS_TIMEOUT_MS = 25_000;
const SUPPORTS_VERIFIED_INTENT_READS = process.platform === "linux";

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

function statusFixture(state: "selected" | "advisory" | "blocked" = "selected") {
  const parsed = MethodologyIntentSchema.parse(intent());
  const findings =
    state === "advisory"
      ? [
          {
            code: "METHODOLOGY_HOST_ADVISORY",
            disposition: "advisory",
            detail: "Phase 1 has no host proof",
          },
        ]
      : state === "blocked"
        ? [
            {
              code: "METHODOLOGY_PHASE_ONE_NO_PROJECTION",
              disposition: "blocked",
              detail: "Phase 1 provides no projection planner",
            },
          ]
        : [];
  return MethodologyStatusSchema.parse({
    schemaVersion: 1,
    state,
    identity: exactSourceIdentity(parsed),
    compatibility: parsed.selection.compatibility,
    adapters: {
      provider: providerAdapterFor(parsed),
      host: hostAdapterFor(parsed),
    },
    claims: {
      installed: false,
      active: false,
      isolated: false,
      switchable: false,
      concurrent: false,
      conflictFree: false,
    },
    findings,
  });
}

function writeIntent(root: string, relative: string, value: unknown): void {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function runAih(
  root: string,
  command: string,
  intentPath = "methodology.intent.json",
  extra: string[] = [],
  timeout = TEST_PROCESS_TIMEOUT_MS,
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
      timeout,
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

  it("rejects an adapter that does not match the selected provider", () => {
    const parsed = MethodologyIntentSchema.parse(intent());
    const mismatchedAdapter = {
      ...parsed,
      selection: {
        ...parsed.selection,
        providerAdapter: "gstack-static-v1",
      },
    } as typeof parsed;

    expect(() => providerAdapterFor(mismatchedAdapter)).toThrow(
      "validated intent named an unavailable provider adapter",
    );
  });

  it("enforces every closed selection binding and unique component identity", () => {
    const base = intent() as { selection: Record<string, unknown> };
    const selection = base.selection as {
      source: Record<string, unknown>;
      compatibility: Record<string, unknown>;
      components: Array<{ id: string }>;
    };
    const invalidSelections = [
      { ...selection, source: { ...selection.source, owner: "other" } },
      { ...selection, providerAdapter: "gstack-static-v1" },
      { ...selection, hostAdapter: "codex-static-v1" },
      { ...selection, components: [selection.components[0], selection.components[0]] },
    ];

    for (const invalidSelection of invalidSelections) {
      expect(
        MethodologyIntentSchema.safeParse({ ...base, selection: invalidSelection }).success,
      ).toBe(false);
    }
  });

  it("binds failure outcome, command selection, state, and finding disposition", () => {
    const boundary = METHODOLOGY_PHASE_ONE_BOUNDARY;
    const malformed = {
      code: "METHODOLOGY_INTENT_MALFORMED",
      disposition: "fail-closed",
      detail: "invalid intent",
    };
    const invalid = {
      code: "METHODOLOGY_INTENT_PATH_INVALID",
      disposition: "blocked",
      detail: "invalid path",
    };

    for (const candidate of [
      {
        schemaVersion: 1,
        command: "inspect",
        outcome: "invalid",
        failure: { schemaVersion: 1, state: "invalid", findings: [malformed] },
        boundary,
      },
      {
        schemaVersion: 1,
        command: "inspect",
        outcome: "invalid",
        failure: { schemaVersion: 1, state: "fail-closed", findings: [malformed] },
        boundary,
      },
      {
        schemaVersion: 1,
        command: null,
        outcome: "invalid",
        failure: { schemaVersion: 1, state: "invalid", findings: [invalid] },
        boundary,
      },
    ]) {
      expect(MethodologyFailureEnvelopeSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects a host adapter lookup that contradicts the validated compatibility host", () => {
    const parsed = MethodologyIntentSchema.parse(intent());
    const mismatchedAdapter = {
      ...parsed,
      selection: {
        ...parsed.selection,
        hostAdapter: "codex-static-v1",
      },
    } as typeof parsed;

    expect(() => hostAdapterFor(mismatchedAdapter)).toThrow(
      "validated intent named an unavailable host adapter",
    );
  });

  it("rejects unknown nested adapter fields in a closed status record", () => {
    const status = statusFixture();

    expect(() =>
      MethodologyStatusSchema.parse({
        ...status,
        adapters: {
          ...status.adapters,
          provider: { ...status.adapters.provider, unexpected: true },
        },
      }),
    ).toThrow();
    expect(() =>
      MethodologyStatusSchema.parse({
        ...status,
        identity: { ...status.identity, sha256: "0".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      MethodologyStatusSchema.parse({
        ...status,
        adapters: {
          ...status.adapters,
          provider: { ...status.adapters.provider, provider: "gstack" },
        },
      }),
    ).toThrow();
    expect(() =>
      MethodologyStatusSchema.parse({
        ...status,
        adapters: {
          ...status.adapters,
          host: { ...status.adapters.host, host: "codex" },
        },
      }),
    ).toThrow();
  });

  it("rejects identity repository/order drift and missing fixed-state findings", () => {
    const status = statusFixture("blocked");
    expect(
      MethodologyStatusSchema.safeParse({
        ...status,
        identity: { ...status.identity, repository: "github.com/other/repository" },
      }).success,
    ).toBe(false);
    expect(
      MethodologyStatusSchema.safeParse({
        ...status,
        identity: { ...status.identity, components: [...status.identity.components].reverse() },
      }).success,
    ).toBe(false);
    expect(MethodologyStatusSchema.safeParse({ ...status, findings: [] }).success).toBe(false);
  });

  it("rejects contradictory status findings and command/status combinations", () => {
    const inspected = {
      schemaVersion: 1,
      command: "inspect" as const,
      outcome: "completed" as const,
      status: statusFixture(),
      boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
    };
    const projected = {
      schemaVersion: 1,
      command: "project" as const,
      outcome: "blocked" as const,
      status: statusFixture("blocked"),
      boundary: METHODOLOGY_PHASE_ONE_BOUNDARY,
    };
    const advisoryFinding = {
      code: "METHODOLOGY_HOST_ADVISORY",
      disposition: "advisory",
      detail: "Phase 1 has no host proof",
    };

    expect(() =>
      MethodologyStatusSchema.parse({
        ...inspected.status,
        findings: [advisoryFinding],
      }),
    ).toThrow();
    expect(() =>
      MethodologyCommandEnvelopeSchema.parse({
        ...inspected,
        status: {
          ...inspected.status,
          state: "advisory",
          findings: [advisoryFinding],
        },
      }),
    ).toThrow();
    expect(() =>
      MethodologyCommandEnvelopeSchema.parse({
        ...projected,
        status: {
          ...projected.status,
          state: "advisory",
          findings: [advisoryFinding],
        },
      }),
    ).toThrow();
  });
});

describe("methodology Phase 1 in-process boundaries", () => {
  it("keeps declarative command plans read-only and action-free", () => {
    for (const spec of methodologyCommandSpecs) {
      expect(spec.plan({} as never)).toMatchObject({
        capability: `methodology ${spec.name}`,
        actions: [],
      });
    }
  });

  it("fails closed before filesystem access when descriptor traversal is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const result = runInProcess("unused", "inspect");
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "fail-closed",
        failure: { findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })] },
      });
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("uses the default process writers without escaping the closed failure envelopes", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        runMethodologyCommand("inspect", { root: "unused", intent: "../intent.json", json: true }),
      ).toBe(1);
      expect(
        runMethodologyCommand("inspect", { root: "unused", intent: "../intent.json", json: false }),
      ).toBe(1);
      expect(
        writeMethodologyParserFailure([
          "node",
          "aih",
          "methodology",
          "inspect",
          "--json",
          "--apply",
        ]),
      ).toBe(true);
      expect(stdout).toHaveBeenCalled();
      expect(stderr).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("fails closed when command option evaluation throws unexpectedly", () => {
    let stderr = "";
    const options = {
      get root(): string {
        throw new Error("hostile root getter");
      },
      intent: "methodology.intent.json",
      json: false,
    };

    expect(
      runMethodologyCommand("inspect", options, {
        write() {},
        writeError(text) {
          stderr += text;
        },
      }),
    ).toBe(3);
    expect(stderr).toContain("METHODOLOGY_INTENT_MALFORMED");
    expect(stderr).not.toContain("hostile root getter");
  });

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "returns bounded statuses and exits for all three commands",
    () => {
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
    },
  );

  it.skipIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "fails closed for every filesystem intent read without Linux descriptor traversal",
    () => {
      const root = fresh("aih-methodology-in-process-platform-gate-");
      writeIntent(root, "methodology.intent.json", intent());

      for (const command of ["inspect", "project", "status"] as const) {
        const result = runInProcess(root, command);
        expect(result.exitCode).toBe(3);
        expect(JSON.parse(result.stdout)).toMatchObject({
          command,
          outcome: "fail-closed",
          failure: {
            state: "fail-closed",
            findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
          },
        });
      }
      expect(existsSync(join(root, ".aih"))).toBe(false);
    },
  );

  it("returns exit 1 for invalid paths and platform-appropriate handling of unreadable inputs", () => {
    const root = fresh("aih-methodology-in-process-invalid-");
    writeIntent(root, "methodology.intent.json", intent());

    const invalid = runInProcess(root, "inspect", "../intent.json");
    const unreadable = runInProcess(root, "inspect", "absent.json", false);

    expect(invalid.exitCode).toBe(1);
    const invalidPayload = JSON.parse(invalid.stdout);
    expect(invalidPayload).toMatchObject({
      outcome: "invalid",
      failure: {
        state: "invalid",
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_PATH_INVALID" })],
      },
    });
    expect(invalidPayload).not.toHaveProperty("status");
    expect(invalidPayload.failure.findings[0]).toMatchObject({
      code: "METHODOLOGY_INTENT_PATH_INVALID",
    });
    if (SUPPORTS_VERIFIED_INTENT_READS) {
      expect(unreadable.exitCode).toBe(1);
      expect(unreadable.stderr).toContain("METHODOLOGY_INTENT_UNREADABLE");
    } else {
      expect(unreadable.exitCode).toBe(3);
      expect(unreadable.stderr).toContain("METHODOLOGY_INTENT_MALFORMED");
    }
  });

  it("fails closed for malformed JSON, symbolic links, and non-regular intent paths", () => {
    const root = fresh("aih-methodology-in-process-fail-closed-");
    write(root, "invalid.json", "not JSON\n");
    const invalidIdentity = intent() as { selection: { source: { commit: string } } };
    invalidIdentity.selection.source.commit = "not-a-commit";
    writeIntent(root, "invalid-identity.json", invalidIdentity);
    write(root, "directory", "");
    mkdirSync(join(root, "intent-directory"));
    symlinkSync(join(root, "invalid.json"), join(root, "linked.json"));

    const invalidJson = runInProcess(root, "inspect", "invalid.json");
    const invalidExactIdentity = runInProcess(root, "inspect", "invalid-identity.json");
    const linked = runInProcess(root, "inspect", "linked.json");
    const directory = runInProcess(root, "inspect", "intent-directory");
    const nestedFile = runInProcess(root, "inspect", "directory/intent.json", false);

    for (const result of [invalidJson, invalidExactIdentity, linked, directory]) {
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "fail-closed",
        failure: {
          state: "fail-closed",
          findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
        },
      });
    }
    expect(nestedFile.exitCode).toBe(3);
    expect(nestedFile.stderr).toContain("METHODOLOGY_INTENT_MALFORMED");
  });

  it("fails closed for linked ancestors and oversized intent bytes before parsing", () => {
    const outside = fresh("aih-methodology-in-process-linked-outside-");
    const wrapper = fresh("aih-methodology-in-process-linked-wrapper-");
    const project = join(outside, "project");
    writeIntent(project, "methodology.intent.json", intent());
    symlinkSync(
      outside,
      join(wrapper, "linked-ancestor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const oversized = fresh("aih-methodology-in-process-oversized-");
    write(oversized, "oversized.json", " ".repeat(64 * 1024 + 1));

    const linkedAncestor = runInProcess(join(wrapper, "linked-ancestor", "project"), "inspect");
    const byteLimit = runInProcess(oversized, "inspect", "oversized.json");

    for (const result of [linkedAncestor, byteLimit]) {
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "fail-closed",
        failure: {
          findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
        },
      });
    }
  });

  it("bounds the root input before attempting a filesystem read", () => {
    const result = runInProcess("x".repeat(4097), "inspect");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "invalid",
      failure: {
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_PATH_INVALID" })],
      },
    });
  });

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "reports a successful non-JSON inspection without a JSON envelope",
    () => {
      const root = fresh("aih-methodology-in-process-text-success-");
      writeIntent(root, "methodology.intent.json", intent());

      const result = runInProcess(root, "inspect", "methodology.intent.json", false);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("methodology inspect: selected\n");
      expect(result.stderr).toBe("");
    },
  );

  it("writes a closed parser envelope only for JSON methodology arguments", () => {
    let stdout = "";
    let stderr = "";
    const deps = {
      write: (text: string) => {
        stdout += text;
      },
      writeError: (text: string) => {
        stderr += text;
      },
    };

    expect(
      writeMethodologyParserFailure(
        ["node", "aih", "methodology", "inspect", "--json", "--apply"],
        deps,
      ),
    ).toBe(true);
    expect(stderr).toBe("");
    expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(stdout))).toMatchObject({
      command: "inspect",
      outcome: "invalid",
    });
    expect(writeMethodologyParserFailure(["node", "aih", "status"], deps)).toBe(false);
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

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      parent.configureOutput().writeOut?.("parent output");
      parent.configureOutput().writeErr?.("parent error");
      for (const command of parent.commands) {
        command.configureOutput().writeOut?.("command output");
        command.configureOutput().writeErr?.("command error");
      }
      expect(stdout).toHaveBeenCalledTimes(4);
      expect(stderr).toHaveBeenCalledTimes(4);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("aih methodology Phase 1 child-process boundary", () => {
  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 0 for read-only inspect and reports declarative no-execution boundaries",
    () => {
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
    },
  );

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 0 with identical identity for equivalent component orderings",
    () => {
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
    },
    30_000,
  );

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 2 because Phase 1 project is permanently dry-run and has no write path",
    () => {
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
    },
  );

  it("exits 3 fail-closed for malformed identity without creating a projection", () => {
    const root = fresh("aih-methodology-malformed-");
    const malformed = intent() as { selection: { source: { commit: string } } };
    malformed.selection.source.commit = "not-a-commit";
    writeIntent(root, "methodology.intent.json", malformed);

    const result = runAih(root, "inspect");

    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "fail-closed",
      failure: {
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
      failure: {
        state: "fail-closed",
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
      },
    });
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 3 promptly for a FIFO intent leaf",
    () => {
      const root = fresh("aih-methodology-fifo-root-");
      const fifo = join(root, "methodology.intent.json");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);

      const result = runAih(root, "inspect", "methodology.intent.json", [], 10_000);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "fail-closed",
        failure: {
          state: "fail-closed",
          findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
        },
      });
      expect(existsSync(join(root, ".aih"))).toBe(false);
    },
    15_000,
  );

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
      expect(result.stderr).toBe("");
      expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
        command: "project",
        outcome: "invalid",
        failure: {
          state: "invalid",
          findings: [expect.objectContaining({ code: "METHODOLOGY_COMMAND_INVALID" })],
        },
      });
    }
    expect(existsSync(join(root, ".aih"))).toBe(false);
  }, 60_000);

  it.runIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 0 for bounded advisory status without claiming runtime activation",
    () => {
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
    },
  );

  it.skipIf(SUPPORTS_VERIFIED_INTENT_READS)(
    "exits 3 in a child process when verified filesystem traversal is unavailable",
    () => {
      const root = fresh("aih-methodology-platform-gated-child-");
      writeIntent(root, "methodology.intent.json", intent());

      const result = runAih(root, "inspect");

      expect(result.status, result.stderr).toBe(3);
      expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
        command: "inspect",
        outcome: "fail-closed",
        failure: {
          state: "fail-closed",
          findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
        },
      });
      expect(existsSync(join(root, ".aih"))).toBe(false);
    },
  );
});
