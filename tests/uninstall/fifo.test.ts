import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-uninstall-fifo-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function context(apply: boolean): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

it.skipIf(process.platform === "win32")(
  "uninstall classifies a FIFO projection as non-regular and removes the ownership marker",
  async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [] }),
    );
    put(".claude/managed-settings.json", JSON.stringify({ operatorOnly: true }));
    put(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    const projectContext = context(true);
    projectContext.targets = ["claude"];
    await executePlan(await policyProjectCommand.plan(projectContext), projectContext);
    const managedPath = join(root, ".claude", "managed-settings.json");
    rmSync(managedPath);
    execFileSync("mkfifo", [managedPath]);

    const uninstallContext = context(true);
    const result = await executePlan(
      await uninstallCommand.plan(uninstallContext),
      uninstallContext,
    );
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );

    expect(digest?.text).toContain("not a readable regular file");
    expect(result.writes.map((write) => write.path)).not.toContain(".claude/managed-settings.json");
    expect(existsSync(managedPath)).toBe(true);
    expect(existsSync(join(root, ".aih-config.json"))).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "the trust-lock reader used by co-owned uninstall refuses a FIFO promptly",
  () => {
    put(".aih/.keep", "");
    const lockPath = join(root, ".aih", "trust-lock.json");
    const child = join(root, "read-trust-lock.mjs");
    execFileSync("mkfifo", [lockPath]);
    writeFileSync(
      child,
      [
        "const { readTrustLock, trustLockValidationFindings } = await import(process.argv[2]);",
        "const root = process.argv[3];",
        "if (readTrustLock(root).sources.length !== 0) process.exit(2);",
        "const findings = trustLockValidationFindings(root);",
        "if (findings.length !== 1) process.exit(3);",
        "if (!findings[0]?.detail?.includes('not a readable regular file')) process.exit(4);",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        child,
        pathToFileURL(join(process.cwd(), "src", "trust", "lock.ts")).href,
        root,
      ],
      { encoding: "utf8", timeout: 3_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
  10_000,
);
