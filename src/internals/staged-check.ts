import { isAbsolute } from "node:path";
import { type CiImpactReceipt, classifyCiImpact } from "./ci-impact.js";
import { defaultRunner, type Runner } from "./proc.js";

export interface StagedCheckInput {
  baseSha: string;
  headSha: string;
  stagedPaths: readonly string[];
  testFiles: readonly string[];
}

export interface StagedCheckResult {
  code: number;
  receipt: CiImpactReceipt;
  commands: string[][];
  failure?: string;
}

export interface StagedCheckToolchain {
  nodeExecutable: string;
  npmCli: string;
}

const BOUNDED_FALLBACK_TESTS = [
  "tests/package-identity.test.ts",
  "tests/release-readiness.test.ts",
  "tests/release/preflight.test.ts",
];

function isBiomePath(path: string): boolean {
  return (
    (path.startsWith("src/") || path.startsWith("tests/")) &&
    /\.(?:c?js|mjs|json|tsx?)$/u.test(path)
  );
}

function currentToolchain(): StagedCheckToolchain {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== "string" || !isAbsolute(npmCli)) {
    throw new Error("staged checks require an absolute npm CLI supplied by npm_execpath");
  }
  return { nodeExecutable: process.execPath, npmCli };
}

function npmRun(toolchain: StagedCheckToolchain, ...args: string[]): string[] {
  return [toolchain.nodeExecutable, toolchain.npmCli, "run", ...args];
}

function npmExec(toolchain: StagedCheckToolchain, ...args: string[]): string[] {
  return [toolchain.nodeExecutable, toolchain.npmCli, "exec", "--no", "--", ...args];
}

// Selected integration files can exceed two minutes while individual tests remain bounded.
// Allow their process to finish without extending lint or artifact-check deadlines.
function commandTimeoutMs(argv: readonly string[]): number {
  return argv[2] === "exec" &&
    argv[3] === "--no" &&
    argv[4] === "--" &&
    argv[5] === "vitest" &&
    argv[6] === "run"
    ? 300_000
    : 120_000;
}

function planCommands(
  input: StagedCheckInput,
  receipt: CiImpactReceipt,
  toolchain: StagedCheckToolchain,
): string[][] {
  const commands: string[][] = [npmRun(toolchain, "--silent", "check:artifacts")];
  const biomePaths = [...new Set(input.stagedPaths.filter(isBiomePath))].sort();
  if (biomePaths.length > 0) {
    commands.push(npmExec(toolchain, "biome", "check", ...biomePaths));
  }
  if (receipt.riskClass === "docs" || input.stagedPaths.some((path) => path.endsWith(".md"))) {
    commands.push(npmRun(toolchain, "--silent", "docs:lint"));
  }

  const available = new Set(input.testFiles);
  const tests = receipt.fullSuite
    ? BOUNDED_FALLBACK_TESTS.filter((path) => available.has(path))
    : receipt.selectedTests;
  if (tests.length > 0) {
    commands.push(npmExec(toolchain, "vitest", "run", ...tests));
  }
  return commands;
}

export async function runStagedChecks(
  input: StagedCheckInput,
  run: Runner = defaultRunner,
  toolchain: StagedCheckToolchain = currentToolchain(),
): Promise<StagedCheckResult> {
  const receipt = classifyCiImpact({
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths: input.stagedPaths,
    testFiles: input.testFiles,
  });
  const commands = planCommands(input, receipt, toolchain);
  for (const argv of commands) {
    const result = await run(argv, { cwd: process.cwd(), timeoutMs: commandTimeoutMs(argv) });
    if (result.code !== 0 || result.spawnError || result.truncated) {
      return {
        code: result.code && result.code > 0 ? result.code : 1,
        receipt,
        commands,
        failure: result.stderr.trim() || result.stdout.trim() || `${argv[0]} failed`,
      };
    }
  }
  return { code: 0, receipt, commands };
}

async function gitOutput(argv: string[], run: Runner): Promise<string> {
  const result = await run(["git", ...argv], { cwd: process.cwd() });
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error(result.stderr.trim() || `git ${argv[0] ?? "command"} failed`);
  }
  return result.stdout;
}

async function main(run: Runner = defaultRunner): Promise<number> {
  const stagedRaw = await gitOutput(["diff", "--cached", "--name-only", "-z"], run);
  const stagedPaths = stagedRaw.split("\0").filter(Boolean);
  if (stagedPaths.length === 0) {
    process.stdout.write("[ai-harness] staged checks: no staged paths\n");
    return 0;
  }
  const [baseSha, headSha, testsRaw] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"], run),
    gitOutput(["write-tree"], run),
    gitOutput(["ls-files", "-z", "--", "tests"], run),
  ]);
  const testFiles = testsRaw.split("\0").filter((path) => path.endsWith(".test.ts"));
  const result = await runStagedChecks(
    {
      baseSha: baseSha.trim(),
      headSha: headSha.trim(),
      stagedPaths,
      testFiles,
    },
    run,
  );
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  if (result.failure) process.stderr.write(`${result.failure}\n`);
  return result.code;
}

const invokedDirectly = process.argv[1]?.replace(/\\/gu, "/").endsWith("staged-check.ts");
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
