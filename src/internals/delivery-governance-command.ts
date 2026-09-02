import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import {
  assertCandidateActive,
  buildCumulativeEnterpriseDelta,
  evidenceSha256,
  promotionAuthorizationToken,
  publicationAuthorizationToken,
  resolveReleaseAuthorizationComment,
  validateCandidateManifestForRepository,
  validateInstalledAcceptanceReceipt,
  validateQualificationReceiptForRepository,
  validateReleasePreparation,
} from "./delivery-governance.js";
import { defaultRunner } from "./proc.js";

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`${path} exceeds the 2 MiB evidence cap`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parseStrictJsonObjectV1(text, path);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function usage(): never {
  throw new Error(
    "usage: delivery-governance <manifest|cumulative|qualification|acceptance|digest|publication-token|promotion-token|resolve-publication|resolve-promotion|assert-active|release-prep> ...",
  );
}

async function gitText(args: string[]): Promise<string> {
  const result = await defaultRunner(["git", ...args], { cwd: process.cwd() });
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

async function validateReleasePrep(base: string, head: string): Promise<void> {
  const changedPaths = (await gitText(["diff", "--name-only", "-z", `${base}...${head}`]))
    .split("\0")
    .filter(Boolean);
  const changed = new Set(changedPaths);
  const readAt = async (revision: string, path: string): Promise<string | undefined> => {
    if (!changed.has(path)) return undefined;
    return gitText(["show", `${revision}:${path}`]);
  };
  const [packageBefore, packageAfter, lockBefore, lockAfter, versionBefore, versionAfter] =
    await Promise.all([
      readAt(base, "package.json"),
      readAt(head, "package.json"),
      readAt(base, "package-lock.json"),
      readAt(head, "package-lock.json"),
      readAt(base, "src/version.ts"),
      readAt(head, "src/version.ts"),
    ]);
  const findings = validateReleasePreparation({
    changedPaths,
    packageBefore: packageBefore === undefined ? undefined : JSON.parse(packageBefore),
    packageAfter: packageAfter === undefined ? undefined : JSON.parse(packageAfter),
    lockBefore: lockBefore === undefined ? undefined : JSON.parse(lockBefore),
    lockAfter: lockAfter === undefined ? undefined : JSON.parse(lockAfter),
    versionBefore,
    versionAfter,
  });
  if (findings.length > 0) {
    throw new Error(findings.map((finding) => `${finding.code}: ${finding.detail}`).join("\n"));
  }
}

async function assertActive(path: string, expectedRepository: string): Promise<void> {
  const receipt = validateQualificationReceiptForRepository(readJson(path), expectedRepository);
  const result = await defaultRunner([
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `repos/${expectedRepository}/issues/${receipt.tracker.issueNumber}/comments?per_page=100`,
  ]);
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error("failed to read candidate state comments");
  }
  const pages = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("candidate state response is not a paginated array");
  }
  assertCandidateActive(receipt, expectedRepository, pages.flat());
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "manifest":
      validateCandidateManifestForRepository(readJson(args[0] ?? usage()), args[1] ?? usage());
      return;
    case "cumulative": {
      const [fromVersion, toVersion, output, ...manifestPaths] = args;
      if (manifestPaths.length === 0) usage();
      const delta = buildCumulativeEnterpriseDelta(
        manifestPaths.map((path) => readJson(path)),
        fromVersion ?? usage(),
        toVersion ?? usage(),
      );
      writeJson(output ?? usage(), delta);
      return;
    }
    case "qualification":
      validateQualificationReceiptForRepository(readJson(args[0] ?? usage()), args[1] ?? usage());
      return;
    case "acceptance":
      validateInstalledAcceptanceReceipt(readJson(args[0] ?? usage()));
      return;
    case "digest":
      process.stdout.write(`sha256:${evidenceSha256(readJson(args[0] ?? usage()))}\n`);
      return;
    case "publication-token":
      process.stdout.write(`${publicationAuthorizationToken(readJson(args[0] ?? usage()))}\n`);
      return;
    case "promotion-token":
      process.stdout.write(
        `${promotionAuthorizationToken(readJson(args[0] ?? usage()), readJson(args[1] ?? usage()))}\n`,
      );
      return;
    case "resolve-publication": {
      const receipt = readJson(args[0] ?? usage());
      const authorization = await resolveReleaseAuthorizationComment(
        "publication",
        receipt,
        undefined,
        args[1] ?? usage(),
        args[2] ?? usage(),
      );
      writeJson(args[3] ?? usage(), authorization);
      return;
    }
    case "resolve-promotion": {
      const receipt = readJson(args[0] ?? usage());
      const acceptance = readJson(args[1] ?? usage());
      const authorization = await resolveReleaseAuthorizationComment(
        "promotion",
        receipt,
        acceptance,
        args[2] ?? usage(),
        args[3] ?? usage(),
      );
      writeJson(args[4] ?? usage(), authorization);
      return;
    }
    case "assert-active":
      await assertActive(args[0] ?? usage(), args[1] ?? usage());
      return;
    case "release-prep":
      await validateReleasePrep(args[0] ?? usage(), args[1] ?? usage());
      return;
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
