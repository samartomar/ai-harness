import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Workbench retirement contract (greenfield).
 *
 * The browser/HTML/server Workbench is removed outright: `aih --ui` is no
 * longer a registered option and every `aih policy generate` form, including
 * the legacy `[admin-root]` shape, is no longer a registered command. The CLI
 * must reject those inputs through its normal unknown-option/unknown-command
 * paths with a nonzero exit code. There are no `AIH_RETIRED` compatibility
 * stubs, no browser launch, and no server. `src/org-policy/ui-server.ts` is
 * absent; the `--ui` case still guards against that source reappearing before
 * it executes the CLI, so a surprise Workbench server can never be launched
 * from this test.
 *
 * Every child runs `node --import tsx <absolute src/cli.ts>` with a temporary
 * fixture as cwd plus an isolated HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG
 * environment, so the checkout is never the CLI target. Inherited `AIH_*`
 * operator routing variables are dropped, and each child is bounded by a
 * child timeout and a Vitest timeout. A stable fixture snapshot around every
 * retired invocation shows it writes no files, while the absence of loopback
 * URLs, listening-server, and browser markers is a supplemental diagnostic,
 * not process-level proof that no server or browser was started.
 *
 * Retained backend policy validation is covered separately. Ownership and CLI
 * registration of `policy data prepare/sign/import` are pending and are
 * deliberately not asserted here; the scoped preassembly artifact is checked
 * only as a non-browser backend artifact. This Vitest run is NOT
 * packaged-install evidence: it exercises TypeScript sources from the
 * checkout, not an installed artifact.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");
const TSX_LOADER_URL = import.meta.resolve("tsx");
const UI_SERVER_SOURCE = path.join(REPO_ROOT, "src", "org-policy", "ui-server.ts");
const CHILD_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 90_000;

/**
 * Browser/UI Workbench paths removed by the retirement. Backend Workbench
 * artifacts are deliberately absent from this denylist: the policy schema,
 * preassembly and qualification modules, and the generated backend
 * preassembly bundle are not browser/UI code.
 */
const RETIRED_UI_PATHS = [
  "src/org-policy/ui-server.ts",
  "src/org-policy/studio-template.ts",
  "src/org-policy/studio-model.ts",
  "src/org-policy/studio-artifact-intake.ts",
  "src/org-policy/workbench/browser-script.ts",
  "src/org-policy/workbench/ui",
  "src/org-policy/workbench/ui/main.ts",
  "src/org-policy/workbench/bundle.generated.cjs",
  "dist/bundle.generated.cjs",
  "tools/build-workbench.mjs",
];

const PREASSEMBLY_FILE_NAME = "default-catalog-preassembly.generated.cjs";

type Env = Record<string, string | undefined>;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  env: Env;
  snapshot(): string[];
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    removeFixtureRoot(root);
  }
});

function createFixture(label: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aih-retire-${label}-`));
  fixtureRoots.push(root);
  const home = path.join(root, "home");
  for (const directory of [
    home,
    path.join(home, "AppData", "Roaming"),
    path.join(home, "AppData", "Local"),
    path.join(home, ".config"),
    path.join(home, ".cache"),
    path.join(home, ".local", "share"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return { root, env: isolatedEnv(home), snapshot: () => snapshotTree(root) };
}

function isolatedEnv(home: string): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "AIH" || key.startsWith("AIH_")) {
      continue;
    }
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  const parsed = path.parse(home);
  env.HOMEDRIVE = parsed.root;
  env.HOMEPATH = home.slice(parsed.root.length);
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  // tsx honors this when it uses a disk cache and ignores it otherwise.
  env.TSX_DISABLE_CACHE = "true";
  return env;
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        entries.push(`${relative} -> symlink`);
        continue;
      }
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(path.join(directory, entry.name), relative);
        continue;
      }
      entries.push(relative);
    }
  };
  walk(root, "");
  return entries.sort();
}

function removeFixtureRoot(root: string): void {
  fs.rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
}

function runAih(args: string[], cwd: string, env: Env): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const childArgs = ["--import", TSX_LOADER_URL, CLI_ENTRY, ...args];
    const child = spawn(process.execPath, childArgs, {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGKILL");
      const message = [
        `aih ${args.join(" ")} timed out after ${CHILD_TIMEOUT_MS}ms`,
        `stdout: ${stdout}`,
        `stderr: ${stderr}`,
      ].join("\n");
      reject(new Error(message));
    }, CHILD_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runInFixture(fixture: Fixture, args: string[]): Promise<CliResult> {
  return runAih(args, fixture.root, fixture.env);
}

function outputOf(result: CliResult): string {
  return `${result.stdout}${result.stderr}`;
}

/**
 * First normal-CLI retirement-contract violation in the output, if any.
 * A retired entry point must fail as unknown input, never as an AIH_RETIRED
 * compatibility stub, and must not advertise a loopback server, a listening
 * server, or a browser launch.
 */
function unknownCliInputViolation(result: CliResult, input: string): string | undefined {
  const output = outputOf(result);
  if (result.code === 0) {
    return `expected a nonzero exit code, received ${String(result.code)}`;
  }
  if (result.code === null) {
    return "expected a normal CLI error exit, received a signal exit";
  }
  if (output.includes("AIH_RETIRED")) {
    return "unexpected AIH_RETIRED compatibility stub";
  }
  if (!output.includes(input)) {
    return `CLI error output does not mention ${input}`;
  }
  if (!/unknown|unrecognized|unexpected|invalid/i.test(output)) {
    return "missing a normal unknown-option/unknown-command CLI error";
  }
  if (/https?:\/\/(?:127\.0\.0\.1|localhost)/i.test(output)) {
    return "output advertises a loopback server URL";
  }
  if (/\blistening\b|\bserver\b.*\b(started|running)\b/i.test(output)) {
    return "output reports a running server";
  }
  if (/\bbrowser\b/i.test(output)) {
    return "output mentions a browser";
  }
  return undefined;
}

describe("Workbench retirement topology", () => {
  it("removes the browser Workbench source paths", () => {
    expect(fs.existsSync(CLI_ENTRY), "src/cli.ts is missing").toBe(true);
    for (const relativePath of RETIRED_UI_PATHS) {
      const absolutePath = path.join(REPO_ROOT, relativePath);
      expect(
        fs.existsSync(absolutePath),
        `retired Workbench path still exists: ${relativePath}`,
      ).toBe(false);
    }
  });

  it("drops the browser Workbench builder from build/test scripts", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    const relevant: [string, string][] = [];
    for (const [name, command] of Object.entries(scripts)) {
      if (name === "build" || name.startsWith("test")) {
        relevant.push([name, command]);
      }
    }
    expect(relevant.length, "no build/test scripts found").toBeGreaterThan(0);
    for (const [name, command] of relevant) {
      expect(command, `script ${name} still invokes the browser Workbench builder`).not.toMatch(
        /build:workbench|build-workbench\.mjs/,
      );
    }
  });

  it("removes the Core-owned backend preassembly artifact", () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, "src", "org-policy", "workbench", PREASSEMBLY_FILE_NAME)),
      `retired Core preassembly ${PREASSEMBLY_FILE_NAME} still exists`,
    ).toBe(false);
  });
});

describe("retired Workbench CLI registrations", () => {
  it(
    "rejects aih --ui as an unknown option without server, browser, or writes",
    async () => {
      if (fs.existsSync(UI_SERVER_SOURCE)) {
        throw new Error("refusing to execute aih --ui: src/org-policy/ui-server.ts reappeared");
      }
      const fixture = createFixture("ui-unknown-option");
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, ["--ui"]);
      expect(unknownCliInputViolation(result, "--ui"), outputOf(result)).toBeUndefined();
      expect(fixture.snapshot(), "aih --ui wrote into the fixture").toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects rootless policy generate as an unknown command without writes",
    async () => {
      const fixture = createFixture("generate-unknown");
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, ["policy", "generate"]);
      expect(unknownCliInputViolation(result, "generate"), outputOf(result)).toBeUndefined();
      expect(fixture.snapshot(), "policy generate wrote into the fixture").toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects policy generate --apply as an unknown command without --out writes",
    async () => {
      const fixture = createFixture("generate-apply");
      const outPath = path.join(fixture.root, "generated-policy.json");
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, [
        "policy",
        "generate",
        "--apply",
        "--out",
        outPath,
      ]);
      expect(unknownCliInputViolation(result, "generate"), outputOf(result)).toBeUndefined();
      expect(fs.existsSync(outPath), "policy generate --apply created --out").toBe(false);
      expect(fixture.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects the legacy policy generate [admin-root] form as an unknown command",
    async () => {
      const fixture = createFixture("generate-admin-root");
      const adminRoot = path.join(fixture.root, "admin-root");
      fs.mkdirSync(adminRoot, { recursive: true });
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, ["policy", "generate", adminRoot]);
      expect(unknownCliInputViolation(result, "generate"), outputOf(result)).toBeUndefined();
      expect(fixture.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects legacy policy generate [admin-root] --apply without writes",
    async () => {
      const fixture = createFixture("generate-admin-apply");
      const adminRoot = path.join(fixture.root, "admin-root");
      const outPath = path.join(fixture.root, "admin-policy.json");
      fs.mkdirSync(adminRoot, { recursive: true });
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, [
        "policy",
        "generate",
        adminRoot,
        "--apply",
        "--out",
        outPath,
      ]);
      expect(unknownCliInputViolation(result, "generate"), outputOf(result)).toBeUndefined();
      expect(fs.existsSync(outPath), "legacy policy generate --apply created --out").toBe(false);
      expect(fixture.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("retained backend policy validation", () => {
  it(
    "accepts a minimal valid schema-v2 policy",
    async () => {
      const fixture = createFixture("validate-valid");
      const policyPath = path.join(fixture.root, "aih-org-policy.json");
      const policy = {
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
      };
      fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, ["policy", "validate"]);
      expect(result.code, outputOf(result)).toBe(0);
      expect(fixture.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects an invalid policy with the org-policy.invalid code",
    async () => {
      const fixture = createFixture("validate-invalid");
      const policyPath = path.join(fixture.root, "aih-org-policy.json");
      const policy = {
        schemaVersion: 2,
        minimumPosture: "wild",
        references: { repoContract: "ai-coding/project.json" },
      };
      fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
      const before = fixture.snapshot();
      const result = await runInFixture(fixture, ["policy", "validate"]);
      expect(result.code).not.toBe(0);
      expect(outputOf(result)).toMatch(/org policy schema.*org-policy is invalid/s);
      expect(fixture.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});
