import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CiImpactReceipt, classifyCiImpact } from "./ci-impact.js";
import { defaultRunner, type Runner } from "./proc.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function checkedGit(args: string[], run: Runner, cwd: string): Promise<string> {
  const result = await run(["git", ...args], { cwd });
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

export interface CiImpactCommandOptions {
  cwd?: string;
  githubOutput?: string;
  run?: Runner;
  writeStdout?: (value: string) => void;
}

export async function runCiImpactCommand(
  args: readonly string[],
  options: CiImpactCommandOptions = {},
): Promise<CiImpactReceipt> {
  const baseSha = option(args, "--base");
  const headSha = option(args, "--head");
  const output = option(args, "--output") ?? "ci-impact.json";
  if (!baseSha || !headSha) throw new Error("usage: --base <sha> --head <sha> [--output <path>]");

  const run = options.run ?? defaultRunner;
  const cwd = options.cwd ?? process.cwd();
  const [changedRaw, testsRaw] = await Promise.all([
    checkedGit(["diff", "--name-only", "-z", `${baseSha}...${headSha}`], run, cwd),
    checkedGit(["ls-files", "-z", "--", "tests"], run, cwd),
  ]);
  const receipt = classifyCiImpact({
    baseSha,
    headSha,
    changedPaths: changedRaw.split("\0").filter(Boolean),
    testFiles: testsRaw.split("\0").filter((path) => path.endsWith(".test.ts")),
  });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  (options.writeStdout ?? ((value) => process.stdout.write(value)))(
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  const githubOutput = options.githubOutput ?? process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `full_suite=${String(receipt.fullSuite)}`,
        `risk_class=${receipt.riskClass}`,
        `test_lane=${receipt.testLane}`,
        `release_preparation=${String(receipt.releasePreparation)}`,
        `selected_tests_json=${JSON.stringify(receipt.selectedTests)}`,
        `operating_systems_json=${JSON.stringify(receipt.operatingSystems)}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return receipt;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runCiImpactCommand(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
