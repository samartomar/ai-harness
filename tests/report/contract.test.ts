import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectContract } from "../../src/contract/schema.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { reportAdvisories } from "../../src/report/advisories.js";
import { contractSnapshot, contractTruthDigest } from "../../src/report/contract.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-rpt-contract-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner((argv) => {
    if (argv.includes("ls-files")) {
      return { stdout: Array.from({ length: 42 }, (_, i) => `src/file-${i}.ts`).join("\n") };
    }
    return undefined;
  });
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

const BASE: ProjectContract = {
  schemaVersion: 1,
  contextDir: "ai-coding",
  targets: [],
  languages: ["TypeScript/Node.js"],
  frameworks: [],
  cloud: [],
  databases: [],
  deployment: [],
  entrypoints: [],
  commands: {
    test: { value: "npm test", confidence: "detected" },
    lint: { value: "npx biome check .", confidence: "inferred" },
  },
  scale: { trackedFiles: 42, class: "small", isMonorepo: false },
  sensitivePaths: [".env"],
  knownGaps: ["unconfirmed `npx biome check .` (lint inferred, not declared) — verify it runs"],
};

function writeContract(c: ProjectContract): void {
  mkdirSync(join(dir, "ai-coding"), { recursive: true });
  writeFileSync(join(dir, "ai-coding", "project.json"), `${JSON.stringify(c, null, 2)}\n`);
}

function writePackage(extraScripts: Record<string, string> = {}): void {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "lib",
      scripts: { test: "vitest run", ...extraScripts },
      devDependencies: { "@biomejs/biome": "^2", typescript: "^5", vitest: "^1" },
    })}\n`,
  );
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(join(dir, ".env"), "SECRET=do-not-read\n");
}

describe("report contract-truth panel (2A)", () => {
  it("is omitted when no contract is committed (no fabricated panel)", async () => {
    expect(await contractTruthDigest(ctx())).toEqual([]);
    expect(contractSnapshot(ctx())).toBeUndefined();
  });

  it("surfaces the committed contract's facts + portable-path status", async () => {
    writePackage();
    writeContract(BASE);
    const [d] = await contractTruthDigest(ctx());
    expect(d).toBeDefined();
    expect(d?.describe).toContain("Repo contract");
    expect(d?.text).toContain("TypeScript/Node.js");
    expect(d?.text).toContain("2 (1 detected, 1 inferred)");
    expect(d?.text).toContain("ok"); // portable paths
    const data = d?.data as { knownGaps?: number; unportable?: number };
    expect(data?.knownGaps).toBe(1);
    expect(data?.unportable).toBe(0);
  });

  it("flags a non-portable path in both the digest and the snapshot", async () => {
    writePackage();
    writeContract({ ...BASE, entrypoints: ["../escape"] });
    const [d] = await contractTruthDigest(ctx());
    expect(d?.describe).toContain("paths NOT portable");
    expect(d?.text).toContain("NON-PORTABLE");
    expect(contractSnapshot(ctx())?.unportable).toBe(1);
  });

  it("surfaces stale contract fields with the regeneration fix", async () => {
    writePackage({ build: "tsc -p ." });
    writeContract(BASE);

    const [d] = await contractTruthDigest(ctx());

    expect(d?.describe).toContain("contract stale");
    expect(d?.text).toContain("contract drifted from the live repo");
    expect(d?.text).toContain("commands.build");
    expect(d?.text).toContain("re-run `aih contract");
    expect((d?.data as { staleFields?: string[] } | undefined)?.staleFields).toContain(
      "commands.build",
    );
  });
});

describe("report contract advisory (report.contract-untrue)", () => {
  const find = (gate: boolean, unportable: number) =>
    reportAdvisories({ contract: { unportable, knownGaps: 0 }, gate, initialized: true }).find(
      (c) => c.code === "report.contract-untrue",
    );

  it("does not fire on a clean contract", () => {
    expect(find(false, 0)).toBeUndefined();
  });

  it("is a non-gating skip advisory without --gate", () => {
    expect(find(false, 1)?.verdict).toBe("skip");
  });

  it("flips to a gating fail under --gate", () => {
    expect(find(true, 1)?.verdict).toBe("fail");
  });
});
