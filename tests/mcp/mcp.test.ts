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

describe("mcp enterprise modes", () => {
  it("--mode none: no .mcp.json servers, a CLI-tool fallback, and a disable template", async () => {
    const actions = (await command.plan(makeCtx({ options: { mode: "none" } }))).actions;
    const writes = actions.filter((a): a is WriteAction => a.kind === "write");
    const paths = writes.map((w) => w.path.replace(/\\/g, "/"));
    expect(paths).not.toContain(".mcp.json");
    expect(paths).toContain(".ai-context/mcp-fallback.md");
    // The admin template DISABLES MCP (empty server map).
    const managed = writes.find((w) => w.path === "managed-mcp.json.example");
    expect((managed?.json as { mcpServers: object }).mcpServers).toEqual({});
    // The fallback steers to CLI tools.
    const fallback = writes.find((w) => w.path.replace(/\\/g, "/").endsWith("mcp-fallback.md"));
    expect(fallback?.contents).toContain("rg");
    expect(fallback?.contents).toContain("git");
  });

  it("--mode offline: drops http/remote servers, keeps stdio, + a managed fixed-set", async () => {
    const actions = (await command.plan(makeCtx({ options: { mode: "offline", scope: "remote" } })))
      .actions;
    const mcp = actions.find((a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json");
    expect(mcp).toBeDefined();
    const servers = mcp ? serversOf(mcp) : {};
    for (const s of Object.values(servers)) expect(s.type).toBe("stdio");
    // The hosted http servers that `remote` would add are dropped (need egress).
    expect(servers["better-email"]).toBeUndefined();
    expect(actions.some((a) => a.kind === "write" && a.path === "managed-mcp.json.example")).toBe(
      true,
    );
  });

  it("--mode offline: a verify probe FAILS on stdio servers that resolve at runtime (AIH-MCP-001)", async () => {
    const ctx = makeCtx({ options: { mode: "offline" }, verify: true });
    const p = await command.plan(ctx);
    const probe = p.actions.find((a) => a.kind === "probe" && a.describe.includes("vendored"));
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    // code-review-graph launches via `uvx` (a runtime resolver) → flagged.
    expect(check?.verdict).toBe("fail");
    expect(check?.detail).toMatch(/runtime/);
  });
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
  it("models code-review-graph as a uvx stdio server", async () => {
    const p = await command.plan(makeCtx());
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const graph = pick(serversOf(w), "code-review-graph");

    expect(graph.type).toBe("stdio");
    if (graph.type !== "stdio") throw new Error("expected stdio server");
    expect(graph.command).toBe("uvx");
    expect(graph.args).toEqual(["code-review-graph@2.3.6", "serve"]);
    expect(typeof graph.description).toBe("string");
  });

  it("project scope on a bare repo writes the always-on base set — no hosted n24q02m boilerplate", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "project" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    // The on-by-default, secret-free base: local code intelligence + reasoning, plus
    // the OAuth GitHub and hosted Context7 docs servers. No stack servers on a bare
    // repo, and never the opt-in n24q02m toolset at project scope.
    const names = Object.keys(serversOf(w));
    expect(names).toEqual(["code-review-graph", "sequential-thinking", "github", "context7"]);
    expect(names.some((n) => n.startsWith("better-"))).toBe(false);
  });

  it("is project-aware: an AWS repo gets the awslabs server, a web repo gets Playwright", async () => {
    const awsRoot = makeTmp();
    writeFileSync(
      join(awsRoot, "package.json"),
      JSON.stringify({ name: "api", dependencies: { "aws-sdk": "^2" } }),
    );
    const awsW = (await command.plan(makeCtx({ root: awsRoot }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    const awsServers = serversOf(awsW);
    expect(awsServers["awslabs.core-mcp-server"]).toBeDefined();
    expect(awsServers.playwright).toBeUndefined();

    const webRoot = makeTmp();
    writeFileSync(
      join(webRoot, "package.json"),
      JSON.stringify({ name: "ui", dependencies: { next: "14" } }),
    );
    const webW = (await command.plan(makeCtx({ root: webRoot }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    expect(serversOf(webW).playwright).toBeDefined();
  });

  it("pins MCP server package versions — never a floating @latest", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "aws-sdk": "^2", next: "14" } }),
    );
    const w = (await command.plan(makeCtx({ root }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    const servers = serversOf(w);
    const aws = pick(servers, "awslabs.core-mcp-server");
    const pw = pick(servers, "playwright");
    if (aws.type !== "stdio" || pw.type !== "stdio") throw new Error("expected stdio servers");
    expect(aws.args).toEqual(["awslabs.core-mcp-server@1.0.27"]);
    expect(pw.args).toEqual(["@playwright/mcp@0.0.76"]);
    expect(`${aws.args.join(" ")} ${pw.args.join(" ")}`).not.toContain("@latest");
  });

  it("suggests a database MCP server (doc) when a datastore is detected, without pinning one", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "api", dependencies: { pg: "^8" } }),
    );
    const p = await command.plan(makeCtx({ root }));
    expect(p.actions.some((a) => a.kind === "doc" && a.describe.includes("database MCP"))).toBe(
      true,
    );
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(Object.keys(serversOf(w))).not.toContain("postgres"); // suggested, not fabricated
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
      "code-review-graph",
      "sequential-thinking",
      "github",
      "context7",
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
    // 5 hosted n24q02m + the 2 on-by-default remote servers (github, context7).
    expect(httpServers.length).toBe(7);
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

describe("aih mcp — risk classification (P1-B)", () => {
  it("labels the local stdio graph server `local` in .mcp.json", async () => {
    const p = await command.plan(makeCtx());
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(pick(serversOf(w), "code-review-graph").classification).toBe("local");
  });

  it("labels stack-added stdio servers (aws, playwright) `local`", async () => {
    const awsRoot = makeTmp();
    writeFileSync(
      join(awsRoot, "package.json"),
      JSON.stringify({ name: "api", dependencies: { "aws-sdk": "^2" } }),
    );
    const awsW = (await command.plan(makeCtx({ root: awsRoot }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    expect(pick(serversOf(awsW), "awslabs.core-mcp-server").classification).toBe("local");

    const webRoot = makeTmp();
    writeFileSync(
      join(webRoot, "package.json"),
      JSON.stringify({ name: "ui", dependencies: { next: "14" } }),
    );
    const webW = (await command.plan(makeCtx({ root: webRoot }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    expect(pick(serversOf(webW), "playwright").classification).toBe("local");
  });

  it("labels every hosted n24q02m server `third-party-hosted`, graph stays `local`", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const servers = serversOf(p.actions.find((a) => a.kind === "write") as WriteAction);
    for (const name of [
      "better-email",
      "better-notion",
      "better-telegram",
      "mnemo-mcp",
      "wet-mcp",
    ]) {
      expect(pick(servers, name).classification).toBe("third-party-hosted");
    }
    expect(pick(servers, "code-review-graph").classification).toBe("local");
  });

  it("surfaces the third-party-hosted vendor-risk callout (named servers) in the remote gateway doc", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));
    const docText = p.actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(docText).toContain("third-party-hosted");
    expect(docText).toContain("vendor-risk");
    expect(docText).toContain("better-email");
    expect(docText).toContain("SOC 2");
  });

  it("never leaks aih risk metadata into the admin managed-mcp template (clean command/args only)", async () => {
    const offline = await command.plan(makeCtx({ options: { mode: "offline", scope: "remote" } }));
    const managed = offline.actions.find(
      (a) => a.kind === "write" && a.path === "managed-mcp.json.example",
    ) as WriteAction;
    const blob = JSON.stringify(managed.json);
    for (const field of ["classification", "egress", "credentials", "supplyChain"]) {
      expect(blob).not.toContain(field);
    }
  });
});

describe("aih mcp — curated default servers (secret-free, on by default)", () => {
  it("adds sequential-thinking as a pinned, zero-egress local stdio server in any repo", async () => {
    const p = await command.plan(makeCtx());
    const seq = pick(
      serversOf(p.actions.find((a) => a.kind === "write") as WriteAction),
      "sequential-thinking",
    );
    expect(seq.type).toBe("stdio");
    if (seq.type !== "stdio") throw new Error("expected stdio server");
    expect(seq.command).toBe("npx");
    expect(seq.args.join(" ")).toContain("@modelcontextprotocol/server-sequential-thinking@");
    expect(seq.args.join(" ")).not.toContain("@latest");
    expect(seq.classification).toBe("local");
    expect(seq.egress).toBe("none");
    expect(seq.credentials).toBe("none");
    expect(seq.supplyChain).toBe("pinned");
  });

  it("adds GitHub as a remote OAuth server — vendor-incumbent egress, NO secret in the file", async () => {
    const p = await command.plan(makeCtx());
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const gh = pick(serversOf(w), "github");
    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(gh.egress).toBe("vendor-incumbent");
    expect(gh.credentials).toBe("oauth");
    expect(gh.supplyChain).toBe("hosted-remote");
    // Secret-free: OAuth is the client's job, so the written config carries no token.
    const blob = JSON.stringify(w.json).toLowerCase();
    expect(blob).not.toContain("personal_access_token");
    expect(blob).not.toContain("ghp_");
  });

  it("adds Context7 as a hosted docs server that NAMES its third-party egress in-file", async () => {
    const p = await command.plan(makeCtx());
    const c7 = pick(
      serversOf(p.actions.find((a) => a.kind === "write") as WriteAction),
      "context7",
    );
    expect(c7.type).toBe("http");
    if (c7.type !== "http") throw new Error("expected http server");
    expect(c7.url).toBe("https://mcp.context7.com/mcp");
    expect(c7.egress).toBe("third-party");
    expect(c7.credentials).toBe("none");
    // The one-line egress warning is surfaced in the entry itself.
    expect(c7.description).toContain("THIRD-PARTY");
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
    expect(merged.mcpServers["code-review-graph"]?.command).toBe("uvx");
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

describe("aih mcp — per-CLI config (honors --cli)", () => {
  it("--cli codex writes its TOML config (external), NOT a .mcp.json Codex never reads", async () => {
    const p = await command.plan(makeCtx({ options: { cli: "codex" } }));
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    expect(writes.some((w) => w.path === ".mcp.json")).toBe(false);
    // Codex MCP is folded into ~/.codex/config.toml as an aih-managed TOML block (external).
    const codex = writes.find((w) => w.path.replace(/\\/g, "/").endsWith(".codex/config.toml"));
    expect(codex).toBeDefined();
    expect(codex?.external).toBe(true);
    expect(codex?.contents).toContain("[mcp_servers.");
  });

  it("--cli cursor writes .cursor/mcp.json (same shape, different project path)", async () => {
    const p = await command.plan(makeCtx({ options: { cli: "cursor" } }));
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    expect(writes.map((w) => w.path)).toContain(".cursor/mcp.json");
    expect(writes.map((w) => w.path)).not.toContain(".mcp.json");
  });

  it("--cli claude,kimi writes ONE .mcp.json (the shared path is deduped)", async () => {
    const p = await command.plan(makeCtx({ options: { cli: "claude,kimi" } }));
    const dotMcp = p.actions.filter(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    expect(dotMcp).toHaveLength(1);
  });

  it("--all-tools writes each tool's OWN MCP config — never Claude's .mcp.json for a TOML/global tool", async () => {
    const p = await command.plan(makeCtx({ options: { allTools: true } }));
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    const paths = writes.map((w) => w.path.replace(/\\/g, "/"));
    // Repo-relative natives keep their own paths (claude/kimi dedupe to one .mcp.json).
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".cursor/mcp.json");
    expect(paths.some((pa) => pa.endsWith("opencode.json"))).toBe(true);
    expect(paths.some((pa) => pa.endsWith(".vscode/mcp.json"))).toBe(true);
    // Codex gets its TOML written (external), NOT a .mcp.json it cannot read.
    const codex = writes.find((w) => w.path.replace(/\\/g, "/").endsWith(".codex/config.toml"));
    expect(codex?.external).toBe(true);
    expect(codex?.contents).toContain("[mcp_servers.");
  });
});

describe("aih mcp — enterprise posture (governance gate, opt-in)", () => {
  it("emits a governance doc + a policy probe that FAILS on the third-party context7 server", async () => {
    const ctx = makeCtx({ options: { posture: "enterprise" }, verify: true });
    const p = await command.plan(ctx);

    const govText = p.actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(govText).toContain("MCP governance — enterprise posture");
    expect(govText).toContain("context7");

    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("mcp.policy-denied");
    expect(check?.detail).toContain("context7");
  });

  it("still writes .mcp.json with the FULL catalog — governance REPORTS, it never drops a server", async () => {
    const p = await command.plan(makeCtx({ options: { posture: "enterprise" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    expect(w.path).toBe(".mcp.json");
    // context7 is denied by policy but STILL written — the human decides, aih reports.
    expect(Object.keys(serversOf(w))).toContain("context7");
  });

  it("at remote scope the gate denies context7 AND the n24q02m hosted set, but not github/local", async () => {
    const ctx = makeCtx({ options: { posture: "enterprise", scope: "remote" }, verify: true });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;
    expect(check?.verdict).toBe("fail");
    for (const denied of ["context7", "better-email", "wet-mcp"]) {
      expect(check?.detail).toContain(denied);
    }
    // github (vendor-incumbent + oauth) and the local servers pass — not in the denied list.
    expect(check?.detail).not.toContain("github");
    expect(check?.detail).not.toContain("code-review-graph");
  });

  it("community posture (the default) adds NO governance doc and NO policy probe", async () => {
    const p = await command.plan(makeCtx({ options: {} }));
    expect(p.actions.some((a) => a.kind === "doc")).toBe(false);
    expect(
      p.actions.some(
        (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
      ),
    ).toBe(false);
  });
});
