import { appendFileSync, writeFileSync } from "node:fs";
import { classifyCiImpact } from "./ci-impact.js";
import { defaultRunner } from "./proc.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function checkedGit(args: string[]): Promise<string> {
  const result = await defaultRunner(["git", ...args], { cwd: process.cwd() });
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

async function main(): Promise<void> {
  const baseSha = option("--base");
  const headSha = option("--head");
  const output = option("--output") ?? "ci-impact.json";
  if (!baseSha || !headSha) throw new Error("usage: --base <sha> --head <sha> [--output <path>]");

  const [changedRaw, testsRaw] = await Promise.all([
    checkedGit(["diff", "--name-only", "-z", `${baseSha}...${headSha}`]),
    checkedGit(["ls-files", "-z", "--", "tests"]),
  ]);
  const receipt = classifyCiImpact({
    baseSha,
    headSha,
    changedPaths: changedRaw.split("\0").filter(Boolean),
    testFiles: testsRaw.split("\0").filter((path) => path.endsWith(".test.ts")),
  });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `full_suite=${String(receipt.fullSuite)}`,
        `risk_class=${receipt.riskClass}`,
        `release_preparation=${String(receipt.releasePreparation)}`,
        `selected_tests_json=${JSON.stringify(receipt.selectedTests)}`,
        `operating_systems_json=${JSON.stringify(receipt.operatingSystems)}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
