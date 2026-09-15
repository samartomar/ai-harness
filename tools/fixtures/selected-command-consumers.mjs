/** Public delivery of a synthetic source prepared by selected-command-source.ts. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
const fixtureRoot = process.argv[2];
if (!fixtureRoot || !isAbsolute(fixtureRoot)) throw Error("Expected absolute prepared fixture root");
const fixture = JSON.parse(readFileSync(join(fixtureRoot, "PREPARED.json"), "utf8"));
const consumerName = process.argv[3] ?? "consumers";
if (!/^[A-Za-z0-9_-]+$/.test(consumerName)) throw Error("Expected a simple disposable consumer directory name");
const consumers = join(fixtureRoot, consumerName);
if (existsSync(consumers)) throw Error("Disposable consumers already exist");
mkdirSync(consumers);
const home = join(consumers, "operator-home"); mkdirSync(home);
const cli = resolve("dist/cli.js"), targets = "claude,codex,cursor,kimi";
const env = { ...process.env, HOME: home, USERPROFILE: home, AIH_WORKBENCH_DATA: fixture.store, AIH_WORKBENCH_VERIFIER_HOME: fixture.verifier };
delete env.AIH_ORG_POLICY;
delete env.Path;
env.PATH = `${fixture.bin}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
const report = { status: "failed", fixture: { ...fixture, descriptor: undefined }, commands: [], roots: [] };
const save = () => writeFileSync(join(consumers, "RESULT.json"), JSON.stringify(report, null, 2) + "\n");
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ binary, args, cwd, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }); save();
  if (result.status !== 0) throw Error(`Public fixture command failed: ${args.slice(0, 3).join(" ")}: ${result.stderr || result.stdout}`);
  return result;
}
for (const [name, skill] of [["Harbor", "tdd-workflow"], ["Cedar", "security-review"]]) {
  const root = join(consumers, name); mkdirSync(root);
  const policy = JSON.parse(readFileSync(join(fixtureRoot, `${name}-policy-v2.json`), "utf8"));
  if (policy.schemaVersion !== 3) throw Error("Expected a Core-compiled schema-v3 source policy");
  writeFileSync(join(root, "aih-org-policy.json"), JSON.stringify(policy, null, 2) + "\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: `fictional-${name.toLowerCase()}`, private: true, type: "module" }) + "\n");
  mkdirSync(join(root, "notes")); writeFileSync(join(root, "notes", "OWNERSHIP.md"), `Fictional ${name}; preserve this operator-owned file.\n`);
  const customPaths = [join(root, "package.json"), join(root, "notes/OWNERSHIP.md")];
  const before = customPaths.map(hash);
  for (const args of [["init", "-q"], ["config", "user.name", "Fictional Lane 5"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-qm", "Fictional command adopter policy"]]) run("git", args, root);
  const invoke = args => run(process.execPath, [cli, ...args], root);
  invoke(["policy", "bind", "--root", root, "--policy", join(root, "aih-org-policy.json"), "--project", `fictional-commands-${name.toLowerCase()}`, "--cli", targets, "--apply", "--json", "--no-log"]);
  invoke(["policy", "project", root, "--posture", "enterprise", "--cli", targets, "--ecc-path", fixture.source, "--apply", "--force", "--json", "--no-log"]);
  const init = ["init", root, "--posture", "enterprise", "--cli", targets, "--ecc-path", fixture.source, "--apply", "--force", "--json", "--no-log"];
  invoke(init); invoke(init);
  const receipt = JSON.parse(readFileSync(join(root, ".aih/ecc/materialization-v1.json"), "utf8"));
  for (const id of [`skill:${skill}`, "baseline:commands", "module:commands-core"])
    if (!receipt.components.some(item => item.id === id && item.files.length)) throw Error(`Missing delivered ${id}`);
  if (JSON.stringify(before) !== JSON.stringify(customPaths.map(hash))) throw Error("Operator files changed");
  if (JSON.parse(readFileSync(join(root, "scripts/package.json"))).type !== "commonjs") throw Error("Command runtime boundary missing");
  const audit = run(process.execPath, ["scripts/harness-audit.js", "repo", "--format", "json"], root);
  JSON.parse(audit.stdout);
  report.roots.push({ root, name, skill, receipt, customPreserved: true, repeatApply: true, commandRuntimeExecuted: true }); save();
}
report.status = "passed"; save();
