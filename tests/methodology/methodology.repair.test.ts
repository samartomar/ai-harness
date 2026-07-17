import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MethodologyCommandEnvelopeSchema,
  MethodologyFailureEnvelopeSchema,
} from "../../src/methodology/schema.js";

const tmps: string[] = [];
const TEST_PROCESS_TIMEOUT_MS = 25_000;

interface IntentFixture {
  schemaVersion: number;
  selection: {
    provider: string;
    source: {
      host: string;
      owner: string;
      repo: string;
      commit: string;
      checkout: string;
    };
    components: Array<{ id: string }>;
    providerAdapter: string;
    hostAdapter: string;
    compatibility: {
      host: string;
      hostVersion: string;
      executableSha256: string;
      os: string;
      architecture: string;
      runtime: string;
      policyContext: string;
    };
  };
}

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

function intent(): IntentFixture {
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
      components: [{ id: "method-routing" }],
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

function oversizedIntent(): unknown {
  const candidate = intent();
  candidate.selection.components = Array.from({ length: 33 }, (_, index) => ({
    id: `component-${index}`,
  }));
  candidate.selection.source.checkout = "a".repeat(65_536);
  return candidate;
}

function runCli(args: string[]) {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(process.execPath, [tsx, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: TEST_PROCESS_TIMEOUT_MS,
  });
}

function runAih(root: string, extra: string[] = []) {
  return runCli([
    "methodology",
    "inspect",
    "--root",
    root,
    "--intent",
    "methodology.intent.json",
    "--json",
    ...extra,
  ]);
}

afterEach(() => {
  while (tmps.length > 0) {
    const root = tmps.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("methodology Phase 1 repair regressions", () => {
  it("returns a closed JSON invalid envelope for an unknown methodology option", () => {
    const root = fresh("aih-methodology-parser-envelope-");
    write(root, "methodology.intent.json", `${JSON.stringify(intent())}\n`);

    const result = runAih(root, ["--apply"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "inspect",
      outcome: "invalid",
      failure: {
        schemaVersion: 1,
        state: "invalid",
        findings: [
          {
            code: "METHODOLOGY_COMMAND_INVALID",
            disposition: "blocked",
            detail: "methodology command arguments are invalid",
          },
        ],
      },
      boundary: {
        providerExecution: false,
        providerFetch: false,
        hostExecution: false,
        writes: false,
      },
    });
  });

  it("fails closed when a root ancestor is a linked directory", () => {
    const outside = fresh("aih-methodology-linked-ancestor-outside-");
    const wrapper = fresh("aih-methodology-linked-ancestor-wrapper-");
    const project = join(outside, "project");
    write(project, "methodology.intent.json", `${JSON.stringify(intent())}\n`);
    symlinkSync(outside, join(wrapper, "linked-ancestor"), "dir");

    const result = runAih(join(wrapper, "linked-ancestor", "project"));

    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "inspect",
      outcome: "fail-closed",
      failure: {
        state: "fail-closed",
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
      },
    });
  });

  it("rejects contradictory failure states and validates a completed JSON envelope", () => {
    expect(() =>
      MethodologyFailureEnvelopeSchema.parse({
        schemaVersion: 1,
        command: "inspect",
        outcome: "invalid",
        failure: {
          schemaVersion: 1,
          state: "fail-closed",
          findings: [
            {
              code: "METHODOLOGY_HOST_ADVISORY",
              disposition: "advisory",
              detail: "contradictory",
            },
          ],
        },
        boundary: {
          providerExecution: false,
          providerFetch: false,
          hostExecution: false,
          writes: false,
        },
      }),
    ).toThrow();

    const root = fresh("aih-methodology-completed-envelope-");
    write(root, "methodology.intent.json", `${JSON.stringify(intent())}\n`);
    const result = runAih(root);

    expect(result.status, result.stderr).toBe(0);
    expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
      command: "inspect",
      outcome: "completed",
      status: { state: "selected" },
    });
    const completed = JSON.parse(result.stdout) as {
      status: { findings: unknown[] };
    };
    expect(() =>
      MethodologyCommandEnvelopeSchema.parse({
        ...completed,
        status: {
          ...completed.status,
          findings: [
            {
              code: "METHODOLOGY_HOST_ADVISORY",
              disposition: "advisory",
              detail: "contradictory completed status",
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("fails closed before reading an oversized or over-component intent", () => {
    const root = fresh("aih-methodology-input-bounds-");
    write(root, "methodology.intent.json", `${JSON.stringify(oversizedIntent())}\n`);

    const result = runAih(root);

    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "fail-closed",
      failure: {
        findings: [expect.objectContaining({ code: "METHODOLOGY_INTENT_MALFORMED" })],
      },
    });
  });

  it("schema-validates every JSON-mode parser outcome before a command action runs", () => {
    const root = fresh("aih-methodology-parser-outcomes-");
    write(root, "methodology.intent.json", `${JSON.stringify(intent())}\n`);

    const missingIntent = runCli(["methodology", "inspect", "--root", root, "--json"]);
    const unknownSubcommand = runCli(["methodology", "unknown", "--json"]);

    for (const result of [missingIntent, unknownSubcommand]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
        outcome: "invalid",
        failure: {
          state: "invalid",
          findings: [expect.objectContaining({ code: "METHODOLOGY_COMMAND_INVALID" })],
        },
      });
    }
    expect(JSON.parse(missingIntent.stdout).command).toBe("inspect");
    expect(JSON.parse(unknownSubcommand.stdout).command).toBeNull();
  });

  it("keeps help successful and prevents JSON help or version output from contaminating envelopes", () => {
    const plainHelp = runCli(["methodology", "inspect", "--help"]);
    const jsonHelp = runCli(["methodology", "inspect", "--help", "--json"]);
    const jsonVersion = runCli(["methodology", "inspect", "--version", "--json"]);

    expect(plainHelp.status).toBe(0);
    expect(plainHelp.stderr).toBe("");
    expect(plainHelp.stdout).toContain("Usage: aih methodology inspect");
    for (const result of [jsonHelp, jsonVersion]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Usage:");
      expect(result.stdout).not.toContain("2.11.0");
      expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
        command: "inspect",
        outcome: "invalid",
        failure: {
          findings: [expect.objectContaining({ code: "METHODOLOGY_COMMAND_INVALID" })],
        },
      });
    }
  }, TEST_PROCESS_TIMEOUT_MS);

  it("rejects multiple fixed findings in a failure envelope", () => {
    expect(() =>
      MethodologyFailureEnvelopeSchema.parse({
        schemaVersion: 1,
        command: "inspect",
        outcome: "invalid",
        failure: {
          schemaVersion: 1,
          state: "invalid",
          findings: [
            {
              code: "METHODOLOGY_COMMAND_INVALID",
              disposition: "blocked",
              detail: "first",
            },
            {
              code: "METHODOLOGY_COMMAND_INVALID",
              disposition: "blocked",
              detail: "second",
            },
          ],
        },
        boundary: {
          providerExecution: false,
          providerFetch: false,
          hostExecution: false,
          writes: false,
        },
      }),
    ).toThrow();
  });

  it(
    "enforces each bounded Phase 1 input dimension independently",
    () => {
      const tooManyComponents = fresh("aih-methodology-component-limit-");
      const tooLarge = fresh("aih-methodology-byte-limit-");
      const oversizedCheckout = fresh("aih-methodology-checkout-limit-");
      const oversizedVersion = fresh("aih-methodology-version-limit-");
      const componentLimit = intent();
      componentLimit.selection.components = Array.from({ length: 33 }, (_, index) => ({
        id: `component-${index}`,
      }));
      const byteLimit = intent();
      byteLimit.selection.source.checkout = "a".repeat(65_536);
      const checkoutLimit = intent();
      checkoutLimit.selection.source.checkout = "a".repeat(241);
      const versionLimit = intent();
      versionLimit.selection.compatibility.hostVersion = `${"9".repeat(17)}.1`;
      const candidates: Array<[string, IntentFixture]> = [
        [tooManyComponents, componentLimit],
        [tooLarge, byteLimit],
        [oversizedCheckout, checkoutLimit],
        [oversizedVersion, versionLimit],
      ];

      for (const [root, candidate] of candidates) {
        write(root, "methodology.intent.json", `${JSON.stringify(candidate)}\n`);
        const result = runAih(root);

        expect(result.status).toBe(3);
        expect(MethodologyCommandEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({
          outcome: "fail-closed",
        });
      }
    },
    TEST_PROCESS_TIMEOUT_MS,
  );
});
