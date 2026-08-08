import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
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
        schemaVersion: 2,
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
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: ".claude", targets: ["claude"] }),
    );
    put(".claude/adapters/_shared-canonical-block.md", sharedCanonicalBlockBody(".claude"));
    put(".claude/RULE_ROUTER.md", "# Generated router\n");
    put(".claude/rules/agent-behavior-core.md", "# Generated behavior core\n");
    put(".aih/.keep", "");
    const lockPath = join(root, ".aih", "trust-lock.json");
    const child = join(root, "read-trust-lock.mjs");
    execFileSync("mkfifo", [lockPath]);
    writeFileSync(
      child,
      [
        "const { command } = await import(process.argv[2]);",
        "const { fakeRunner } = await import(process.argv[3]);",
        "const { makeHostAdapter } = await import(process.argv[4]);",
        "const root = process.argv[5];",
        "const run = fakeRunner(() => undefined);",
        "const ctx = { root, contextDir: '.claude', apply: false, verify: false, json: false, run, host: makeHostAdapter({ platform: 'linux', run, env: {} }), env: {}, options: {} };",
        "await command.plan(ctx);",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        child,
        pathToFileURL(join(process.cwd(), "src", "uninstall", "index.ts")).href,
        pathToFileURL(join(process.cwd(), "src", "internals", "proc.ts")).href,
        pathToFileURL(join(process.cwd(), "src", "platform", "detect.ts")).href,
        root,
      ],
      { encoding: "utf8", timeout: 3_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
  10_000,
);

it("plans a large promoted-source inventory within a bounded child process", () => {
  const promotedSkills = Array.from({ length: 5_000 }, (_, index) => `skill-${index}`);
  put(
    ".aih-config.json",
    JSON.stringify({ schemaVersion: 1, contextDir: ".claude", targets: ["claude"] }),
  );
  put(".claude/adapters/_shared-canonical-block.md", sharedCanonicalBlockBody(".claude"));
  put(".claude/RULE_ROUTER.md", "# Generated router\n");
  put(".claude/rules/agent-behavior-core.md", "# Generated behavior core\n");
  put(
    ".aih/trust-lock.json",
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        {
          id: "large-source",
          kind: "local",
          source: "../large-source",
          promotedAt: "2026-08-01T00:00:00.000Z",
          promotedSkills,
          analyzersRun: ["semgrep"],
          artifactHashes: promotedSkills.map((skill) => ({
            path: `${skill}/SKILL.md`,
            sha256: "0".repeat(64),
          })),
          findings: [],
        },
      ],
    }),
  );
  const child = join(root, "large-trust-lock.mjs");
  writeFileSync(
    child,
    [
      "const { command } = await import(process.argv[2]);",
      "const { fakeRunner } = await import(process.argv[3]);",
      "const { makeHostAdapter } = await import(process.argv[4]);",
      "const root = process.argv[5];",
      "const run = fakeRunner(() => undefined);",
      "const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';",
      "const ctx = { root, contextDir: '.claude', apply: false, verify: false, json: false, run, host: makeHostAdapter({ platform, run, env: {} }), env: {}, options: {} };",
      "await command.plan(ctx);",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      child,
      pathToFileURL(join(process.cwd(), "src", "uninstall", "index.ts")).href,
      pathToFileURL(join(process.cwd(), "src", "internals", "proc.ts")).href,
      pathToFileURL(join(process.cwd(), "src", "platform", "detect.ts")).href,
      root,
    ],
    { encoding: "utf8", timeout: 6_000 },
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 15_000);
