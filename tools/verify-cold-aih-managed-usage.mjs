import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("npm-cli-unavailable");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`cold-managed-usage-command-failed:${args.join(" ")}:${result.stderr.slice(0, 160)}`);
  return result;
}

function runInstalledCli(cwd, cli, bin, args, allowFailure = false) {
  const env = { ...process.env };
  delete env.AIH_POLICY_AUTHORITY_REPOSITORY;
  delete env.AIH_POLICY_AUTHORITY_WORKFLOW;
  const result = spawnSync(
    process.platform === "win32" ? process.execPath : bin,
    process.platform === "win32" ? [cli, ...args] : args,
    { cwd, encoding: "utf8", env },
  );
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `cold-managed-usage-cli-failed:${args.join(" ")}:${result.stderr.slice(0, 160)}`,
    );
  return result;
}

const tempBase = resolve(tmpdir());
const temp = mkdtempSync(join(tempBase, "aih-managed-usage-cold-"));
try {
  const packed = runNode(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  const packManifest = JSON.parse(packed.stdout);
  if (!Array.isArray(packManifest) || typeof packManifest[0]?.filename !== "string")
    throw new Error("cold-managed-usage-pack-manifest");

  const consumer = resolve(temp, "consumer");
  const target = resolve(temp, "target");
  mkdirSync(consumer);
  mkdirSync(target);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"cold-aih-managed-usage"}');
  runNode(consumer, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    resolve(temp, packManifest[0].filename),
  ]);

  const installed = resolve(consumer, "node_modules", "@aihq", "harness");
  const cli = resolve(installed, "dist", "cli.js");
  const bin = resolve(consumer, "node_modules", ".bin", "aih");
  if (!existsSync(cli) || !existsSync(bin)) throw new Error("cold-managed-usage-install");

  const described = runInstalledCli(consumer, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "describe",
    "--json",
  ]);
  const describeResult = JSON.parse(described.stdout);
  const descriptor = describeResult.digests?.[0]?.data;
  if (
    descriptor?.adapter?.id !== "aih-usage-metering" ||
    descriptor?.adapter?.version !== "1.0.0" ||
    descriptor?.effect !== "configure" ||
    descriptor?.subject?.kind !== "tool" ||
    descriptor?.subject?.id !== "usage-metering" ||
    descriptor?.subject?.source?.type !== "aih" ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor?.adapter?.digest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor?.subject?.subjectDigest ?? "") ||
    JSON.stringify(descriptor?.targets) !== '["claude","codex"]'
  )
    throw new Error("cold-managed-usage-descriptor");

  const inspectedBefore = runInstalledCli(target, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "inspect",
    target,
    "--json",
  ]);
  const before = JSON.parse(inspectedBefore.stdout).digests?.[0]?.data;
  if (before?.state !== "absent") throw new Error("cold-managed-usage-initial-inspection");

  const now = new Date();
  const canonicalUtc = (value) => value.toISOString().replace(/\.\d{3}Z$/, "Z");
  const evidencePath = resolve(target, "organization-evidence.json");
  writeFileSync(
    evidencePath,
    stableJson({
      attestor: "cold-administrator-proof",
      evidence: {
        artifactDigests: [`sha256:${"2".repeat(64)}`],
        id: "cold-proof-record",
        kind: "assessment",
        payloadDigest: `sha256:${"1".repeat(64)}`,
        summary: "Pre-publication evidence used only to prove fail-closed authority handling.",
      },
      expiresAt: canonicalUtc(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
      format: "aih-organization-evidence",
      issuedAt: canonicalUtc(now),
      notBefore: canonicalUtc(now),
      subjectDigest: descriptor.subject.subjectDigest,
      version: 1,
    }),
  );
  const refused = runInstalledCli(
    target,
    cli,
    bin,
    [
      "policy",
      "managed",
      "usage-metering",
      "reconcile",
      target,
      "--decision",
      "cold-managed-usage",
      "--decision-digest",
      `sha256:${"3".repeat(64)}`,
      "--target",
      "claude",
      "--evidence",
      "organization-evidence.json",
      "--apply",
      "--json",
    ],
    true,
  );
  if (!Number.isInteger(refused.status) || refused.status <= 0)
    throw new Error("cold-managed-usage-unauthorized-effect-accepted");
  if (!`${refused.stdout}\n${refused.stderr}`.includes("authority-unverified"))
    throw new Error("cold-managed-usage-authority-boundary");

  const inspectedAfter = runInstalledCli(target, cli, bin, [
    "policy",
    "managed",
    "usage-metering",
    "inspect",
    target,
    "--json",
  ]);
  const after = JSON.parse(inspectedAfter.stdout).digests?.[0]?.data;
  if (after?.state !== "absent") throw new Error("cold-managed-usage-refusal-wrote-custody");
  for (const relative of [
    ".aih/org-policy-hook-receipt.json",
    ".aih/usage-record.mjs",
    ".gitignore",
    ".claude/settings.json",
    ".codex/hooks.json",
  ]) {
    if (existsSync(resolve(target, relative)))
      throw new Error(`cold-managed-usage-refusal-wrote-output:${relative}`);
  }

  process.stdout.write(
    "Cold packed AIH-managed usage-metering pre-publication proof PASS (descriptor and inspection used packed bytes; explicit apply refused without externally attested V3 organization authority; no successful configure or revocation is claimed)\n",
  );
} finally {
  const resolvedTemp = resolve(temp);
  if (!resolvedTemp.startsWith(`${tempBase}${sep}`)) throw new Error("unsafe-cold-proof-cleanup");
  rmSync(resolvedTemp, { force: true, recursive: true });
}
