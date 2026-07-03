import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type CommandSpec, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { redactText } from "../support/redact.js";
import { execArgv } from "../tools/install.js";

const PACKAGE_NAME = "@aihq/harness";
const REPO = "samartomar/ai-harness";
type ReleasePlanContext = Parameters<CommandSpec["plan"]>[0];
type VersionResolver = (ctx: ReleasePlanContext) => Promise<string | undefined>;

function normalizeVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/^v/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function releaseArgv(ctx: ReleasePlanContext, argv: string[]): string[] {
  return execArgv(ctx.host.platform, argv);
}

async function publishedVersion(ctx: ReleasePlanContext): Promise<string | undefined> {
  const fromOption = normalizeVersion(ctx.options.version);
  if (fromOption !== undefined) return fromOption;
  const res = await ctx.run(releaseArgv(ctx, ["npm", "view", PACKAGE_NAME, "version"]), {
    timeoutMs: 60_000,
  });
  if (res.code !== 0 || res.spawnError) return undefined;
  return normalizeVersion(res.stdout);
}

function fail(name: string, detail: string): Check {
  return { name, verdict: "fail", detail };
}

function skip(name: string, detail: string): Check {
  return { name, verdict: "skip", detail };
}

function pass(name: string, detail: string): Check {
  return { name, verdict: "pass", detail };
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("PASSWORD") ||
    upper.endsWith("_KEY") ||
    upper.endsWith("_CREDENTIALS")
  );
}

function redactEnvValues(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8 || !isSensitiveEnvKey(key)) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return out;
}

function outputDetail(
  ctx: ReleasePlanContext,
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  const raw = (stderr.trim() || stdout.trim() || fallback).slice(0, 800);
  return redactEnvValues(redactText(raw, ctx.env), ctx.env);
}

async function npmSignaturesCheck(
  ctx: ReleasePlanContext,
  versionFor: VersionResolver,
): Promise<Check> {
  const version = await versionFor(ctx);
  if (version === undefined) {
    return skip("release npm signatures", `could not resolve ${PACKAGE_NAME} version from npm`);
  }
  const dir = mkdtempSync(join(tmpdir(), "aih-npm-signatures-"));
  try {
    const install = await ctx.run(
      releaseArgv(ctx, [
        "npm",
        "install",
        "--ignore-scripts",
        "--audit=false",
        "--fund=false",
        "--prefix",
        dir,
        `${PACKAGE_NAME}@${version}`,
      ]),
      { timeoutMs: 120_000 },
    );
    if (install.spawnError) return skip("release npm signatures", "npm not found");
    if (install.code !== 0) {
      return fail(
        "release npm signatures",
        outputDetail(ctx, install.stdout, install.stderr, `npm install exited ${install.code}`),
      );
    }
    const res = await ctx.run(releaseArgv(ctx, ["npm", "audit", "signatures", "--prefix", dir]), {
      timeoutMs: 120_000,
    });
    if (res.spawnError) return skip("release npm signatures", "npm not found");
    if (res.code !== 0) {
      return fail(
        "release npm signatures",
        outputDetail(ctx, res.stdout, res.stderr, `npm audit signatures exited ${res.code}`),
      );
    }
    return pass(
      "release npm signatures",
      `${PACKAGE_NAME}@${version} registry signatures verified`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function releaseIdentity(version: string): string {
  return `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v${version}`;
}

async function withReleaseAssets(
  ctx: ReleasePlanContext,
  name: string,
  versionFor: VersionResolver,
  run: (dir: string, version: string) => Promise<Check>,
): Promise<Check> {
  const version = await versionFor(ctx);
  if (version === undefined) {
    return skip(name, `could not resolve ${PACKAGE_NAME} version from npm`);
  }
  const dir = mkdtempSync(join(tmpdir(), "aih-release-"));
  try {
    const download = await ctx.run(
      [
        "gh",
        "release",
        "download",
        `v${version}`,
        "--repo",
        REPO,
        "--pattern",
        "SHA256SUMS.txt",
        "--pattern",
        "SHA256SUMS.txt.sigstore.json",
        "--dir",
        dir,
        "--clobber",
      ],
      { timeoutMs: 120_000 },
    );
    if (download.spawnError) return skip(name, "gh not found");
    if (download.code !== 0) {
      return fail(
        name,
        outputDetail(
          ctx,
          download.stdout,
          download.stderr,
          `gh release download exited ${download.code}`,
        ),
      );
    }
    return await run(dir, version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function cosignBundleCheck(
  ctx: ReleasePlanContext,
  versionFor: VersionResolver,
): Promise<Check> {
  return withReleaseAssets(ctx, "release cosign bundle", versionFor, async (dir, version) => {
    const sums = join(dir, "SHA256SUMS.txt");
    const bundle = join(dir, "SHA256SUMS.txt.sigstore.json");
    if (!existsSync(sums) || !existsSync(bundle)) {
      return fail(
        "release cosign bundle",
        "release download did not produce SHA256SUMS.txt and its sigstore bundle",
      );
    }
    const res = await ctx.run(
      [
        "cosign",
        "verify-blob",
        "--bundle",
        bundle,
        "--certificate-identity",
        releaseIdentity(version),
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        sums,
      ],
      { timeoutMs: 120_000 },
    );
    if (res.spawnError || res.code === 127)
      return skip("release cosign bundle", "cosign not found");
    if (res.code !== 0) {
      return fail(
        "release cosign bundle",
        outputDetail(ctx, res.stdout, res.stderr, `cosign verify-blob exited ${res.code}`),
      );
    }
    return pass("release cosign bundle", "cosign verified SHA256SUMS.txt sigstore bundle");
  });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseSums(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    out.set(basename(match[2]), match[1].toLowerCase());
  }
  return out;
}

async function tarballHashCheck(
  ctx: ReleasePlanContext,
  versionFor: VersionResolver,
): Promise<Check> {
  return withReleaseAssets(ctx, "release tarball hash", versionFor, async (dir, version) => {
    const sumsPath = join(dir, "SHA256SUMS.txt");
    if (!existsSync(sumsPath)) return fail("release tarball hash", "SHA256SUMS.txt is missing");
    const pack = await ctx.run(
      releaseArgv(ctx, [
        "npm",
        "pack",
        `${PACKAGE_NAME}@${version}`,
        "--pack-destination",
        dir,
        "--silent",
      ]),
      { timeoutMs: 120_000 },
    );
    if (pack.spawnError) return skip("release tarball hash", "npm not found");
    if (pack.code !== 0) {
      return fail(
        "release tarball hash",
        outputDetail(ctx, pack.stdout, pack.stderr, `npm pack exited ${pack.code}`),
      );
    }
    const fromStdout = pack.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    const tarball =
      fromStdout !== undefined && existsSync(join(dir, fromStdout))
        ? fromStdout
        : readdirSync(dir).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) {
      return fail("release tarball hash", "npm pack completed but no tarball was written");
    }
    const expected = parseSums(readFileSync(sumsPath, "utf8")).get(tarball);
    if (expected === undefined) {
      return fail("release tarball hash", `${tarball} is not listed in SHA256SUMS.txt`);
    }
    const actual = sha256File(join(dir, tarball));
    if (actual !== expected) {
      return fail("release tarball hash", `${tarball} expected ${expected}, got ${actual}`);
    }
    return pass("release tarball hash", `${tarball} matches SHA256SUMS.txt`);
  });
}

export const verifyReleaseCommand: CommandSpec = {
  name: "verify-release",
  summary: "Verify a published release's npm signatures, cosign bundle, and tarball hash",
  readOnly: true,
  positional: {
    name: "version",
    required: false,
    optionName: "version",
    description: "published version to verify (defaults to latest npm version)",
  },
  plan: () => {
    let versionPromise: Promise<string | undefined> | undefined;
    const versionFor: VersionResolver = (ctx) => {
      versionPromise ??= publishedVersion(ctx);
      return versionPromise;
    };
    return plan(
      "verify-release",
      probe("release npm signatures", (ctx) => npmSignaturesCheck(ctx, versionFor)),
      probe("release cosign bundle", (ctx) => cosignBundleCheck(ctx, versionFor)),
      probe("release tarball hash", (ctx) => tarballHashCheck(ctx, versionFor)),
    );
  },
};
