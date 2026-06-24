import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContents } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { jsonFile } from "../../src/internals/render.js";
import { command } from "../../src/mcp/index.js";
import type { McpServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const tmpDirs: string[] = [];

/** Pull the typed mcpServers map out of a `.mcp.json` write action. */
function serversOf(write: WriteAction): Record<string, McpServer> {
  return (write.json as { mcpServers: Record<string, McpServer> }).mcpServers;
}

/** Assert a server is present and return it non-undefined (fails the test if missing). */
function pick(servers: Record<string, McpServer>, name: string): McpServer {
  const server = servers[name];
  if (server === undefined) throw new Error(`missing server ${name}`);
  return server;
}

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aih-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

interface CtxOverrides {
  root?: string;
  contextDir?: string;
  verify?: boolean;
  options?: Record<string, unknown>;
  run?: PlanContext["run"];
}

function makeCtx(over: CtxOverrides = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  const host = makeHostAdapter({ platform: "linux", run, env: {} });
  return {
    root: over.root ?? makeTmp(),
    contextDir: over.contextDir ?? ".ai-context",
    apply: false,
    verify: over.verify ?? false,
    json: false,
    run,
    host,
    env: {},
    options: over.options ?? {},
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("aih mcp — plan shape", () => {
  it("writes .mcp.json (merge) and a uv probe for the default project scope", async () => {
    const p = await command.plan(makeCtx());

    const writes = p.actions.filter((a) => a.kind === "write");
    expect(writes).toHaveLength(1);
    const w = writes[0] as WriteAction;
    expect(w.path).toBe(".mcp.json");
    expect(w.merge).toBe(true);
    expect(w.describe).toContain("project scope");

    const probes = p.actions.filter((a) => a.kind === "probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.describe).toBe("uv present");

    // No doc and no exec for the project scope.
    expect(p.actions.some((a) => a.kind === "doc")).toBe(false);
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("defaults to project scope when no --scope option is given", async () => {
    const p = await command.plan(makeCtx({ options: {} }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(w.describe).toContain("project scope");
    expect(p.actions.some((a) => a.kind === "doc")).toBe(false);
  });

  it("reflects the chosen scope in the write describe", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "local" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(w.describe).toContain("local scope");
  });

  it("emits the SSO gateway doc ONLY for remote scope, never for local", async () => {
    // The doc is gated strictly on `scope === "remote"`. A non-remote scope must
    // not leak the cloud SSO guidance — local/project stay write+probe only.
    const local = await command.plan(makeCtx({ options: { scope: "local" } }));
    expect(local.actions.some((a) => a.kind === "doc")).toBe(false);
    expect(local.actions.some((a) => a.kind === "exec")).toBe(false);
  });
});

describe("aih mcp — generated mcpServers blueprint", () => {
  it("models better-code-review-graph as a uv stdio server", async () => {
    const p = await command.plan(makeCtx());
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const graph = pick(serversOf(w), "better-code-review-graph");

    expect(graph.type).toBe("stdio");
    if (graph.type !== "stdio") throw new Error("expected stdio server");
    expect(graph.command).toBe("uv");
    expect(graph.args).toEqual(["run", "better-code-review-graph", "serve"]);
    expect(typeof graph.description).toBe("string");
  });

  it("project scope writes ONLY the local graph server — no hosted n24q02m boilerplate", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "project" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(Object.keys(serversOf(w))).toEqual(["better-code-review-graph"]);
  });

  it("models better-email as an opt-in http url under the remote scope, not a call", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const email = pick(serversOf(w), "better-email");

    expect(email.type).toBe("http");
    if (email.type !== "http") throw new Error("expected http server");
    expect(email.url).toBe("https://better-email-mcp.n24q02m.com/mcp");
  });

  it("includes the full n24q02m hosted toolset under remote scope, each with a description", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const servers = serversOf(w);

    const expected = [
      "better-code-review-graph",
      "better-email",
      "better-notion",
      "better-telegram",
      "mnemo-mcp",
      "wet-mcp",
    ];
    for (const name of expected) {
      const server = pick(servers, name);
      expect(typeof server.description).toBe("string");
      expect(server.description.length).toBeGreaterThan(0);
    }
    // Exactly the blueprint toolset — no rogue extra server slips into the file.
    expect(Object.keys(servers).sort()).toEqual([...expected].sort());
  });

  it("BOUNDARY: every http server carries only a url — never a local command/args", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const servers = serversOf(w);

    const httpServers = Object.values(servers).filter((s) => s.type === "http");
    expect(httpServers.length).toBe(5);
    for (const s of httpServers) {
      // A hosted endpoint is a dialed-later URL string, not a launchable process.
      const bag = s as unknown as Record<string, unknown>;
      expect(bag.command).toBeUndefined();
      expect(bag.args).toBeUndefined();
      if (s.type === "http") expect(s.url.startsWith("https://")).toBe(true);
    }
  });

  it("produces deterministic JSON (stable key order, no dates)", async () => {
    const a = await command.plan(makeCtx());
    const b = await command.plan(makeCtx());
    const wa = a.actions.find((x) => x.kind === "write") as WriteAction;
    const wb = b.actions.find((x) => x.kind === "write") as WriteAction;
    expect(jsonFile(wa.json)).toBe(jsonFile(wb.json));
  });
});

describe("aih mcp — merge preserves user config", () => {
  it("keeps a planted user server (mcpServers.myServer) on merge", async () => {
    const root = makeTmp();
    const existing = {
      mcpServers: {
        myServer: { type: "stdio", command: "node", args: ["my-server.js"] },
      },
    };
    writeFileSync(join(root, ".mcp.json"), jsonFile(existing), "utf8");

    const p = await command.plan(makeCtx({ root }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const absPath = join(root, ".mcp.json");
    const merged = JSON.parse(resolveContents(w, absPath)) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };

    // User-only server survives...
    expect(merged.mcpServers.myServer).toEqual(existing.mcpServers.myServer);
    // ...alongside the harness blueprint.
    expect(merged.mcpServers["better-code-review-graph"]?.command).toBe("uv");
  });

  it("is idempotent: merging the blueprint twice yields the same file", async () => {
    const root = makeTmp();
    const absPath = join(root, ".mcp.json");

    const p1 = await command.plan(makeCtx({ root }));
    const w1 = p1.actions.find((a) => a.kind === "write") as WriteAction;
    const firstPass = resolveContents(w1, absPath);
    writeFileSync(absPath, firstPass, "utf8");

    const p2 = await command.plan(makeCtx({ root }));
    const w2 = p2.actions.find((a) => a.kind === "write") as WriteAction;
    const secondPass = resolveContents(w2, absPath);

    expect(secondPass).toBe(firstPass);
  });
});

describe("aih mcp — remote scope emits SSO gateway doc (cloud is doc, not write/exec)", () => {
  it("adds a doc with Entra/Okta OIDC, the RBAC scope, and the login --check command", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const docs = p.actions.filter((a) => a.kind === "doc");
    expect(docs).toHaveLength(1);

    const text = docs[0]?.kind === "doc" ? docs[0].text : "";
    expect(text).toContain("api://agentgateway/mcp_access");
    expect(text).toContain("Entra ID");
    expect(text).toContain("Okta");
    expect(text).toContain("agentgateway login --check");
    // Tool-level RBAC mapping is present.
    expect(text).toContain("RBAC");
    // Clients are pointed at the canonical agentgateway base URL (blueprint Phase 3).
    expect(text).toContain("https://agentgateway.n24q02m.com");
    // The gateway doc carries no file path (printed guidance, not a written file).
    expect(docs[0]?.kind === "doc" ? docs[0].path : "x").toBeUndefined();
  });

  it("still writes .mcp.json (merge) in the remote scope", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(w.path).toBe(".mcp.json");
    expect(w.merge).toBe(true);
  });

  it("BOUNDARY: no write or exec action targets a remote host — gateway/SSO is doc only", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));

    // No exec actions at all (no remote, and nothing local to mutate here).
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);

    // The only write is the local .mcp.json; its contents never trigger a call —
    // hosted servers are recorded as plain URL strings under mcpServers.
    const writes = p.actions.filter((a) => a.kind === "write") as WriteAction[];
    expect(writes).toHaveLength(1);
    const only = writes[0] as WriteAction;
    expect(only.path).toBe(".mcp.json");
    const blob = JSON.stringify(only.json);
    // Remote endpoints live inside mcpServers as config, not as a top-level action target.
    expect(blob).toContain("n24q02m.com");
    expect(only.path.startsWith("http")).toBe(false);
  });
});

describe("aih mcp — uv probe under --verify", () => {
  it("passes when uv --version exits 0", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "uv" ? { code: 0, stdout: "uv 0.5.0\n" } : undefined,
    );
    const ctx = makeCtx({ verify: true, run });
    const p = await command.plan(ctx);
    const probe = p.actions.find((a) => a.kind === "probe");
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toBe("uv 0.5.0");
  });

  it("skips (never fails) when uv is absent from PATH", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "uv" ? { code: 127, spawnError: true, stderr: "not found" } : undefined,
    );
    const ctx = makeCtx({ verify: true, run });
    const p = await command.plan(ctx);
    const probe = p.actions.find((a) => a.kind === "probe");
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("skip");
  });

  it("fails when uv is present but errors (non-zero, not a spawn error)", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "uv" ? { code: 2, stderr: "broken" } : undefined,
    );
    const ctx = makeCtx({ verify: true, run });
    const p = await command.plan(ctx);
    const probe = p.actions.find((a) => a.kind === "probe");
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("fail");
  });
});
