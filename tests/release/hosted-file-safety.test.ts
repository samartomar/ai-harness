import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";

const bytesUrl = pathToFileURL(resolve(".github/public-policy-acceptance/bytes.mjs")).href;
const { regularBytes } = await import(bytesUrl);
const { archive } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/private-transport.mjs")).href
);
const output = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/hosted-run.mjs")).href
);
const fixtures: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "aih-hosted-file-safety-"));
  fixtures.push(root);
  return root;
};
afterAll(() => {
  const temp = realpathSync.native(tmpdir());
  for (const root of fixtures) {
    const stat = lstatSync(root),
      resolved = realpathSync.native(root),
      rel = relative(temp, resolved);
    expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
    expect(
      !isAbsolute(rel) && !rel.includes(sep) && /^aih-hosted-file-safety-[A-Za-z0-9]+$/u.test(rel),
    ).toBe(true);
    // Native rm removes symlink entries themselves; it does not traverse them.
    rmSync(resolved, { recursive: true, force: false });
  }
});

it("reads and archives exact regular bytes, including empty files, within byte limits", () => {
  const root = fixture();
  writeFileSync(join(root, "value.json"), "exact bytes");
  writeFileSync(join(root, "empty.json"), "");
  expect(regularBytes(join(root, "value.json"), 11).toString()).toBe("exact bytes");
  expect(regularBytes(join(root, "empty.json"), 0).length).toBe(0);
  expect(() => regularBytes(join(root, "value.json"), 10)).toThrow();
  const result = JSON.parse(gunzipSync(archive(root)).toString());
  expect(result.files.map((row: { path: string }) => row.path)).toEqual([
    "empty.json",
    "value.json",
  ]);
});

it("rejects native symbolic links, hardlinks and directories without changing their targets", () => {
  const root = fixture(),
    target = join(root, "target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, join(root, "symbolic"), "file");
  expect(() => regularBytes(join(root, "symbolic"))).toThrow();
  linkSync(target, join(root, "hard"));
  expect(() => regularBytes(join(root, "hard"))).toThrow();
  expect(() => regularBytes(root)).toThrow();
  expect(() => archive(root)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("unchanged");
});

it.each(["replace", "grow", "hardlink"])(
  "rejects a native %s race after the descriptor is opened",
  (mode) => {
    const root = fixture();
    const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const root=process.argv[1],mode=process.argv[2],file=join(root,'input');
    fs.writeFileSync(file,'original');fs.writeFileSync(join(root,'victim'),'outside');
    const {regularBytes}=await import(${JSON.stringify(bytesUrl)});
    const native=fs.readSync;let raced=false;
    fs.readSync=function(...args){if(!raced){raced=true;if(mode==='replace'){fs.renameSync(file,join(root,'old'));fs.symlinkSync(join(root,'victim'),file,'file');}else if(mode==='grow')fs.appendFileSync(file,'changed');else fs.linkSync(file,join(root,'added-link'));}return native(...args);};
    syncBuiltinESMExports();
    assert.throws(()=>regularBytes(file,64));assert(raced,'real descriptor read hook reached');
    assert.equal(fs.readFileSync(join(root,'victim'),'utf8'),'outside');
  `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root, mode], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);

it.skipIf(process.platform !== "linux")(
  "rejects a native FIFO without waiting for a writer",
  () => {
    const root = fixture(),
      path = join(root, "fifo");
    const created = spawnSync("mkfifo", [path], { encoding: "utf8", timeout: 5_000 });
    expect(created.status, created.stderr).toBe(0);
    const script = `import assert from 'node:assert/strict'; const {regularBytes}=await import(${JSON.stringify(bytesUrl)}); assert.throws(()=>regularBytes(process.argv[1]),/nonregular/u);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);

it("creates unique output directories and refuses existing files or symlinks with exclusive writes", () => {
  const parent = fixture();
  mkdirSync(join(parent, "aih-public-acceptance-output"));
  writeFileSync(join(parent, "aih-public-acceptance-output", "summary.json"), "existing");
  const first = output.createEvidenceOutput(parent),
    second = output.createEvidenceOutput(parent);
  expect(first).not.toBe(second);
  output.writeEvidenceOutput(first, "summary.json", "safe");
  expect(() => output.writeEvidenceOutput(first, "summary.json", "overwrite")).toThrow();
  const victim = join(parent, "victim");
  writeFileSync(victim, "unchanged");
  symlinkSync(victim, join(second, "summary.json"), "file");
  expect(() => output.writeEvidenceOutput(second, "summary.json", "overwrite")).toThrow();
  expect(() => output.writeEvidenceOutput(first, "../escape", "no")).toThrow();
  expect(existsSync(join(parent, "escape"))).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("unchanged");
});
