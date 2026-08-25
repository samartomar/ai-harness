import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("cold-upstream-artifact-npm-cli-unavailable");

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `cold-upstream-artifact-command-failed:${args.join(" ")}:${(result.stderr || result.stdout).slice(0, 200)}`,
    );
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
      `cold-upstream-artifact-cli-failed:${args.join(" ")}:${(result.stderr || result.stdout).slice(0, 200)}`,
    );
  return result;
}

const tempBase = resolve(tmpdir());
const temp = mkdtempSync(join(tempBase, "aih-upstream-artifact-cold-"));
try {
  const packed = runNode(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  const packManifest = JSON.parse(packed.stdout);
  if (
    !Array.isArray(packManifest) ||
    packManifest[0]?.name !== "@aihq/core" ||
    typeof packManifest[0]?.filename !== "string"
  )
    throw new Error("cold-upstream-artifact-pack-manifest");

  const consumer = resolve(temp, "consumer");
  const target = resolve(temp, "target");
  mkdirSync(consumer);
  mkdirSync(target);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"cold-upstream-artifact"}\n');
  runNode(consumer, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    resolve(temp, packManifest[0].filename),
  ]);

  const installed = resolve(consumer, "node_modules", "@aihq", "core");
  const cli = resolve(installed, "dist", "cli.js");
  const bin = resolve(consumer, "node_modules", ".bin", "aih");
  const schema = resolve(installed, "schemas", "aih-upstream-artifact-manifest-v1.schema.json");
  if (!existsSync(cli) || !existsSync(bin) || !existsSync(schema))
    throw new Error("cold-upstream-artifact-install");

  writeFileSync(
    resolve(consumer, "verify-public.mjs"),
    [
      'import { canonicalUpstreamArtifactManifestV1, parseUpstreamArtifactManifestV1Bytes } from "@aihq/core";',
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      'const sha = `sha256:${"a".repeat(64)}`;',
      'const manifest = { format: "aih-upstream-artifact-manifest", version: 1, decisionId: "decision-custom-mcp", subject: { kind: "mcp", id: "custom-mcp", sourceDigest: sha, subjectDigest: sha }, target: "codex", effect: "configure", integration: { owner: "organization-platform", version: "1.0.0" }, files: [{ path: ".codex/config.toml", sha256: sha }] };',
      "const bytes = Buffer.from(canonicalUpstreamArtifactManifestV1(manifest));",
      'if (parseUpstreamArtifactManifestV1Bytes(bytes)?.subject.id !== "custom-mcp") throw new Error("public parser rejected canonical manifest");',
      'if (parseUpstreamArtifactManifestV1Bytes(Buffer.from(`${bytes.toString("utf8")}\\n`)) !== undefined) throw new Error("public parser accepted noncanonical bytes");',
      "const require = createRequire(import.meta.url);",
      'const schemaPath = require.resolve("@aihq/core/schemas/aih-upstream-artifact-manifest-v1.schema.json");',
      'if (JSON.parse(readFileSync(schemaPath, "utf8")).title !== "aih-upstream-artifact-manifest-v1.schema.json") throw new Error("public schema unavailable");',
    ].join("\n"),
  );
  runNode(consumer, [resolve(consumer, "verify-public.mjs")]);

  for (const surface of [
    ["policy", "observe", "upstream-artifact", "--help"],
    ["policy", "lifecycle", "upstream-artifact", "--help"],
  ]) {
    const help = runInstalledCli(consumer, cli, bin, surface).stdout;
    for (const required of [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--manifest <path>",
      "--json",
    ])
      if (!help.includes(required))
        throw new Error(`cold-upstream-artifact-help:${surface.join(" ")}:${required}`);
  }

  for (const mode of ["observe", "lifecycle"]) {
    const args = [
      "policy",
      mode,
      "upstream-artifact",
      target,
      "--decision",
      "decision-custom-mcp",
      "--decision-digest",
      `sha256:${"b".repeat(64)}`,
      "--target",
      "codex",
      "--evidence",
      "evidence.json",
      "--manifest",
      "manifest.json",
      ...(mode === "lifecycle" ? ["--apply"] : []),
      "--json",
    ];
    const refused = runInstalledCli(target, cli, bin, args, true);
    if (!Number.isInteger(refused.status) || refused.status <= 0)
      throw new Error(`cold-upstream-artifact-unauthorized-${mode}-accepted`);
    if (!`${refused.stdout}\n${refused.stderr}`.includes("authority-unverified"))
      throw new Error(`cold-upstream-artifact-authority-boundary:${mode}`);
  }
  if (existsSync(resolve(target, ".aih", "governance", "upstream-artifact-lifecycle")))
    throw new Error("cold-upstream-artifact-refusal-wrote-lifecycle");

  process.stdout.write(
    "Cold packed organization-managed artifact pre-publication proof PASS (public parser, schema, and command surfaces used packed bytes; observe and explicit lifecycle apply refused without externally attested V3 organization authority; no successful custody, configuration, execution, or revocation is claimed)\n",
  );
} finally {
  const resolvedTemp = resolve(temp);
  if (!resolvedTemp.startsWith(`${tempBase}${sep}`)) throw new Error("unsafe-cold-proof-cleanup");
  rmSync(resolvedTemp, { force: true, recursive: true });
}
