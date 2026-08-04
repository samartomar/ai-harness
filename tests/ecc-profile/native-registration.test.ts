import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  // macOS exposes /var as a system alias; production registration stores canonical paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-ecc-native-registration-")));
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "aih-ecc-native-state-")));
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

    const invalidJson = fixture();
    writeFileSync(join(invalidJson.root, ".mcp.json"), "{\n");
    expect(() =>
      planNativeEccRegistration(
        invalidJson.root,
        buildNativeEccRegistration(invalidJson),
        "install",
      ),
    ).toThrow(/JSON is malformed/i);

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

  it("rejects foreign, conflicting, ambiguous, and self-inconsistent ownership receipts", async () => {
    async function installedFixture() {
      const input = fixture();
      await executePlan(
        planNativeEccRegistration(input.root, buildNativeEccRegistration(input), "install"),
        context(input.root),
      );
      const receiptPath = join(input.root, NATIVE_ECC_REGISTRATION_RECEIPT);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        root: string;
        stateRoot: string;
        runtime: {
          executable: { path: string; sha256: string };
          cliScript: { path: string; sha256: string };
        };
        files: Array<{
          destination: string;
          ownership: string;
          content: string;
          normalizedSha256: string;
        }>;
      };
      return { input, receiptPath, receipt };
    }

    const foreign = await installedFixture();
    foreign.receipt.root = fixture().root;
    writeFileSync(foreign.receiptPath, `${JSON.stringify(foreign.receipt, null, 2)}\n`);
    expect(() => planInstalledNativeEccRegistration(foreign.input.root, "uninstall")).toThrow(
      /malformed or foreign/i,
    );

    const conflicting = await installedFixture();
    conflicting.receipt.stateRoot = conflicting.input.root;
    writeFileSync(conflicting.receiptPath, `${JSON.stringify(conflicting.receipt, null, 2)}\n`);
    expect(() => planInstalledNativeEccRegistration(conflicting.input.root, "uninstall")).toThrow(
      /conflicting state root/i,
    );

    const ambiguousRuntime = await installedFixture();
    ambiguousRuntime.receipt.runtime.cliScript.path =
      ambiguousRuntime.receipt.runtime.executable.path;
    writeFileSync(
      ambiguousRuntime.receiptPath,
      `${JSON.stringify(ambiguousRuntime.receipt, null, 2)}\n`,
    );
    expect(() =>
      planInstalledNativeEccRegistration(ambiguousRuntime.input.root, "uninstall"),
    ).toThrow(/ambiguous runtime paths/i);

    const ambiguousFiles = await installedFixture();
    const duplicatedFile = ambiguousFiles.receipt.files[0];
    if (!duplicatedFile) throw new Error("fixture receipt has no managed files");
    ambiguousFiles.receipt.files[1] = { ...duplicatedFile };
    writeFileSync(
      ambiguousFiles.receiptPath,
      `${JSON.stringify(ambiguousFiles.receipt, null, 2)}\n`,
    );
    expect(() =>
      planInstalledNativeEccRegistration(ambiguousFiles.input.root, "uninstall"),
    ).toThrow(/ambiguous file ownership/i);

    const invalidContent = await installedFixture();
    const modifiedFile = invalidContent.receipt.files[0];
    if (!modifiedFile) throw new Error("fixture receipt has no managed files");
    modifiedFile.content += "\n";
    writeFileSync(
      invalidContent.receiptPath,
      `${JSON.stringify(invalidContent.receipt, null, 2)}\n`,
    );
    expect(() =>
      planInstalledNativeEccRegistration(invalidContent.input.root, "uninstall"),
    ).toThrow(/content hash is invalid/i);
  });

  it("covers fail-closed installed lifecycle boundaries without weakening operator ownership", async () => {
    const absent = fixture();
    const absentRegistration = buildNativeEccRegistration(absent);
    expect(() => planNativeEccRegistration(absent.root, absentRegistration, "update")).toThrow(
      /update requires an ownership receipt/i,
    );
    expect(() => planNativeEccRegistration(absent.root, absentRegistration, "rollback")).toThrow(
      /rollback requires an ownership receipt/i,
    );

    const unsafe = fixture();
    mkdirSync(join(unsafe.root, ".mcp.json"));
    expect(() =>
      planNativeEccRegistration(unsafe.root, buildNativeEccRegistration(unsafe), "install"),
    ).toThrow(/destination is unsafe/i);

    const repaired = fixture();
    const repairedRegistration = buildNativeEccRegistration(repaired);
    await executePlan(
      planNativeEccRegistration(repaired.root, repairedRegistration, "install"),
      context(repaired.root),
    );
    expect(
      planNativeEccRegistration(repaired.root, repairedRegistration, "update").actions,
    ).toEqual([]);
    rmSync(join(repaired.root, ".codex", "hooks.json"));
    const repair = planInstalledNativeEccRegistration(repaired.root, "repair");
    expect(repair.actions).toHaveLength(1);
    await executePlan(repair, context(repaired.root));
    expect(readFileSync(join(repaired.root, ".codex", "hooks.json"), "utf8")).toContain(
      "Running AIH ECC profile policies",
    );

    const modifiedMcp = fixture();
    const modifiedMcpRegistration = buildNativeEccRegistration(modifiedMcp);
    await executePlan(
      planNativeEccRegistration(modifiedMcp.root, modifiedMcpRegistration, "install"),
      context(modifiedMcp.root),
    );
    writeFileSync(join(modifiedMcp.root, ".mcp.json"), '{"mcpServers":"operator"}\n');
    expect(() =>
      planNativeEccRegistration(modifiedMcp.root, modifiedMcpRegistration, "uninstall"),
    ).toThrow(/modified native registration managed content/i);

    const modifiedHook = fixture();
    const modifiedHookRegistration = buildNativeEccRegistration(modifiedHook);
    await executePlan(
      planNativeEccRegistration(modifiedHook.root, modifiedHookRegistration, "install"),
      context(modifiedHook.root),
    );
    const settingsPath = join(modifiedHook.root, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    settings.hooks.SessionStart = "operator";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    expect(() =>
      planNativeEccRegistration(modifiedHook.root, modifiedHookRegistration, "uninstall"),
    ).toThrow(/modified native registration managed hook/i);

    const duplicateToml = fixture();
    const duplicateTomlRegistration = buildNativeEccRegistration(duplicateToml);
    await executePlan(
      planNativeEccRegistration(duplicateToml.root, duplicateTomlRegistration, "install"),
      context(duplicateToml.root),
    );
    const configPath = join(duplicateToml.root, ".codex", "config.toml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(configPath, `${config}${config}`);
    expect(() =>
      planNativeEccRegistration(duplicateToml.root, duplicateTomlRegistration, "install"),
    ).toThrow(/modified native registration TOML block/i);
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
