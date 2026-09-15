import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CiImpactReceipt, classifyCiImpact } from "./ci-impact.js";
import { localVerificationGaps, localVerificationSteps } from "./ci-local-verification.js";
import { defaultRunner, type Runner } from "./proc.js";

const USAGE = "npm run verify:local -- --base <ref> --head <ref> [--include-working] [--plan]";
const SHA = /^[0-9a-f]{40}$/u;

interface LocalVerificationOptions {
  cwd?: string;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  write?: (text: string) => void;
}

function parseArgs(args: readonly string[]) {
  let base: string | undefined;
  let head: string | undefined;
  let includeWorking = false;
  let planOnly = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || seen.has(arg)) throw new Error(`Invalid or repeated option. Usage: ${USAGE}`);
    seen.add(arg);
    if (arg === "--include-working") includeWorking = true;
    else if (arg === "--plan") planOnly = true;
    else if (arg === "--base" || arg === "--head") {
      const ref = args[++index];
      if (!ref || ref.startsWith("-") || /[\0\r\n]/u.test(ref))
        throw new Error(`Invalid Git ref. Usage: ${USAGE}`);
      if (arg === "--base") base = ref;
      else head = ref;
    } else throw new Error(`Unknown option. Usage: ${USAGE}`);
  }
  if (!base || !head) throw new Error(`Usage: ${USAGE}`);
  return { base, head, includeWorking, planOnly };
}

export async function runLocalVerification(
  args: readonly string[],
  options: LocalVerificationOptions = {},
): Promise<CiImpactReceipt> {
  const { base, head, includeWorking, planOnly } = parseArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? defaultRunner;
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  async function git(args: string[]): Promise<string> {
    const result = await run(["git", ...args], { cwd, env });
    if (result.code !== 0 || result.spawnError || result.truncated)
      throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result.stdout;
  }
  async function commit(ref: string): Promise<string> {
    const sha = (
      await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    ).trim();
    if (!SHA.test(sha)) throw new Error("Git did not resolve a commit SHA");
    return sha;
  }
  const [baseSha, headSha, checkoutSha] = await Promise.all([
    commit(base),
    commit(head),
    commit("HEAD"),
  ]);
  if (checkoutSha !== headSha)
    throw new Error("The checkout HEAD must match --head before local verification");

  const [committed, unstaged, staged, untracked, tests] = await Promise.all([
    git(["diff", "--name-only", "--no-renames", "-z", `${baseSha}...${headSha}`, "--"]),
    git(["diff", "--name-only", "--no-renames", "-z", "--"]),
    git(["diff", "--cached", "--name-only", "--no-renames", "-z", "--"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
    // The cached list includes deleted files; --deleted identifies those separately below.
    git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "tests"]),
  ]);
  const paths = (raw: string): string[] => raw.split("\0").filter(Boolean);
  const workingPaths = [...new Set([...paths(unstaged), ...paths(staged), ...paths(untracked)])];
  if (workingPaths.length > 0 && !includeWorking)
    throw new Error(
      "Working changes are present; use --include-working to include them explicitly",
    );
  const deletedTests = new Set(paths(await git(["ls-files", "--deleted", "-z", "--", "tests"])));
  const changedPaths = [...paths(committed), ...(includeWorking ? workingPaths : [])];
  const receipt = classifyCiImpact(
    {
      baseSha,
      headSha,
      changedPaths,
      testFiles: paths(tests).filter(
        (path) => path.endsWith(".test.ts") && !deletedTests.has(path),
      ),
    },
    { allowIdenticalRevisions: includeWorking && workingPaths.length > 0 },
  );
  write(`Local verification: ${baseSha}...${headSha}\n`);
  write(
    `Working changes: ${includeWorking ? `${workingPaths.length} paths included` : "excluded (clean checkout)"}\n`,
  );
  write(
    `Selection: ${receipt.riskClass}; lane=${receipt.testLane}; ${receipt.selectedTests.length} tests\n`,
  );
  write(`Reasons: ${receipt.matchedRules.join(", ") || "none"}\n`);
  if (receipt.fallbackReasons.length > 0)
    write(`Full fallback: ${receipt.fallbackReasons.join(", ")}\n`);
  write(`Changed paths:\n${receipt.changedPaths.map((path) => `  ${path}`).join("\n")}\n`);
  for (const gap of localVerificationGaps(receipt, options.platform ?? process.platform))
    write(`Hosted gap: ${gap}\n`);
  const steps = localVerificationSteps(receipt);
  for (const step of steps)
    write(
      `Selected command: npm run ${step.script}${step.args.length ? ` -- ${step.args.join(" ")}` : ""}\n`,
    );
  if (planOnly) {
    write("Plan only; no verification commands ran.\n");
    return receipt;
  }
  const npmCli = env.npm_execpath;
  if (!npmCli) throw new Error(`Run through npm to resolve its cross-platform launcher: ${USAGE}`);
  for (const step of steps) {
    write(`Running npm run ${step.script}\n`);
    const result = await run(
      [
        process.execPath,
        npmCli,
        "run",
        step.script,
        ...(step.args.length ? ["--", ...step.args] : []),
      ],
      { cwd, env: { ...env, ...step.env }, timeoutMs: 7_200_000 },
    );
    write(result.stdout);
    write(result.stderr);
    if (result.code !== 0 || result.spawnError || result.truncated)
      throw new Error(
        `Local verification failed: ${step.script} (exit ${result.code ?? "unknown"})`,
      );
  }
  write("Local selected verification passed; the hosted gaps above remain.\n");
  return receipt;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runLocalVerification(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
