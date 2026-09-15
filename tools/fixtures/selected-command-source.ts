/** Disposable qualified command source. Scanner/GitHub observations are synthetic;
 * compiler hashing, signature replay, public import, binding and delivery are real.
 * node --import tsx tools/fixtures/selected-command-source.ts SOURCE NEW_OUTPUT
 */
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { prepareSourceDataScannerRuntimeFactsV1 } from "../../src/org-policy/workbench/core/source-data-scanner.js";
import { scannerBaselineSourceFixtureV1 } from "../../tests/org-policy/workbench/source-data-scanner-fixture.js";

const [upstream, output] = process.argv.slice(2);
if (!upstream || !output || !isAbsolute(upstream) || !isAbsolute(output) || existsSync(output))
  throw new Error("Expected absolute source and new disposable output directory");
mkdirSync(output, { recursive: true });
const source = join(output, "source"), store = join(output, "store"), bin = join(output, "bin");
for (const path of [source, store, bin]) mkdirSync(path);
const write = (path: string, value: string) => writeFileSync(path, value, { flag: "wx", mode: 0o600 });
const json = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2) + "\n");
const commands: unknown[] = [];
const env = { ...process.env, AIH_WORKBENCH_DATA: store, AIH_WORKBENCH_VERIFIER_HOME: join(output, "verifier"), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
delete env.AIH_ORG_POLICY;
if (process.platform === "win32") { delete env.Path; env.PATH = `${bin};${process.env.Path ?? process.env.PATH ?? ""}`; }
function run(binary: string, args: string[], cwd = output) {
  const result = spawnSync(binary, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  commands.push({ binary, args, cwd, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  writeFileSync(join(output, "COMMANDS.json"), JSON.stringify(commands, null, 2) + "\n");
  if (result.status !== 0) throw new Error(`Fixture command failed: ${args.slice(0, 3).join(" ")}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
for (const path of ["LICENSE", "scripts/harness-audit.js", "scripts/skills-health.js", "scripts/lib", "commands/harness-audit.md", "skills/tdd-workflow", "skills/security-review"]) {
  mkdirSync(join(source, path, ".."), { recursive: true });
  cpSync(join(upstream, path), join(source, path), { recursive: true, errorOnExist: true, force: false });
}
for (const args of [["init", "-q"], ["config", "user.name", "Fictional Lane 5"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-qm", "Synthetic complete command closure for native acceptance"]]) run("git", args, source);
const commit = run("git", ["rev-parse", "HEAD"], source);
const closure = ["commands", "scripts/harness-audit.js", "scripts/skills-health.js", "scripts/lib"];
const compilerInput = { version: "pinned-baseline/v1", framework: { id: "ecc", repository: "affaan-m/ECC", commit, assets: [
  ...["tdd-workflow", "security-review"].map(name => ({ id: `skill:${name}`, kind: "skill", source: { repository: "affaan-m/ECC", commit, path: `skills/${name}` }, sourcePaths: [`skills/${name}`] })),
  ...["baseline:commands", "module:commands-core"].map(id => ({ id, kind: id.split(":")[0], ...(id === "baseline:commands" ? { dependencies: ["module:commands-core"] } : {}), source: { repository: "affaan-m/ECC", commit, path: "commands" }, sourcePaths: closure })),
] } };
const timestamp = new Date().toISOString();
const fixture = scannerBaselineSourceFixtureV1(source, compilerInput, timestamp);
json(join(output, "compiler-input.json"), compilerInput);
json(join(output, "scanner-proof.json"), fixture.proof);
const resultBase64 = Buffer.from(fixture.attestationResult).toString("base64");
if (process.platform === "win32") {
  const cs = join(bin, "gh.cs");
  write(cs, `using System; using System.Text; public static class Gh { public static int Main(string[] args) { if(args.Length < 3 || args[0] != "attestation" || args[1] != "verify") return 64; Console.WriteLine(Encoding.UTF8.GetString(Convert.FromBase64String("${resultBase64}"))); return 0; } }`);
  run(join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", `/out:${join(bin, "gh.exe")}`, cs]);
} else {
  write(join(bin, "gh"), `#!/usr/bin/env node\nprocess.stdout.write(Buffer.from('${resultBase64}','base64').toString());\n`);
  run("chmod", ["700", join(bin, "gh")]);
}
// Scope the in-process reconstruction to the same disposable transport/store.
if (process.platform === "win32") delete process.env.Path;
process.env.PATH = env.PATH;
process.env.AIH_WORKBENCH_DATA = store;
process.env.AIH_WORKBENCH_VERIFIER_HOME = env.AIH_WORKBENCH_VERIFIER_HOME;
const facts = await prepareSourceDataScannerRuntimeFactsV1(fixture.bundle, fixture.proof, source, timestamp, [fixture.proof.publisherCommit], timestamp);
const bundle = structuredClone(fixture.bundle);
bundle.evidence = facts.evidence;
bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
json(join(output, "bundle.json"), bundle);
const sourceId = Object.keys(bundle.sources)[0]!;
const keys = generateKeyPairSync("ed25519");
const keyId = createHash("sha256").update(keys.publicKey.export({ format: "der", type: "spki" })).digest("hex");
write(join(output, "fixture-signing-key.pem"), keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
json(join(store, "trust.json"), { version: 1, authorities: [{ keyId, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), role: "workbench-source-data/v1", sources: [sourceId], scannerPublisherCommits: [fixture.proof.publisherCommit], catalogPublisherCommits: ["c".repeat(40)] }] });
const cli = resolve("dist/cli.js");
const invoke = (args: string[], cwd = source) => run(process.execPath, [cli, ...args], cwd);
invoke(["policy", "data", "prepare", "--source", sourceId, "--source-bundle", join(output, "bundle.json"), "--scanner-proof", join(output, "scanner-proof.json"), "--sequence", "1", "--out", join(output, "payload.json"), "--apply"]);
invoke(["policy", "data", "sign", "--input", join(output, "payload.json"), "--key", join(output, "fixture-signing-key.pem"), "--trust", join(store, "trust.json"), "--out", join(output, "signed.json"), "--apply"]);
invoke(["policy", "data", "import", "--input", join(output, "signed.json"), "--store", store, "--scanner-source", source, "--apply"]);
json(join(output, "PREPARED.json"), { source, commit, sourceId, store, verifier: env.AIH_WORKBENCH_VERIFIER_HOME, bin, descriptor: facts.descriptor, simulation: "Ephemeral synthetic Scanner observations and GitHub attestation transport; not an upstream qualification or production trust root", status: "imported" });
