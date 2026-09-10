import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertContained, isolatedEnvironment } from "./verify-governed-mcp-hosts.mjs";

test("child environment excludes credentials and leaves the caller unchanged", () => {
  const original = Object.freeze({ HOME: "private-home", CODEX_HOME: "private-codex", API_KEY: "private-key", PATH: "runtime-path", NODE_OPTIONS: "untrusted-loader", HTTP_PROXY: "private-proxy" });
  const isolated = isolatedEnvironment(join(tmpdir(), "fixture"), "test-nonce", original);
  assert.equal(original.CODEX_HOME, "private-codex");
  assert.equal(isolated.PATH, "runtime-path");
  for (const name of ["API_KEY", "NODE_OPTIONS", "HTTP_PROXY"]) assert.equal(isolated[name], undefined);
  assert.notEqual(isolated.HOME, original.HOME);
  assert.notEqual(isolated.CODEX_HOME, original.CODEX_HOME);
  assert.equal(isolated.AIH_MCP_FIXTURE_NONCE, "test-nonce");
});

test("cleanup containment rejects the root itself and paths outside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "aih-host-safety-"));
  const child = mkdtempSync(join(root, "child-"));
  try {
    assert.doesNotThrow(() => assertContained(root, child));
    assert.throws(() => assertContained(root, root), /containment/);
    assert.throws(() => assertContained(child, root), /containment/);
  } finally { assertContained(tmpdir(), root); rmSync(root, { recursive: true, force: true }); }
});

test("fixture records actual protocol methods and nonce equality without recording nonce values", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-host-fixture-"));
  const events = join(root, "events.jsonl");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./governed-mcp-fixture.mjs", import.meta.url)), events, "expected-test-value"], { env: { AIH_MCP_FIXTURE_NONCE: "expected-test-value" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((done) => child.on("close", done));
  try {
    child.stdin.end([
      { id: 1, method: "initialize", params: {} },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list", params: {} },
      { id: 3, method: "tools/call", params: { name: "fixture_probe" } },
    ].map((value) => JSON.stringify({ jsonrpc: "2.0", ...value })).join("\n") + "\n");
    assert.equal(await closed, 0);
    assert.match(output, /fixture_probe/);
    const raw = readFileSync(events, "utf8");
    assert.doesNotMatch(raw, /expected-test-value/);
    const methods = raw.trim().split("\n").map(JSON.parse);
    assert.ok(methods.every((event) => event.nonceVerified));
    assert.deepEqual(methods.map((event) => event.method), ["process/start", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
  } finally { child.kill(); assertContained(tmpdir(), root); rmSync(root, { recursive: true, force: true }); }
});
