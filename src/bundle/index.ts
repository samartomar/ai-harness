import { createHash } from "node:crypto";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  exec,
  type PlanContext,
  plan,
  probe,
  writeJson,
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";

const DEFAULT_OUT = ".aih/fleet-bundle";
const CHECKSUMS_FILE = "SHA256SUMS";
const SIGNATURE_FILE = "SHA256SUMS.sig";
const MANIFEST_FILE = "manifest.json";

interface BundleFile {
  path: string;
  contents: string;
  bytes: number;
  sha256: string;
}

interface BundleManifest {
  schemaVersion: 1;
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function bundleOut(ctx: PlanContext): string {
  const raw =
    typeof ctx.options.out === "string" && ctx.options.out.length > 0
      ? ctx.options.out
      : DEFAULT_OUT;
  return raw;
}

function verifyBundleRoot(ctx: PlanContext): string {
  const raw =
    typeof ctx.options.bundle === "string" && ctx.options.bundle.length > 0
      ? ctx.options.bundle
      : DEFAULT_OUT;
  return isAbsolute(raw) ? raw : join(ctx.root, raw);
}

function bundlePath(out: string, ...parts: string[]): string {
  return posix.join(posixPath(out), ...parts.map(posixPath));
}

function writeExternal(out: string): boolean {
  return isAbsolute(out);
}

function defaultBundlePaths(ctx: PlanContext): string[] {
  return [
    posix.join(ctx.contextDir, "project.json"),
    "aih-org-policy.json",
    ".claude/managed-settings.json",
    "managed-settings.json.example",
    "managed-mcp.json.example",
    ".mcp.json",
    ".gitleaks.toml",
    ".pre-commit-config.yaml",
    ".github/workflows/sca.yml",
  ];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => posixPath(item.trim()))
    .filter((item) => item.length > 0);
}

function candidatePaths(ctx: PlanContext): string[] {
  return [...new Set([...defaultBundlePaths(ctx), ...splitCsv(ctx.options.include)])].sort((a, b) =>
    a.localeCompare(b),
  );
}

function readBundleFiles(ctx: PlanContext): BundleFile[] {
  const files: BundleFile[] = [];
  for (const rel of candidatePaths(ctx)) {
    if (isAbsolute(rel) || rel.split("/").includes("..")) continue;
    const contents = readIfExists(join(ctx.root, rel));
    if (contents === undefined) continue;
    files.push({
      path: rel,
      contents,
      bytes: Buffer.byteLength(contents, "utf8"),
      sha256: sha256Hex(contents),
    });
  }
  return files;
}

function manifest(files: BundleFile[]): BundleManifest {
  return {
    schemaVersion: 1,
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
}

function sha256Sums(files: BundleFile[]): string {
  return `${files.map((file) => `${file.sha256}  files/${file.path}`).join("\n")}\n`;
}

function signAction(out: string, signer: unknown): Action | undefined {
  const sums = bundlePath(out, CHECKSUMS_FILE);
  const sig = bundlePath(out, SIGNATURE_FILE);
  if (signer === "cosign") {
    return exec(
      "sign fleet bundle checksums with cosign",
      ["cosign", "sign-blob", "--yes", "--output-signature", sig, sums],
      { allowFailure: true },
    );
  }
  if (signer === "gh") {
    return exec(
      "sign fleet bundle checksums with GitHub attestations",
      ["gh", "attestation", "sign", sums],
      {
        allowFailure: true,
      },
    );
  }
  return undefined;
}

function bundlePlan(ctx: PlanContext) {
  const out = bundleOut(ctx);
  const external = writeExternal(out);
  const files = readBundleFiles(ctx);
  const actions: Action[] = files.map((file) =>
    writeText(bundlePath(out, "files", file.path), file.contents, `bundle artifact: ${file.path}`, {
      external,
    }),
  );
  actions.push(
    writeJson(bundlePath(out, MANIFEST_FILE), manifest(files), "fleet bundle manifest", {
      external,
    }),
    writeText(bundlePath(out, CHECKSUMS_FILE), sha256Sums(files), "fleet bundle SHA256SUMS", {
      external,
    }),
  );
  const sign = signAction(out, ctx.options.sign);
  if (sign) actions.push(sign);
  return plan("bundle", ...actions);
}

function parseChecksum(line: string): { hash: string; path: string } | undefined {
  const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { hash: match[1].toLowerCase(), path: posixPath(match[2]) };
}

function safeBundleFile(bundleRoot: string, rel: string): string | undefined {
  if (isAbsolute(rel) || rel.split("/").includes("..")) return undefined;
  const root = resolve(bundleRoot);
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
  return target;
}

export function verifyBundleChecksums(bundleRoot: string): Check {
  const raw = readIfExists(join(bundleRoot, CHECKSUMS_FILE));
  if (raw === undefined) {
    return {
      name: "fleet bundle checksums",
      verdict: "fail",
      detail: `${CHECKSUMS_FILE} is missing`,
    };
  }
  const failures: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseChecksum(line);
    if (parsed === undefined) {
      failures.push(`malformed line: ${line}`);
      continue;
    }
    const target = safeBundleFile(bundleRoot, parsed.path);
    if (target === undefined) {
      failures.push(`${parsed.path} escapes bundle root`);
      continue;
    }
    const contents = readIfExists(target);
    if (contents === undefined) {
      failures.push(`${parsed.path} missing`);
      continue;
    }
    const actual = sha256Hex(contents);
    if (actual !== parsed.hash)
      failures.push(`${parsed.path} expected ${parsed.hash}, got ${actual}`);
  }
  if (failures.length > 0) {
    return { name: "fleet bundle checksums", verdict: "fail", detail: failures.join("; ") };
  }
  return { name: "fleet bundle checksums", verdict: "pass", detail: "all checksums match" };
}

async function verifyBundleSignature(ctx: PlanContext, bundleRoot: string): Promise<Check> {
  const sums = join(bundleRoot, CHECKSUMS_FILE);
  if (ctx.options.signer === "gh") {
    const repo = typeof ctx.options.repo === "string" ? ctx.options.repo.trim() : "";
    if (repo.length === 0) {
      return {
        name: "fleet bundle signature",
        verdict: "skip",
        detail: "gh attestation verification requires --repo <owner/repo>",
      };
    }
    const res = await ctx.run(["gh", "attestation", "verify", sums, "--repo", repo]);
    if (res.spawnError) {
      return { name: "fleet bundle signature", verdict: "skip", detail: "gh not found" };
    }
    if (res.code === 0) {
      return {
        name: "fleet bundle signature",
        verdict: "pass",
        detail: "GitHub attestation verified SHA256SUMS",
      };
    }
    return {
      name: "fleet bundle signature",
      verdict: "fail",
      detail: res.stderr.trim() || `gh attestation verify exited ${res.code}`,
    };
  }

  const sig = join(bundleRoot, SIGNATURE_FILE);
  if (readIfExists(sig) === undefined) {
    return { name: "fleet bundle signature", verdict: "skip", detail: `${SIGNATURE_FILE} missing` };
  }
  const res = await ctx.run(["cosign", "verify-blob", "--signature", sig, sums]);
  if (res.spawnError) {
    return { name: "fleet bundle signature", verdict: "skip", detail: "cosign not found" };
  }
  if (res.code === 0) {
    return {
      name: "fleet bundle signature",
      verdict: "pass",
      detail: "cosign verified SHA256SUMS",
    };
  }
  return {
    name: "fleet bundle signature",
    verdict: "fail",
    detail: res.stderr.trim() || `cosign exited ${res.code}`,
  };
}

function verifyPlan(ctx: PlanContext) {
  const root = verifyBundleRoot(ctx);
  return plan(
    "verify-bundle",
    probe("fleet bundle checksums", () => verifyBundleChecksums(root)),
    probe("fleet bundle signature", (c) => verifyBundleSignature(c, root)),
  );
}

export const command: CommandSpec = {
  name: "bundle",
  summary: "Build a deterministic fleet bundle (contract, org policy, managed config, checksums)",
  options: [
    {
      flags: "--out <dir>",
      description: "output directory for the fleet bundle",
      default: DEFAULT_OUT,
    },
    {
      flags: "--include <paths>",
      description: "comma-separated additional repo-relative files to include",
    },
    {
      flags: "--sign <signer>",
      description: "optional signer: cosign | gh",
    },
  ],
  plan: bundlePlan,
};

export const verifyCommand: CommandSpec = {
  name: "verify-bundle",
  summary: "Verify a fleet bundle's SHA256SUMS and optional cosign signature",
  readOnly: true,
  options: [
    {
      flags: "--bundle <dir>",
      description: "bundle directory to verify",
      default: DEFAULT_OUT,
    },
    {
      flags: "--signer <signer>",
      description: "signature verifier: cosign | gh (default: cosign when SHA256SUMS.sig exists)",
    },
    {
      flags: "--repo <owner/repo>",
      description: "GitHub repository identity for --signer gh attestation verification",
    },
  ],
  plan: verifyPlan,
};
