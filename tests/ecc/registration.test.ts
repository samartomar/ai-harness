import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import {
  emptyRegistrationLedger,
  machineRegistrationUnion,
  mergeRegistrationLedger,
  parseRegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
  serializeRegistrationLedger,
  writeRegistrationLedgerAtomic,
} from "../../src/ecc/registration.js";

let home: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-ecc-ledger-home-"));
  projectA = join(home, "projects", "a");
  projectB = join(home, "projects", "b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function authorization(componentId = "module:rules-core"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function target(componentIds: EccComponentId[]) {
  return {
    target: "codex" as const,
    components: componentIds.map((id) => ({ id, authorization: authorization() })),
    mcps: ["mcp:sequential-thinking" as const],
  };
}

describe("ECC registration ledger", () => {
  it("merges canonical per-project contributions into a deterministic machine union", () => {
    const first = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      {
        root: projectA,
        scope: "scoped",
        components: ["baseline:rules", "framework:react"],
        mcps: ["mcp:sequential-thinking"],
      },
      [target(["baseline:rules", "framework:react"])],
    );
    const second = mergeRegistrationLedger(
      first,
      {
        root: projectB,
        scope: "scoped",
        components: ["baseline:rules", "lang:cpp"],
        mcps: ["mcp:sequential-thinking", "mcp:code-review-graph"],
      },
      [target(["baseline:rules", "framework:react", "lang:cpp"])],
    );

    expect(second.projects.map((project) => project.root)).toEqual([
      realpathSync(projectA),
      realpathSync(projectB),
    ]);
    expect(machineRegistrationUnion(second)).toEqual({
      components: ["baseline:rules", "framework:react", "lang:cpp"],
      mcps: ["mcp:code-review-graph", "mcp:sequential-thinking"],
    });
    expect(second.targets).toEqual([
      expect.objectContaining({
        target: "codex",
        components: [
          expect.objectContaining({ id: "baseline:rules" }),
          expect.objectContaining({ id: "framework:react" }),
          expect.objectContaining({ id: "lang:cpp" }),
        ],
      }),
    ]);

    const project = second.projects.at(1);
    if (project === undefined) throw new Error("missing second project registration");
    const repeated = mergeRegistrationLedger(second, project, second.targets);
    expect(serializeRegistrationLedger(repeated)).toBe(serializeRegistrationLedger(second));
  });

  it("strictly rejects malformed, unknown-version, unknown-key, and duplicate records", () => {
    expect(() => parseRegistrationLedger("not json")).toThrow(/registration ledger/i);
    expect(() =>
      parseRegistrationLedger(JSON.stringify({ schemaVersion: 2, projects: [], targets: [] })),
    ).toThrow(/registration ledger/i);
    expect(() =>
      parseRegistrationLedger(
        JSON.stringify({ schemaVersion: 1, projects: [], targets: [], surprise: true }),
      ),
    ).toThrow(/registration ledger/i);

    const valid = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      {
        root: projectA,
        scope: "scoped",
        components: ["baseline:rules"],
        mcps: [],
      },
      [target(["baseline:rules"])],
    );
    expect(() =>
      parseRegistrationLedger(
        JSON.stringify({ ...valid, projects: [valid.projects[0], valid.projects[0]] }),
      ),
    ).toThrow(/duplicate project root/i);
    expect(() =>
      parseRegistrationLedger(
        JSON.stringify({
          ...valid,
          projects: [{ ...valid.projects[0], components: ["baseline:rules", "baseline:rules"] }],
        }),
      ),
    ).toThrow(/duplicate component/i);
  });

  it("rejects relative project roots instead of resolving them against process cwd", () => {
    expect(() =>
      mergeRegistrationLedger(
        emptyRegistrationLedger(),
        { root: "relative/project", scope: "scoped", components: [], mcps: [] },
        [],
      ),
    ).toThrow(/project root must be absolute/i);
  });

  it("ignores stale partial files but fails closed on malformed primary bytes", () => {
    const directory = join(home, ".aih", "ecc");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".registration-ledger.stale.tmp"), "partial", "utf8");
    expect(readRegistrationLedger(home)).toEqual(emptyRegistrationLedger());

    writeFileSync(registrationLedgerPath(home), "not-json", "utf8");
    expect(() => readRegistrationLedger(home)).toThrow(/invalid ECC registration ledger/i);
  });

  it("writes owner-only JSON atomically and reads it back", () => {
    const ledger = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      { root: projectA, scope: "scoped", components: ["baseline:rules"], mcps: [] },
      [target(["baseline:rules"])],
    );

    writeRegistrationLedgerAtomic(home, ledger);

    const path = registrationLedgerPath(home);
    expect(readRegistrationLedger(home)).toEqual(ledger);
    expect(readFileSync(path, "utf8")).toBe(serializeRegistrationLedger(ledger));
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o077).toBe(0);
  });

  it("keeps the primary registration readable after a project is deleted", () => {
    const ledger = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      { root: projectA, scope: "scoped", components: ["baseline:rules"], mcps: [] },
      [target(["baseline:rules"])],
    );
    writeRegistrationLedgerAtomic(home, ledger);
    rmSync(projectA, { recursive: true, force: true });

    expect(readRegistrationLedger(home)).toEqual(ledger);
  });

  it("preserves the previous valid ledger when final rename fails", () => {
    const original = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      { root: projectA, scope: "scoped", components: ["baseline:rules"], mcps: [] },
      [target(["baseline:rules"])],
    );
    writeRegistrationLedgerAtomic(home, original);
    const before = readFileSync(registrationLedgerPath(home), "utf8");
    const next = mergeRegistrationLedger(
      original,
      { root: projectB, scope: "scoped", components: ["lang:cpp"], mcps: [] },
      [target(["baseline:rules", "lang:cpp"])],
    );

    expect(() =>
      writeRegistrationLedgerAtomic(home, next, {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    ).toThrow(/injected rename failure/);
    expect(readFileSync(registrationLedgerPath(home), "utf8")).toBe(before);
  });

  it("refuses symlinked ledger parents and ledger files", () => {
    const ledger = emptyRegistrationLedger();
    const outside = mkdtempSync(join(tmpdir(), "aih-ecc-ledger-outside-"));
    try {
      try {
        symlinkSync(outside, join(home, ".aih"), process.platform === "win32" ? "junction" : "dir");
      } catch {
        return;
      }
      expect(() => writeRegistrationLedgerAtomic(home, ledger)).toThrow(/symlink/i);
      rmSync(join(home, ".aih"), { force: true });
      mkdirSync(join(home, ".aih", "ecc"), { recursive: true });
      writeFileSync(join(outside, "ledger.json"), "outside", "utf8");
      symlinkSync(join(outside, "ledger.json"), registrationLedgerPath(home), "file");
      expect(() => writeRegistrationLedgerAtomic(home, ledger)).toThrow(/symlink/i);
      expect(readFileSync(join(outside, "ledger.json"), "utf8")).toBe("outside");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
