import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashSourceTree } from "../../src/baseline-evidence/hash.js";

interface OwnedTestRoot {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
}

const roots: OwnedTestRoot[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeOwnedTestRoot(root);
});

function removeOwnedTestRoot(owned: OwnedTestRoot): void {
  const rootStat = lstatSync(owned.root);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.dev !== owned.dev ||
    rootStat.ino !== owned.ino
  )
    throw new Error("fixture root custody");
  const unlock = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("fixture source shape");
    if (!(process.platform === "win32" && stat.isDirectory())) {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino)
          throw new Error("fixture source custody");
        fchmodSync(descriptor, stat.isDirectory() ? 0o700 : 0o600);
      } finally {
        closeSync(descriptor);
      }
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) unlock(join(path, child));
      return;
    }
  };
  unlock(owned.root);
  rmSync(owned.root, { recursive: true, force: false, maxRetries: 2, retryDelay: 20 });
}

function fixture() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "aih-delivery-command-"));
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
    throw new Error("fixture root custody");
  roots.push({ root: parent, dev: parentStat.dev, ino: parentStat.ino });
  const source = join(parent, "source");
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "core.autocrlf", "false"]);
  symlinkSync(resolve("node_modules"), join(parent, "node_modules"), "junction");
  cpSync(resolve("src"), join(source, "src"), { recursive: true });
  cpSync(resolve("package.json"), join(source, "package.json"));
  mkdirSync(join(source, "tools"));
  cpSync(
    resolve("tools/prepare-aih-delivery-baseline-requests.mjs"),
    join(source, "tools/prepare-aih-delivery-baseline-requests.mjs"),
  );
  cpSync(resolve("aih-packs.json"), join(source, "aih-packs.json"));
  cpSync(resolve("packs"), join(source, "packs"), { recursive: true });
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=AIH test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { parent, source, commit };
}
function run(source: string, commit: string, output: string) {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(source, "tools/prepare-aih-delivery-baseline-requests.mjs"),
      "--source",
      source,
      "--core-commit",
      commit,
      "--output",
      output,
    ],
    { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: "pipe" },
  );
}
it("authors exact generated delivery material rather than scanning the source checkout", () => {
  const { parent, source, commit } = fixture();
  const output = join(parent, "requests");
  run(source, commit, output);
  const manifest = JSON.parse(readFileSync(join(output, "materialization.json"), "utf8"));
  const coverage = JSON.parse(readFileSync(join(output, "coverage.json"), "utf8"));
  const request = JSON.parse(readFileSync(join(output, "batch-001.request.json"), "utf8"));
  expect(manifest).toMatchObject({
    authority: "none",
    coreCommit: commit,
    sourceTreeSha256: hashSourceTree(manifest.sourceRoot).treeSha256,
    requestSha256s: [request.requestSha256],
  });
  expect(request.source.pinnedCommit).toBe(commit);
  expect(request.source.treeSha256).toBe(manifest.sourceTreeSha256);
  expect(request.components).toHaveLength(10);
  expect(coverage.components).toHaveLength(10);
  expect(manifest.sourceRoot).not.toBe(source);
  expect(execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" })).toBe(
    "",
  );
  expect(() => run(source, commit, output)).toThrow();
}, 30_000);
it("rejects revision mismatch and any output within the source checkout", () => {
  const { parent, source, commit } = fixture();
  const nested = join(source, "..looks-like-parent");
  expect(() => run(source, commit, nested)).toThrow(/outside the Core checkout/);
  expect(existsSync(nested)).toBe(false);
  const output = join(parent, "wrong-revision");
  expect(() => run(source, "0".repeat(40), output)).toThrow(/Core checkout revision/);
  expect(existsSync(join(output, "materialization.json"))).toBe(false);
  expect(() =>
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("tools/prepare-aih-delivery-baseline-requests.mjs"),
        "--source",
        source,
        "--core-commit",
        commit,
        "--output",
        join(parent, "different-helper"),
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: "pipe" },
    ),
  ).toThrow(/executing helper checkout/);
  const generator = join(source, "src/usage/capture.ts");
  writeFileSync(generator, `${readFileSync(generator, "utf8")}\n// uncommitted generator change\n`);
  const dirtyOutput = join(parent, "dirty-generator");
  expect(() => run(source, commit, dirtyOutput)).toThrow(/must be clean/);
  expect(existsSync(dirtyOutput)).toBe(false);
}, 30_000);
