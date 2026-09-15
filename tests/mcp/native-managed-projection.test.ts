import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry } from "../../src/internals/cli-registry.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import {
  type NativeMcpTarget,
  nativeMcpProjectionActions,
  nativeMcpProjectionExpected,
  nativeMcpProjectionOnDisk,
  nativeMcpProjectionState,
} from "../../src/mcp/native-managed-projection.js";
import { coalesceMcpProjectionMarkerActions } from "../../src/mcp/projection-marker.js";
import type { McpServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-native-mcp-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function ctx(): PlanContext {
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
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
    targets: ["codex", "cursor", "copilot", "opencode", "kimi"],
  };
}
const server = {
  type: "stdio",
  command: "node",
  args: ["approved-server.js"],
  description: "Approved test server",
  classification: "local",
  egress: "none",
  credentials: "none",
  supplyChain: "pinned",
} as const satisfies McpServer;
const decision = {
  candidate: "approved",
  id: "decision-approved",
  issuer: "security-admin",
  digest: `sha256:${"a".repeat(64)}`,
  expiresAt: "2027-09-01T00:00:00Z",
} as const;
function config(target: NativeMcpTarget): string {
  return join(root, entry(target).mcp.governed?.configPath ?? entry(target).mcp.configPath ?? "");
}
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
async function apply(target: NativeMcpTarget, servers: Record<string, McpServer>) {
  return executePlan(
    plan(
      "native MCP",
      ...nativeMcpProjectionActions(
        ctx(),
        target,
        servers,
        Object.keys(servers).length ? [decision] : [],
      ),
    ),
    ctx(),
  );
}

describe.each<NativeMcpTarget>(["codex", "cursor", "copilot", "opencode", "kimi"])(
  "%s native governed MCP lifecycle",
  (target) => {
    it("plans without writes and applies, updates and removes idempotently", async () => {
      const actions = nativeMcpProjectionActions(ctx(), target, { approved: server }, [decision]);
      expect(actions).toHaveLength(2);
      expect(existsSync(config(target))).toBe(false);
      await apply(target, { approved: server });
      expect(nativeMcpProjectionState(root, target).state).toBe("clean");
      expect(nativeMcpProjectionActions(ctx(), target, { approved: server }, [decision])).toEqual(
        [],
      );
      await apply(target, { approved: { ...server, args: ["updated.js"] } });
      expect(readFileSync(config(target), "utf8")).toContain("updated.js");
      await apply(target, {});
      expect(readFileSync(config(target), "utf8")).not.toContain("updated.js");
      expect(nativeMcpProjectionState(root, target).state).toBe("absent");
      expect(nativeMcpProjectionActions(ctx(), target, {})).toEqual([]);
    });
    it("retains operator settings and comments through application and subtraction", async () => {
      const original =
        target === "codex"
          ? '# operator comment\r\nmodel = "operator-model"\r\n'
          : '{\r\n  // operator comment\r\n  "operator": true\r\n}\r\n';
      write(config(target), original);
      await apply(target, { approved: server });
      await apply(target, {});
      const source = readFileSync(config(target), "utf8");
      expect(source).toContain("operator comment\r\n");
      expect(source).toContain(
        target === "codex" ? 'model = "operator-model"' : '"operator": true',
      );
    });
    it("refuses changed owned content, then revokes ownership without touching it", async () => {
      await apply(target, { approved: server });
      const changed = readFileSync(config(target), "utf8").replace(
        "approved-server.js",
        "operator.js",
      );
      write(config(target), changed);
      expect(nativeMcpProjectionState(root, target).state).toBe("altered");
      expect(() => nativeMcpProjectionActions(ctx(), target, { approved: server })).toThrow(
        /unprovable/,
      );
      await apply(target, {});
      expect(readFileSync(config(target), "utf8")).toBe(changed);
      expect(nativeMcpProjectionState(root, target).state).toBe("revoked");
    });
    it("refuses concurrent config changes before commit", async () => {
      const actions = nativeMcpProjectionActions(ctx(), target, { approved: server }, [decision]);
      write(
        config(target),
        target === "codex" ? 'model = "concurrent"\n' : '{"concurrent": true}\n',
      );
      await expect(executePlan(plan("native MCP", ...actions), ctx())).rejects.toThrow(/changed/);
      expect(existsSync(join(root, ".aih-config.json"))).toBe(false);
    });
    it("rejects hardlinked target files", () => {
      const original = join(root, "operator-config");
      write(original, target === "codex" ? 'model = "operator"\n' : "{}\n");
      mkdirSync(dirname(config(target)), { recursive: true });
      linkSync(original, config(target));
      expect(() => nativeMcpProjectionActions(ctx(), target, { approved: server })).toThrow(
        /regular|unsafe/,
      );
    });
    it("rejects a forged or target-mismatched receipt", async () => {
      await apply(target, { approved: server });
      const path = join(root, ".aih-config.json");
      const marker = JSON.parse(readFileSync(path, "utf8"));
      marker.nativeMcpProjections[target].target = target === "cursor" ? "kimi" : "cursor";
      write(path, JSON.stringify(marker));
      expect(nativeMcpProjectionOnDisk(root, target)).toBeUndefined();
      expect(nativeMcpProjectionState(root, target).state).toBe("malformed");
      expect(() => nativeMcpProjectionActions(ctx(), target, { approved: server })).toThrow(
        /receipt|marker|malformed/,
      );
    });
    it("refuses changed decision bindings and malformed receipts even on deselection", async () => {
      await apply(target, { approved: server });
      const path = join(root, ".aih-config.json");
      const marker = JSON.parse(readFileSync(path, "utf8"));
      marker.nativeMcpProjections[target].decisions[0].issuer = "different-issuer";
      write(path, JSON.stringify(marker));
      expect(nativeMcpProjectionState(root, target).state).toBe("malformed");
      expect(() => nativeMcpProjectionActions(ctx(), target, {})).toThrow(/receipt/);
      expect(readFileSync(config(target), "utf8")).toContain("approved-server.js");
    });
    it("refuses malformed and duplicate-key config without changing it", () => {
      for (const text of target === "codex"
        ? ["model = [", 'model = "one"\nmodel = "two"\n']
        : ['{"broken":', '{"operator":{"a":1,"a":2}}']) {
        write(config(target), text);
        expect(() => nativeMcpProjectionActions(ctx(), target, { approved: server })).toThrow(
          /malformed|duplicate/,
        );
        expect(readFileSync(config(target), "utf8")).toBe(text);
      }
    });
    it("refuses unreceipted name collisions", () => {
      const key = entry(target).mcp.configKey ?? "";
      write(
        config(target),
        target === "codex"
          ? '[mcp_servers.approved]\ncommand = "operator"\n'
          : JSON.stringify({ [key]: { approved: { command: "operator" } } }),
      );
      expect(() => nativeMcpProjectionActions(ctx(), target, { approved: server })).toThrow(
        /unreceipted/,
      );
    });
    it("pins the marker during updates", async () => {
      await apply(target, { approved: server });
      const actions = nativeMcpProjectionActions(
        ctx(),
        target,
        { approved: { ...server, args: ["updated.js"] } },
        [decision],
      );
      const markerPath = join(root, ".aih-config.json");
      write(markerPath, `${readFileSync(markerPath, "utf8")}\n`);
      await expect(executePlan(plan("native MCP", ...actions), ctx())).rejects.toThrow(/changed/);
      expect(readFileSync(config(target), "utf8")).toContain("approved-server.js");
    });
    it("revokes a missing projection without recreating settings", async () => {
      await apply(target, { approved: server });
      rmSync(config(target));
      expect(nativeMcpProjectionState(root, target).state).toBe("missing");
      await apply(target, {});
      expect(existsSync(config(target))).toBe(false);
      expect(nativeMcpProjectionState(root, target).state).toBe("revoked");
    });
  },
);

it("coalesces independent target receipts and removes only the selected target", async () => {
  const actions = ["cursor", "kimi"].flatMap((target) =>
    nativeMcpProjectionActions(ctx(), target as NativeMcpTarget, { approved: server }, [decision]),
  );
  await executePlan(plan("native MCP", ...coalesceMcpProjectionMarkerActions(actions)), ctx());
  expect(nativeMcpProjectionState(root, "cursor").state).toBe("clean");
  expect(nativeMcpProjectionState(root, "kimi").state).toBe("clean");
  await apply("cursor", {});
  expect(nativeMcpProjectionState(root, "kimi").state).toBe("clean");
});

it("maps governed canonical environment references to host syntax", () => {
  const servers = { approved: { ...server, env: { TOKEN: `\${TOKEN}` } } };
  expect(nativeMcpProjectionExpected("cursor", servers).entries.approved).toMatchObject({
    env: { TOKEN: `\${env:TOKEN}` },
  });
  expect(nativeMcpProjectionExpected("opencode", servers).entries.approved).toMatchObject({
    environment: { TOKEN: "{env:TOKEN}" },
  });
  expect(nativeMcpProjectionExpected("codex", servers).entries.approved).toMatchObject({
    env_vars: ["TOKEN"],
  });
});

it("refuses aliased Codex env forwarding and unverified native interpolation", () => {
  expect(() =>
    nativeMcpProjectionExpected("codex", { approved: { ...server, env: { DEST: `\${SOURCE}` } } }),
  ).toThrow(/renamed/);
  for (const target of ["copilot", "kimi"] as const) {
    expect(() =>
      nativeMcpProjectionExpected(target, { approved: { ...server, env: { TOKEN: `\${TOKEN}` } } }),
    ).toThrow(/unsupported/);
  }
});

it("refuses OpenCode V2 configuration instead of mixing generations", () => {
  for (const source of [
    '{"mcp":{"servers":{}}}',
    '{"$schema":"https://opencode.ai/v2/config.json"}',
  ]) {
    write(config("opencode"), source);
    expect(() => nativeMcpProjectionActions(ctx(), "opencode", { approved: server })).toThrow(
      /V2.*V1/,
    );
    expect(readFileSync(config("opencode"), "utf8")).toBe(source);
  }
});

it("refuses alternate OpenCode JSONC discovery rather than creating an ambiguous sibling", () => {
  write(join(root, "opencode.jsonc"), '{"mcp":{"servers":{}}}');
  expect(() => nativeMcpProjectionActions(ctx(), "opencode", { approved: server })).toThrow(
    /alternate.*opencode.jsonc/,
  );
  expect(existsSync(config("opencode"))).toBe(false);
});

it("refuses an OpenCode alternate config created between planning and execution", async () => {
  const actions = nativeMcpProjectionActions(ctx(), "opencode", { approved: server }, [decision]);
  const alternate = join(root, "opencode.jsonc");
  write(alternate, '{"mcp":{"servers":{}}}');
  await expect(executePlan(plan("native MCP", ...actions), ctx())).rejects.toThrow(
    /absent.*opencode.jsonc|opencode.jsonc.*absent/,
  );
  expect(existsSync(config("opencode"))).toBe(false);
  expect(existsSync(join(root, ".aih-config.json"))).toBe(false);
  expect(readFileSync(alternate, "utf8")).toBe('{"mcp":{"servers":{}}}');
});

it("reports an alternate OpenCode config beside an existing receipt as unprovable", async () => {
  await apply("opencode", { approved: server });
  write(join(root, "opencode.jsonc"), '{"mcp":{"servers":{}}}');
  expect(nativeMcpProjectionOnDisk(root, "opencode")).toMatchObject({
    matches: false,
    unprovable: "alternate-config",
  });
  expect(nativeMcpProjectionState(root, "opencode")).toMatchObject({
    state: "altered",
    detail: expect.stringMatching(/alternate.*opencode.jsonc/),
  });
  const original = readFileSync(config("opencode"), "utf8");
  await apply("opencode", {});
  expect(readFileSync(config("opencode"), "utf8")).toBe(original);
  expect(nativeMcpProjectionState(root, "opencode").state).toBe("revoked");
});

it("refuses a symlinked project directory even when the target file is missing", () => {
  const outside = mkdtempSync(join(tmpdir(), "aih-native-outside-"));
  try {
    symlinkSync(outside, join(root, ".cursor"), "junction");
    expect(() => nativeMcpProjectionActions(ctx(), "cursor", { approved: server })).toThrow(
      /regular/,
    );
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

it("refuses a non-directory config parent during planning", () => {
  write(join(root, ".cursor"), "operator file");
  expect(() => nativeMcpProjectionActions(ctx(), "cursor", { approved: server })).toThrow(
    /regular/,
  );
});

it("rejects duplicate receipt fields before interpreting ownership", async () => {
  await apply("cursor", { approved: server });
  const path = join(root, ".aih-config.json");
  write(
    path,
    readFileSync(path, "utf8").replace('"state": "active"', '"state": "active", "state": "active"'),
  );
  expect(() => nativeMcpProjectionActions(ctx(), "cursor", {})).toThrow(/malformed/);
});

it("preserves unrelated JSONC server formatting byte for byte", async () => {
  const operator = '    "team" : { "command" : "operator", "args" : [ "x" ] }';
  write(config("cursor"), `{\n  // keep\n  "mcpServers": {\n${operator}\n  },\n  "other" : 7\n}\n`);
  await apply("cursor", { approved: server });
  expect(readFileSync(config("cursor"), "utf8")).toContain(operator);
  await apply("cursor", {});
  expect(readFileSync(config("cursor"), "utf8")).toContain(operator);
});
