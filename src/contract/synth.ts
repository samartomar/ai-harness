import { classifyCanon, isAdoptable } from "../adopt/classify.js";
import { cliFootprint } from "../adopt/cli-footprint.js";
import { readAihConfig } from "../config/marker.js";
import type { PlanContext } from "../internals/plan.js";
import { gitCommittedSet } from "../internals/scan-allowlist.js";
import type { RepoStack } from "../profile/scan.js";
import { LARGE_REPO_FILE_THRESHOLD, trackedFileCount } from "../scale-safety.js";
import { scanSecrets } from "../secrets/scan.js";
import type { Confidence, ProjectContract, ScaleClass } from "./schema.js";

/** Below this tracked-file count a repo is `small`; up to {@link LARGE_REPO_FILE_THRESHOLD} it is `medium`. */
const SMALL_REPO_FILE_CEILING = 100;

/** The canonical command shape carried per slot in the contract. */
type ContractCommand = { value: string; confidence: Confidence };

/**
 * Tier grader for `test`/`lint`. The tier is LATENT in scanRepo's derivers:
 * `deriveTest`/`deriveLint` return the `npm …` script form ONLY when the repo declares
 * that script (and `deriveTest` already filters placeholder `echo` scripts), so the
 * script form is the lone `detected` signal; a dependency, a linter config file, or a
 * language default all surface as `inferred`. Reading the value back rather than
 * re-deriving means the contract inherits that placeholder filtering for free.
 * (`verified` — running the command — is Phase 2 / 2E; Phase 1 never spawns one.)
 */
function toCommand(value: string | undefined, detectedForm: string): ContractCommand | undefined {
  if (value === undefined) return undefined;
  return { value, confidence: value === detectedForm ? "detected" : "inferred" };
}

/**
 * STRICT grader for `build`/`start`: emit ONLY a DECLARED npm script (`detected`),
 * else OMIT. A language-derived build (`go build ./...`, `./gradlew build`, `dotnet
 * build`, …) is deliberately NOT emitted in Phase 1 — it is undeclared, and rendered
 * into `project.md`/`setup.md` it reads as an INVENTED command (a weak model won't bind
 * it to a separate `knownGaps` caveat), weakening the contract's "don't invent
 * commands" promise. The Phase-2 `verified` tier runs the candidate and promotes a real
 * one. This is the stakes-based asymmetry vs {@link toCommand}: a suggested test/lint is
 * low-harm; a suggested build/start is not. (`scanRepo` derives no `start` default
 * anyway, so `start` is already declared-or-omit.)
 */
function toDeclaredCommand(
  value: string | undefined,
  detectedForm: string,
): ContractCommand | undefined {
  return value === detectedForm ? { value, confidence: "detected" } : undefined;
}

/** Pure size bucket over the tracked-file count, with a monorepo floor. */
function scaleClass(trackedFiles: number | undefined, isMonorepo: boolean): ScaleClass {
  if (trackedFiles === undefined) return "unknown";
  let cls: ScaleClass =
    trackedFiles < SMALL_REPO_FILE_CEILING
      ? "small"
      : trackedFiles < LARGE_REPO_FILE_THRESHOLD
        ? "medium"
        : "large";
  // A workspace/monorepo is multi-package by construction — never present it as a
  // single-command `small` repo even when its tracked count happens to be low.
  if (isMonorepo && cls === "small") cls = "medium";
  return cls;
}

/** `n thing` / `n things` — small pluralizer for gap text (no magic singular checks inline). */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Honest gaps the next agent should close, in a fixed (deterministic) order:
 *  1. a brownfield AI canon that must be reconciled, not regenerated over;
 *  2. committed CLI-native rule sets aih hasn't imported;
 *  3. legacy canon scripts superseded by the generator;
 *  4. commands we could only INFER (no declared script) — confirm they run.
 */
function deriveKnownGaps(
  root: string,
  contextDir: string,
  committed: ReadonlySet<string> | undefined,
  commands: Record<string, ContractCommand | undefined>,
  browserTest: boolean,
): string[] {
  const gaps: string[] = [];

  // The one real agent-trap: a browser test runner (Karma's `ng test`, Cypress) launches a
  // real browser and HANGS headless-less — the move most likely to fail the next agent.
  if (browserTest && commands.test) {
    gaps.push(
      `tests run in a browser (\`${commands.test.value}\`) — in a CI/agent context run them headless (e.g. \`--watch=false --browsers=ChromeHeadless\`) or they hang waiting for a browser`,
    );
  }

  const canon = classifyCanon(root, contextDir);
  if (isAdoptable(canon.kind)) {
    gaps.push(
      `reconcile existing AI canon (${canon.kind}) before regenerating — run \`aih adopt\``,
    );
  }

  const footprint = cliFootprint(root, contextDir, { committed });
  if (footprint.importCandidates > 0) {
    gaps.push(
      `${plural(footprint.importCandidates, "un-imported CLI rule set")} — review with \`aih adopt\``,
    );
  }

  if (canon.legacyArtifacts.length > 0) {
    gaps.push(
      `retire ${plural(canon.legacyArtifacts.length, "legacy canon script")} (${canon.legacyArtifacts.join(", ")})`,
    );
  }

  for (const slot of ["test", "build", "lint", "start"] as const) {
    const cmd = commands[slot];
    if (cmd?.confidence === "inferred") {
      gaps.push(`unconfirmed \`${cmd.value}\` (${slot} inferred, not declared) — verify it runs`);
    }
  }

  return gaps;
}

/**
 * Synthesize the repo contract from the detected stack. Read-only and deterministic:
 * the same tree + runner always yields byte-identical JSON. The only process touch is
 * the read-only `git ls-files` seam (tracked count + committed set, both mocked in
 * tests) — locked decision #2's "no `ctx.run`/no spawn" governs COMMAND CONFIDENCE
 * (we never run a candidate command to mark it `verified`), not this metadata read;
 * the plan it feeds emits pure write/probe actions, zero `exec`.
 */
export async function synthesizeContract(
  ctx: PlanContext,
  stack: RepoStack,
): Promise<ProjectContract> {
  const { root, contextDir } = ctx;
  const trackedFiles = await trackedFileCount(ctx);
  const committed = await gitCommittedSet(ctx);

  const commands = {
    test: toCommand(stack.testRunner, "npm test"),
    build: toDeclaredCommand(stack.buildCommand, "npm run build"),
    lint: toCommand(stack.lintCommand, "npm run lint"),
    start: toDeclaredCommand(stack.startCommand, "npm start"),
  };

  const secrets = scanSecrets(root);
  const targets = (ctx.targets ?? readAihConfig(root)?.targets ?? []).map((t) => String(t));

  return {
    schemaVersion: 1,
    contextDir,
    targets,
    description: stack.description,
    languages: stack.languages,
    frameworks: stack.frameworks,
    cloud: stack.cloud,
    databases: stack.databases,
    deployment: stack.deployment,
    packageManager: stack.packageManager,
    entrypoints: stack.entryPoints,
    commands,
    scale: {
      trackedFiles,
      class: scaleClass(trackedFiles, stack.isMonorepo),
      isMonorepo: stack.isMonorepo,
    },
    sensitivePaths: secrets.matches,
    knownGaps: deriveKnownGaps(root, contextDir, committed, commands, stack.browserTest),
  };
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/; // C:\ or C:/
const UNC_PREFIX = /^\\\\/; // \\server\share

/**
 * Is `p` a portable, repo-relative POSIX path? Checked with explicit shape tests
 * rather than `node:path.isAbsolute`, which is platform-specific (a Windows drive
 * reads as relative on a Linux CI runner and a POSIX absolute reads as relative on
 * Windows) — a COMMITTED contract must validate identically on every machine.
 */
function isPortableRel(p: string): boolean {
  if (p.length === 0) return true;
  if (p.includes("\\")) return false; // any backslash ⇒ non-POSIX (covers UNC + C:\ )
  if (WINDOWS_DRIVE.test(p) || UNC_PREFIX.test(p)) return false; // C:/ form, UNC
  if (p.startsWith("/")) return false; // POSIX absolute
  const n = p.replace(/^\.\//, "");
  return n !== ".." && !n.startsWith("../"); // no parent-dir escape
}

/**
 * The contract's path-bearing values that are NOT portable repo-relative POSIX paths
 * (empty ⇒ clean). A committed contract that hard-codes `C:\…`, `/abs`, or `../escape`
 * would mislead the next agent on a different machine, so the doctor/report probes
 * fail closed on any hit. Commands and CLI target names are not paths and are skipped.
 */
export function unportablePaths(contract: ProjectContract): string[] {
  const candidates = [contract.contextDir, ...contract.entrypoints, ...contract.sensitivePaths];
  return candidates.filter((p) => !isPortableRel(p));
}
