import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

function intent(): unknown {
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

function runAih(root: string, extra: string[] = []) {
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(
    process.execPath,
    [
      tsx,
      "src/cli.ts",
      "methodology",
      "inspect",
      "--root",
      root,
      "--intent",
      "methodology.intent.json",
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
});
