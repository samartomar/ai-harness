import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeAnalyzerIdentity } from "../baseline-evidence/native-identity.js";
import {
  type BaselineComponentEvidence,
  type BaselineEvidenceLock,
  parseBaselineEvidenceLock,
} from "../baseline-evidence/schema.js";

export interface LockMigrationDiff {
  sourceId: string;
  componentId: string;
  detail: string;
}

export interface LockMigrationReport {
  ok: boolean;
  diffs: LockMigrationDiff[];
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Every field of `prior`'s analyzers with `aih-native`'s version swapped for
 * `nextIdentity`, so the comparison below isolates exactly that one rewrite. */
function rewriteNativeVersion(
  analyzers: BaselineComponentEvidence["analyzers"],
  nextIdentity: string,
): BaselineComponentEvidence["analyzers"] {
  return analyzers.map((receipt) =>
    receipt.name === "aih-native" ? { name: receipt.name, version: nextIdentity } : receipt,
  );
}

/** Precise, field-by-field diff detail for one component pair — used instead of a
 * single opaque JSON blob so the controller can see exactly what moved. */
function componentDiffDetail(
  prior: BaselineComponentEvidence,
  next: BaselineComponentEvidence,
  nextIdentity: string,
): string | undefined {
  const problems: string[] = [];
  if (!samePaths(prior.paths, next.paths)) {
    problems.push(`paths ${JSON.stringify(prior.paths)} → ${JSON.stringify(next.paths)}`);
  }
  if (prior.treeSha256 !== next.treeSha256) {
    problems.push(`treeSha256 ${prior.treeSha256} → ${next.treeSha256}`);
  }
  if (prior.verdict !== next.verdict) {
    problems.push(`verdict ${prior.verdict} → ${next.verdict}`);
  }
  const expectedAnalyzers = rewriteNativeVersion(prior.analyzers, nextIdentity);
  if (JSON.stringify(expectedAnalyzers) !== JSON.stringify(next.analyzers)) {
    problems.push(
      `analyzers differ beyond the aih-native identity rewrite (expected ${JSON.stringify(expectedAnalyzers)}, found ${JSON.stringify(next.analyzers)})`,
    );
  }
  if (JSON.stringify(prior.findings) !== JSON.stringify(next.findings)) {
    problems.push(
      `findings differ (expected ${JSON.stringify(prior.findings)}, found ${JSON.stringify(next.findings)})`,
    );
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/**
 * Assert that `next` differs from `prior` ONLY in every component's
 * `aih-native` analyzer version string (rewritten to `nextIdentity`, default
 * the live `nativeAnalyzerIdentity()`). Any other difference — verdict,
 * findings, treeSha256, paths, a non-`aih-native` analyzer version, component
 * or source ordering, or a pin rebind — is a genuine migration failure: the
 * full re-vet changed something beyond the identity format, and the PR must
 * stop (design Decision 2's verdict-stability proof, issue #444).
 */
export function assertIdentityOnlyLockMigration(
  prior: BaselineEvidenceLock,
  next: BaselineEvidenceLock,
  nextIdentity: string = nativeAnalyzerIdentity(),
): LockMigrationReport {
  const diffs: LockMigrationDiff[] = [];
  if (prior.sources.length !== next.sources.length) {
    diffs.push({
      sourceId: "<lock>",
      componentId: "<catalog>",
      detail: `source count ${prior.sources.length} → ${next.sources.length}`,
    });
    return { ok: false, diffs };
  }
  for (const [sourceIndex, priorSource] of prior.sources.entries()) {
    const nextSource = next.sources[sourceIndex];
    if (nextSource === undefined || nextSource.id !== priorSource.id) {
      diffs.push({
        sourceId: priorSource.id,
        componentId: "<catalog>",
        detail: `source order/id mismatch at index ${sourceIndex}`,
      });
      continue;
    }
    if (nextSource.owner !== priorSource.owner || nextSource.repo !== priorSource.repo) {
      diffs.push({
        sourceId: priorSource.id,
        componentId: "<catalog>",
        detail: `owner/repo ${priorSource.owner}/${priorSource.repo} → ${nextSource.owner}/${nextSource.repo}`,
      });
    }
    if (nextSource.pinnedSha !== priorSource.pinnedSha) {
      diffs.push({
        sourceId: priorSource.id,
        componentId: "<catalog>",
        detail: `pinnedSha ${priorSource.pinnedSha} → ${nextSource.pinnedSha}`,
      });
    }
    if (priorSource.components.length !== nextSource.components.length) {
      diffs.push({
        sourceId: priorSource.id,
        componentId: "<catalog>",
        detail: `component count ${priorSource.components.length} → ${nextSource.components.length}`,
      });
      continue;
    }
    for (const [componentIndex, priorComponent] of priorSource.components.entries()) {
      const nextComponent = nextSource.components[componentIndex];
      if (nextComponent === undefined || nextComponent.id !== priorComponent.id) {
        diffs.push({
          sourceId: priorSource.id,
          componentId: priorComponent.id,
          detail: `component order/id mismatch at index ${componentIndex}`,
        });
        continue;
      }
      const detail = componentDiffDetail(priorComponent, nextComponent, nextIdentity);
      if (detail !== undefined) {
        diffs.push({ sourceId: priorSource.id, componentId: priorComponent.id, detail });
      }
    }
  }
  return { ok: diffs.length === 0, diffs };
}

function optionValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readLock(path: string): BaselineEvidenceLock {
  return parseBaselineEvidenceLock(JSON.parse(readFileSync(path, "utf8")));
}

function main(): void {
  const argv = process.argv.slice(2);
  const priorPath = optionValue(argv, "--prior");
  const nextPath = optionValue(argv, "--next");
  if (!priorPath || !nextPath) {
    throw new Error("usage: assert-identity-only-lock-migration --prior <file> --next <file>");
  }
  const report = assertIdentityOnlyLockMigration(
    readLock(resolve(priorPath)),
    readLock(resolve(nextPath)),
  );
  if (!report.ok) {
    for (const diff of report.diffs) {
      process.stderr.write(`${diff.sourceId}/${diff.componentId}: ${diff.detail}\n`);
    }
    process.stderr.write(
      `migration is not identity-only: ${report.diffs.length} component(s)/source(s) changed beyond the aih-native identity rewrite\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${priorPath} -> ${nextPath}: identical except every aih-native receipt now reads ${nativeAnalyzerIdentity()}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
