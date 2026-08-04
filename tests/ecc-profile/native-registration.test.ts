import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNativeEccRegistration,
  NATIVE_ECC_REGISTRATION_RECEIPT,
  nativeRegistrationFiles,
  planInstalledNativeEccRegistration,
  planNativeEccRegistration,
} from "../../src/ecc-profile/native-registration.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-ecc-native-registration-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-native-state-"));
  roots.push(root, stateRoot);
  const runtimeRoot = join(stateRoot, "runtime");
  mkdirSync(runtimeRoot);
  const executable = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  const cliScript = join(runtimeRoot, "cli.js");
  writeFileSync(executable, "node fixture", { mode: 0o755 });
  writeFileSync(cliScript, "cli fixture\n");
  return { root, stateRoot, executable, cliScript };
}

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

describe("native ECC registration", () => {
  it("renders one composite native hook per supported event and four selected MCPs", () => {
    const input = fixture();
    const registration = buildNativeEccRegistration(input);

    expect(Object.keys(registration.hooks.claude.hooks)).toEqual([
      "SessionStart",
      "SessionEnd",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PostCompact",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Notification",
      "Stop",
    ]);
    expect(Object.keys(registration.hooks.codex.hooks)).not.toContain("Notification");
    for (const groups of Object.values(registration.hooks.claude.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks).toHaveLength(1);
    }
    expect(Object.keys(registration.mcp.claude.mcpServers)).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "context7",
      "serena",
    ]);
    expect(registration.mcp.disabled).toEqual([
      "ecc-memory-mcp",
      "github",
      "sequential-thinking",
      "token-savior",
    ]);
  });

  it("binds launchers to opened regular-file bytes and isolated state outside the project", () => {
    const input = fixture();
    const registration = buildNativeEccRegistration(input);
    expect(registration.runtime.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registration.runtime.cliScript.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registration.runtime.executable.path).toBe(input.executable);
    expect(registration.runtime.cliScript.path).toBe(input.cliScript);
    expect(registration.stateRoot.startsWith(input.root)).toBe(false);
    expect(JSON.stringify(registration)).not.toContain("prepared-not-registered");
  });

  it("produces deterministic field-owned registration fragments without claiming whole shared files", () => {
    const input = fixture();
    const registration = buildNativeEccRegistration(input);
    const first = nativeRegistrationFiles(registration);
    const second = nativeRegistrationFiles(buildNativeEccRegistration(input));

    expect(first).toEqual(second);
    expect(first.map((file) => [file.destination, file.ownership])).toEqual([
      [".claude/settings.json", "json-array-children"],
      [".mcp.json", "json-object-children"],
      [".codex/hooks.json", "json-array-children"],
      [".codex/config.toml", "toml-block"],
    ]);
  });

  it("installs idempotently and uninstalls field-owned config without losing operator entries", async () => {
    const input = fixture();
    mkdirSync(join(input.root, ".claude"));
    mkdirSync(join(input.root, ".codex"));
    writeFileSync(
      join(input.root, ".claude", "settings.json"),
      `${JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "operator" }] }] } }, null, 2)}\n`,
    );
    writeFileSync(
      join(input.root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { operator: { command: "operator", args: [] } } }, null, 2)}\n`,
    );
    writeFileSync(join(input.root, ".codex", "config.toml"), 'model = "operator-model"\n');
    writeFileSync(
      join(input.root, ".codex", "hooks.json"),
      `${JSON.stringify({ description: "operator", hooks: { Stop: [{ hooks: [{ type: "command", command: "operator" }] }] } }, null, 2)}\n`,
    );
    const registration = buildNativeEccRegistration(input);

    await executePlan(
      planNativeEccRegistration(input.root, registration, "install"),
      context(input.root),
    );
    expect(planNativeEccRegistration(input.root, registration, "install").actions).toEqual([]);
    expect(readFileSync(join(input.root, ".claude", "settings.json"), "utf8")).toContain(
      '"theme": "dark"',
    );
    expect(readFileSync(join(input.root, ".mcp.json"), "utf8")).toContain('"operator"');
    expect(readFileSync(join(input.root, ".codex", "config.toml"), "utf8")).toContain(
      "operator-model",
    );
    expect(readFileSync(join(input.root, ".codex", "hooks.json"), "utf8")).toContain('"operator"');
    expect(existsSync(join(input.root, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(true);

    await executePlan(
      planNativeEccRegistration(input.root, registration, "uninstall"),
      context(input.root),
    );
    expect(readFileSync(join(input.root, ".claude", "settings.json"), "utf8")).toContain(
      '"theme": "dark"',
    );
    expect(readFileSync(join(input.root, ".claude", "settings.json"), "utf8")).not.toContain(
      "AIH ECC",
    );
    expect(readFileSync(join(input.root, ".mcp.json"), "utf8")).toContain('"operator"');
    expect(readFileSync(join(input.root, ".mcp.json"), "utf8")).not.toContain("code-review-graph");
    expect(readFileSync(join(input.root, ".codex", "config.toml"), "utf8")).toBe(
      'model = "operator-model"\n',
    );
    expect(readFileSync(join(input.root, ".codex", "hooks.json"), "utf8")).toContain('"operator"');
    expect(existsSync(join(input.root, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(false);
  });

  it("fails closed on conflicting MCP ownership and modified managed hook entries", async () => {
    const input = fixture();
    writeFileSync(
      join(input.root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { serena: { command: "operator-serena" } } }, null, 2)}\n`,
    );
    const registration = buildNativeEccRegistration(input);
    expect(() => planNativeEccRegistration(input.root, registration, "install")).toThrow(
      /serena.*owned|ownership.*serena|conflict/i,
    );

    rmSync(join(input.root, ".mcp.json"));
    await executePlan(
      planNativeEccRegistration(input.root, registration, "install"),
      context(input.root),
    );
    const settings = join(input.root, ".claude", "settings.json");
    writeFileSync(settings, readFileSync(settings, "utf8").replace("AIH ECC", "tampered ECC"));
    expect(() => planNativeEccRegistration(input.root, registration, "uninstall")).toThrow(
      /modified|missing.*managed|contradict/i,
    );
  });

  it("rejects a self-hashed receipt whose managed fragments contradict the native policy", async () => {
    const input = fixture();
    const registration = buildNativeEccRegistration(input);
    await executePlan(
      planNativeEccRegistration(input.root, registration, "install"),
      context(input.root),
    );

    const receiptPath = join(input.root, NATIVE_ECC_REGISTRATION_RECEIPT);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      files: Array<{ destination: string; content: string; normalizedSha256: string }>;
    };
    const mcp = receipt.files.find((file) => file.destination === ".mcp.json");
    if (!mcp) throw new Error("fixture receipt is missing its MCP fragment");
    mcp.content = `${JSON.stringify({ mcpServers: { operator: { command: "forged" } } }, null, 2)}\n`;
    mcp.normalizedSha256 = createHash("sha256").update(mcp.content).digest("hex");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(input.root, ".mcp.json"), mcp.content);

    expect(() => planInstalledNativeEccRegistration(input.root, "uninstall")).toThrow(
      /receipt.*policy|contradict/i,
    );
  });

  it("fails closed on malformed shared config and absent or foreign ownership state", async () => {
    const absent = fixture();
    expect(planInstalledNativeEccRegistration(absent.root, "uninstall").actions).toEqual([]);
    expect(() => planInstalledNativeEccRegistration(absent.root, "repair")).toThrow(
      /requires an ownership receipt/i,
    );

    const malformed = fixture();
    writeFileSync(join(malformed.root, ".mcp.json"), "[]\n");
    expect(() =>
      planNativeEccRegistration(malformed.root, buildNativeEccRegistration(malformed), "install"),
    ).toThrow(/JSON must be an object/i);

    const conflicting = fixture();
    writeFileSync(join(conflicting.root, ".mcp.json"), '{"mcpServers":"operator"}\n');
    expect(() =>
      planNativeEccRegistration(
        conflicting.root,
        buildNativeEccRegistration(conflicting),
        "install",
      ),
    ).toThrow(/ownership conflicts/i);

    const installed = fixture();
    const registration = buildNativeEccRegistration(installed);
    await executePlan(
      planNativeEccRegistration(installed.root, registration, "install"),
      context(installed.root),
    );
    const receiptPath = join(installed.root, NATIVE_ECC_REGISTRATION_RECEIPT);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { stateRoot: string };
    receipt.stateRoot = ".relative-state";
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => planInstalledNativeEccRegistration(installed.root, "uninstall")).toThrow(
      /relative state root/i,
    );
  });

  it("canonicalizes a future external state directory without creating it during planning", () => {
    const input = fixture();
    const future = join(input.stateRoot, "future", "nested");
    const registration = buildNativeEccRegistration({ ...input, stateRoot: future });
    expect(registration.stateRoot).toBe(future);
    expect(existsSync(future)).toBe(false);
  });

  it("updates runtime-bound registrations and repairs missing managed files from the receipt", async () => {
    const input = fixture();
    const first = buildNativeEccRegistration(input);
    await executePlan(planNativeEccRegistration(input.root, first, "install"), context(input.root));

    writeFileSync(input.cliScript, "updated cli fixture\n");
    const next = buildNativeEccRegistration(input);
    expect(next.runtime.cliScript.sha256).not.toBe(first.runtime.cliScript.sha256);
    await executePlan(planNativeEccRegistration(input.root, next, "update"), context(input.root));
    expect(readFileSync(join(input.root, NATIVE_ECC_REGISTRATION_RECEIPT), "utf8")).toContain(
      next.runtime.cliScript.sha256,
    );

    rmSync(join(input.root, ".codex", "hooks.json"));
    await executePlan(planNativeEccRegistration(input.root, next, "repair"), context(input.root));
    expect(readFileSync(join(input.root, ".codex", "hooks.json"), "utf8")).toContain(
      "Running AIH ECC profile policies",
    );
  });

  it("rejects project-contained state, linked launchers, and mutable or ambiguous runtime paths", () => {
    const input = fixture();
    expect(() => buildNativeEccRegistration({ ...input, root: "." })).toThrow(/root.*absolute/i);
    expect(() => buildNativeEccRegistration({ ...input, stateRoot: ".state" })).toThrow(
      /state.*absolute/i,
    );
    const containedState = join(input.root, ".aih");
    mkdirSync(containedState);
    expect(() => buildNativeEccRegistration({ ...input, stateRoot: containedState })).toThrow(
      /state.*outside/i,
    );

    const linked = fixture();
    const link = join(linked.stateRoot, "linked-cli.js");
    try {
      // Windows requires Developer Mode or elevation; the production rejection is covered where available.
      symlinkSync(linked.cliScript, link, "file");
      expect(() => buildNativeEccRegistration({ ...linked, cliScript: link })).toThrow(
        /link|regular/i,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    expect(() => buildNativeEccRegistration({ ...input, executable: "node" })).toThrow(/absolute/i);
    expect(() => buildNativeEccRegistration({ ...input, cliScript: input.executable })).toThrow(
      /distinct|ambiguous/i,
    );
    writeFileSync(join(input.root, "runtime.js"), "contained runtime\n");
    expect(() =>
      buildNativeEccRegistration({ ...input, cliScript: join(input.root, "runtime.js") }),
    ).toThrow(/runtime.*outside/i);
  });
});
