import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const toolUrl = pathToFileURL(join(process.cwd(), "tools", "verify-codex-mcp-runtime.mjs")).href;
const fixtureUrl = pathToFileURL(join(process.cwd(), "tools", "codex-runtime-fixture.mjs")).href;
const producer = await import(toolUrl);
const { fixtureReply } = await import(fixtureUrl);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const canonicalPath = realpathSync.native;

function fakeClient(
  root: string,
  nonce: string,
  change:
    | "none"
    | "root"
    | "canary"
    | "policy"
    | "discovery"
    | "extra-server"
    | "normalized-defaults"
    | "malformed" = "none",
) {
  const configPath = join(root, "home", ".codex", "config.toml");
  const slash = (value: string): string => value.replaceAll("\\", "/");
  const fixture = join(process.cwd(), "tools", "codex-runtime-fixture.mjs");
  const expectedServer = {
    command: slash(process.execPath),
    args: [slash(fixture), nonce],
    cwd: slash(root),
    enabled: true,
    required: true,
  };
  const layer = {
    name: { type: "user", file: configPath, profile: null },
    version: "1",
    disabledReason: null,
    config: {
      approval_policy: "never",
      sandbox_mode: "read-only",
      mcp_servers: { fixture: expectedServer },
    },
  };
  const requests: string[] = [];
  const notifications: string[] = [];
  return {
    requests,
    notifications,
    notify(method: string) {
      notifications.push(method);
    },
    async request(method: string) {
      requests.push(method);
      if (method === "initialize") return {};
      if (method === "config/read") {
        const servers =
          change === "extra-server"
            ? { fixture: expectedServer, foreign: { command: "foreign" } }
            : { fixture: expectedServer };
        const effectiveServers =
          change === "normalized-defaults"
            ? { fixture: { ...expectedServer, environment_id: "local", tool_timeout_sec: null } }
            : servers;
        return {
          config: {
            approval_policy: "never",
            sandbox_mode: "read-only",
            mcp_servers: effectiveServers,
          },
          layers: [layer],
        };
      }
      if (method === "thread/start")
        return {
          thread: { id: "thread-one" },
          cwd: change === "root" ? dirname(root) : root,
          approvalPolicy: "never",
          sandbox: { type: "readOnly", networkAccess: change === "policy" },
        };
      if (method === "mcpServerStatus/list")
        return {
          data: [
            {
              name: "fixture",
              runtimeStatus: "connected",
              tools: change === "discovery" ? {} : { fixture_probe: { name: "fixture_probe" } },
            },
          ],
        };
      if (method === "mcpServer/tool/call")
        return {
          isError: false,
          content:
            change === "malformed"
              ? [
                  { type: "text", text: "{}" },
                  { type: "text", text: "{}" },
                ]
              : [
                  {
                    type: "text",
                    text: JSON.stringify({
                      fixture: true,
                      nonce: change === "canary" ? "wrong" : nonce,
                      root,
                    }),
                  },
                ],
        };
      throw new Error("unexpected request");
    },
  };
}

function retainedObservation(
  root: string,
  configPath: string,
  executable: string,
  version: string,
  nonce: string,
  now: Date,
) {
  const fixture = join(process.cwd(), "tools", "codex-runtime-fixture.mjs");
  return {
    schemaVersion: 1,
    kind: "aih-mcp-runtime-observation",
    client: {
      targetCli: "codex",
      executable,
      version,
      sha256: sha(readFileSync(executable)),
    },
    target: {
      canonicalRoot: root,
      configPath: canonicalPath(configPath),
      configSha256: sha(readFileSync(configPath)),
    },
    policy: { approvalPolicy: "never", sandbox: "readOnly", networkAccess: false },
    server: {
      name: "fixture",
      fixtureIdentity: `sha256:${sha(readFileSync(fixture))}`,
      runtimeIdentity: `sha256:${sha(readFileSync(process.execPath))}`,
    },
    invocation: { tool: "fixture_probe", argumentsSha256: sha("{}") },
    observedAt: new Date(now.getTime() - 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    support: { nativeClientStarted: true, configuredServerRecognized: true },
    discovery: { serverConnected: true, tool: "fixture_probe", toolListed: true },
    operation: { expectedCanary: nonce, actualCanary: nonce, succeeded: true, sessionId: "one" },
    restart: {
      actualCanary: nonce,
      succeeded: true,
      sessionId: "two",
      observedAt: now.toISOString(),
    },
  };
}

describe("bounded Codex MCP runtime producer", () => {
  it("strictly parses flags", () => {
    const report = join(tmpdir(), "evidence.json");
    expect(producer.parseArgs(["--report", report, "--check"])).toEqual({
      report,
      binary: undefined,
      check: true,
    });
    expect(() => producer.parseArgs(["--report", "relative.json"])).toThrow(/absolute/);
    expect(() =>
      producer.parseArgs(["--report", report, "--report", join(tmpdir(), "other.json")]),
    ).toThrow(/duplicate/);
    expect(() => producer.parseArgs(["--report", report, "--unknown"])).toThrow(/unsupported/);
    expect(() => producer.parseArgs(["--report", report, "--codex-binary"])).toThrow(/missing/);
  });

  it("accepts a renamed native binary header and refuses a script shim", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-native-header-"));
    const native = join(root, "renamed.bin");
    const shim = join(root, "codex.cmd");
    writeFileSync(native, Buffer.from([0x4d, 0x5a, 0, 0]));
    writeFileSync(shim, "@echo off\n");
    expect(producer.resolveCodexBinary(native)).toBe(canonicalPath(native));
    expect(producer.resolveCodexBinary(shim)).toBeUndefined();
  });

  it("rejects non-object protocol messages before dispatch", () => {
    expect(() => producer.parseProtocolLine("null")).toThrow(/invalid-json-message/);
    expect(() => producer.parseProtocolLine("[]")).toThrow(/invalid-json-message/);
    expect(() => producer.parseProtocolLine("not-json")).toThrow(/invalid-json/);
    expect(producer.parseProtocolLine('{"id":1,"result":{}}')).toEqual({ id: 1, result: {} });
  });

  it("rejects directories and FIFO-shaped stats before opening a native candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-native-path-"));
    expect(producer.nativeHeader(root)).toBe(false);
    expect(
      producer.isRegularNonSymlink({
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
    ).toBe(false);
  });

  it("reads material through a bounded regular-file descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-safe-material-"));
    const material = join(root, "material.bin");
    writeFileSync(material, "abcde");
    expect(producer.safeBytes(material, 5)).toEqual(Buffer.from("abcde"));
    expect(() => producer.safeBytes(material, 4)).toThrow("unsafe-material-file");
    expect(() => producer.safeBytes(root, 5)).toThrow("unsafe-material-file");
  });

  it("writes the fixed private config and strips credentials from child env", () => {
    const text = producer.configText("C:\\node.exe", "nonce", "C:\\root");
    expect(text).toContain('approval_policy = "never"');
    expect(text).toContain('sandbox_mode = "read-only"');
    expect(text).toContain("required = true");
    expect(text).toContain('cwd = "C:/root"');
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-isolated-env-")));
    const env = producer.isolatedEnvironment(root, {
      PATH: "C:\\bin",
      OPENAI_API_KEY: "no",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe(join(root, "home", ".codex"));
  });

  it("fixture handler returns its real root and nonce without policy claims", () => {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-fixture-unit-")));
    const reply = fixtureReply(
      { id: 1, method: "tools/call", params: { name: "fixture_probe", arguments: {} } },
      "nonce",
      root,
    );
    const proof = JSON.parse(reply.content[0].text);
    expect(proof).toEqual({ fixture: true, nonce: "nonce", root });
    expect(proof).not.toHaveProperty("readOnly");
    expect(fixtureReply({ id: 2, method: "other" }, "nonce", root)).toHaveProperty(
      "error.code",
      -32601,
    );
  });

  it("uses the supported protocol shapes and verifies effective config before thread start", async () => {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-client-unit-")));
    mkdirSync(join(root, "home", ".codex"), { recursive: true });
    writeFileSync(join(root, "home", ".codex", "config.toml"), "fixture");
    const client = fakeClient(root, "nonce");
    const result = await producer.exerciseClient(client, root, "nonce");
    expect(result).toMatchObject({
      threadId: "thread-one",
      actualCanary: "nonce",
      policy: { approvalPolicy: "never", sandbox: "readOnly", networkAccess: false },
    });
    expect(client.notifications).toEqual(["initialized"]);
    expect(client.requests).toEqual([
      "initialize",
      "config/read",
      "thread/start",
      "mcpServerStatus/list",
      "mcpServer/tool/call",
    ]);
  });

  it("accepts Codex's known normalized effective-server defaults", async () => {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-defaults-unit-")));
    mkdirSync(join(root, "home", ".codex"), { recursive: true });
    writeFileSync(join(root, "home", ".codex", "config.toml"), "fixture");
    await expect(
      producer.exerciseClient(fakeClient(root, "nonce", "normalized-defaults"), root, "nonce"),
    ).resolves.toMatchObject({ actualCanary: "nonce" });
  });

  it.each(["root", "canary", "policy", "discovery", "extra-server", "malformed"] as const)(
    "refuses a %s mismatch",
    async (change) => {
      const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-refuse-unit-")));
      mkdirSync(join(root, "home", ".codex"), { recursive: true });
      writeFileSync(join(root, "home", ".codex", "config.toml"), "fixture");
      const client = fakeClient(root, "nonce", change);
      await expect(producer.exerciseClient(client, root, "nonce")).rejects.toThrow();
      if (change === "extra-server") expect(client.requests).toEqual(["initialize", "config/read"]);
    },
  );

  it("marks a retained observation stale after its actual config bytes change", () => {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-recheck-unit-")));
    const home = join(root, "home", ".codex");
    mkdirSync(home, { recursive: true });
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, "before");
    const now = new Date();
    const observation = retainedObservation(
      root,
      configPath,
      canonicalPath(process.execPath),
      process.versions.node,
      "nonce",
      now,
    );
    const reportPath = join(root, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        kind: "aih-codex-mcp-runtime-report",
        status: "passed",
        observation,
        evaluation: {},
        modelTurns: 0,
        fixtureRoot: root,
      }),
    );
    writeFileSync(configPath, "after");
    expect(producer.checkRetainedReport(reportPath, now.toISOString())).toMatchObject({
      status: "failed",
      evaluation: { recordState: "stale" },
      failureCode: "observation-not-current",
    });
  });

  it("rechecks a retained report without launching its recorded executable or remeasuring its version", () => {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), "aih-recheck-no-launch-")));
    const home = join(root, "home", ".codex");
    mkdirSync(home, { recursive: true });
    const configPath = join(home, "config.toml");
    const nonce = "nonce";
    writeFileSync(configPath, producer.configText(process.execPath, nonce, root));
    const executable = join(root, "recorded-only.bin");
    writeFileSync(executable, Buffer.from([0x4d, 0x5a, 0, 0]));
    const now = new Date();
    const observation = retainedObservation(
      root,
      configPath,
      executable,
      "historical-version",
      nonce,
      now,
    );
    const reportPath = join(root, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        kind: "aih-codex-mcp-runtime-report",
        status: "passed",
        observation,
        evaluation: {},
        modelTurns: 0,
        fixtureRoot: root,
      }),
    );
    expect(producer.checkRetainedReport(reportPath, now.toISOString())).toMatchObject({
      status: "passed",
      observation: { client: { version: "historical-version" } },
      recheckScope: expect.stringContaining("does not launch"),
    });
  });
});
