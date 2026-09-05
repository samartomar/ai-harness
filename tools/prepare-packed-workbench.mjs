import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/** A cold package consumer: no product command ever targets the source checkout. */
export function preparePackedWorkbench(directory) {
  const target = resolve(directory);
  const npmCandidate = process.env.npm_execpath?.replace(/npx-cli\.js$/u, "npm-cli.js");
  const npmCli = npmCandidate && existsSync(npmCandidate) ? npmCandidate
    : resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(npmCli)) throw new Error("npm CLI is unavailable for the packed Workbench smoke");
  function run(cwd, args) {
    const environment = { ...process.env };
    delete environment.AIH_ORG_POLICY;
    delete environment.AIH_POLICY_AUTHORITY_REPOSITORY;
    delete environment.AIH_POLICY_AUTHORITY_WORKFLOW;
    const result = spawnSync(process.execPath, args, {
      cwd, env: environment, encoding: "utf8", windowsHide: true, timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Packed Workbench fixture failed: " + (result.stderr || result.stdout).slice(0, 1000));
    return result.stdout;
  }
  const manifest = JSON.parse(run(process.cwd(), [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", target]));
  const entry = manifest?.[0];
  if (entry?.name !== "@aihq/core" || typeof entry.filename !== "string" || basename(entry.filename) !== entry.filename)
    throw new Error("Unexpected packed Core manifest");
  const paths = entry.files.map(file => file.path);
  if (!paths.includes("dist/bundle.generated.cjs")) throw new Error("Packed Core is missing the browser bundle");
  if (paths.includes("aih-packs.json")) throw new Error("Removed aih-packs.json leaked into the package");
  const consumer = resolve(target, "packed-consumer");
  const admin = resolve(target, "packed-administrator");
  mkdirSync(consumer); mkdirSync(admin);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"workbench-packed-consumer","private":true}\n');
  run(consumer, [npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", resolve(target, entry.filename)]);
  const cli = resolve(consumer, "node_modules/@aihq/core/dist/cli.js");
  if (!cli.startsWith(target + sep) || !existsSync(cli)) throw new Error("Invalid packed Core CLI");
  const organizationManifest = resolve(admin, "organization-manifest.json");
  writeFileSync(organizationManifest, JSON.stringify({
    version: "organization-authoring-manifest/v1",
    source: { id: "source:packed-organization", revisionId: "revision:1", locator: "acme/portable-inputs" },
    assets: [
      { id: "mcp:packed", kind: "mcp", label: "Packed organization MCP", path: "mcp/packed.json" },
      { id: "skill:packed", kind: "skill", label: "Packed organization skill", path: "skills/packed/SKILL.md" },
      { id: "agent:packed", kind: "agent", label: "Packed organization agent", path: "agents/packed.md", requires: ["skill:packed"] },
    ],
  }) + "\n");
  const output = resolve(target, "packed-policy-workbench.html");
  const argumentsFor = out => [cli, "policy", "generate", "--apply", "--out", out, "--organization-manifest", organizationManifest];
  run(admin, argumentsFor(output));
  const repeated = resolve(target, "packed-policy-workbench-repeat.html");
  run(admin, argumentsFor(repeated));
  if (!readFileSync(output).equals(readFileSync(repeated))) throw new Error("Identical pinned inputs generated different offline artifact bytes");
  if (!existsSync(output)) throw new Error("Installed Core did not generate its Workbench");
  return { output, packageIntegrity: entry.integrity };
}
