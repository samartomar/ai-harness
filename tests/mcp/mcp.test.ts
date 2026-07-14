import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { upsertTextBlock } from "../../src/internals/envfile.js";
import { resolveContents } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { jsonFile } from "../../src/internals/render.js";
import { command, mcpApproveCommand } from "../../src/mcp/index.js";
import { mcpApprovalSubject } from "../../src/mcp/policy.js";
import { existingMcpTomlNames, removeMcpTomlServers } from "../../src/mcp/render.js";
import type { McpServer } from "../../src/mcp/servers.js";
import type { Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const tmpDirs: string[] = [];

/** Pull the typed mcpServers map out of a `.mcp.json` write action. */
function serversOf(write: WriteAction): Record<string, McpServer> {
  return (write.json as { mcpServers: Record<string, McpServer> }).mcpServers;
}

const MCP_CONFIG_KEYS = ["mcpServers", "servers", "mcp", "context_servers"] as const;

function jsonConfigServerNames(write: WriteAction): string[] | undefined {
  const json = write.json as Record<string, Record<string, unknown>> | undefined;
  const key = MCP_CONFIG_KEYS.find((candidate) => json?.[candidate] !== undefined);
  return key === undefined ? undefined : Object.keys(json?.[key] ?? {});
}

function writeMcpPolicy(
  root: string,
  mcp: { allowedServers: string[]; allowManagedOnly: boolean; disabledServers?: string[] },
): void {
  writeFileSync(
    join(root, "aih-org-policy.json"),
    jsonFile({
      schemaVersion: 1,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp,
    }),
  );
}

/** Assert a server is present and return it non-undefined (fails the test if missing). */
function pick(servers: Record<string, McpServer>, name: string): McpServer {
  const server = servers[name];
  if (server === undefined) throw new Error(`missing server ${name}`);
  return server;
}

function context7ApprovalSubject(): string {
  return mcpApprovalSubject({
    type: "http",
    url: "https://mcp.context7.com/mcp",
    description: "context7",
    classification: "third-party-hosted",
    egress: "third-party",
    credentials: "none",
    supplyChain: "hosted-remote",
  });
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
  env?: NodeJS.ProcessEnv;
  run?: PlanContext["run"];
  platform?: Platform;
}

function makeCtx(over: CtxOverrides = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  const env = over.env ?? {};
  const host = makeHostAdapter({ platform: over.platform ?? "linux", run, env });
  return {
    root: over.root ?? makeTmp(),
    contextDir: over.contextDir ?? ".ai-context",
    apply: false,
    verify: over.verify ?? false,
    json: false,
    run,
    host,
    env,
    options: over.options ?? {},
  };
}

function mcpCliCommand(argv: string[]): Command {
  const cmd = new Command("mcp");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--posture <posture>", "", "vibe")
    .option("--cli <list>")
    .option("--all-tools")
    .option("--detect")
    .option("--force")
    .option("--scope <scope>", "", "project")
    .option("--mode <mode>", "", "standard")
    .option("--self-host")
    .option("--github-auth <auth>", "", "oauth")
    .option("--mcp-compliant");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

async function runMcp(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(command, mcpCliCommand(argv), {
    run: fakeRunner((args) => (args[0] === "uv" ? { code: 0, stdout: "uv 0.11.19\n" } : undefined)),
    env: {},
    write: (text) => {
      out += text;
    },
  });
  return { code, out };
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
    expect((managed?.json as { mcpServers: object })?.mcpServers).toEqual({});
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

  it("--mode offline: honors org-policy disabledServers for generated and managed MCP sets", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          disabledServers: ["code-review-graph"],
        },
      }),
    );

    const actions = (await command.plan(makeCtx({ root, options: { mode: "offline" } }))).actions;
    const mcp = actions.find((a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json");
    const managed = actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === "managed-mcp.json.example",
    );

    expect(mcp).toBeDefined();
    expect(managed).toBeDefined();
    expect(Object.keys(mcp ? serversOf(mcp) : {})).not.toContain("code-review-graph");
    expect(
      Object.keys((managed?.json as { mcpServers: Record<string, unknown> })?.mcpServers ?? {}),
    ).not.toContain("code-review-graph");
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
    expect(graph.args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
    ]);
    expect(typeof graph.description).toBe("string");
  });

  it("models codebase-memory-mcp as an offline uvx stdio server", async () => {
    const p = await command.plan(makeCtx());
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    const memory = pick(serversOf(w), "codebase-memory-mcp");

    expect(memory.type).toBe("stdio");
    if (memory.type !== "stdio") throw new Error("expected stdio server");
    expect(memory.command).toBe("uvx");
    expect(memory.args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.8.1",
    ]);
    expect(typeof memory.description).toBe("string");
  });

  it("project scope on a bare repo writes the always-on base set — no hosted n24q02m boilerplate", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "project" } }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;
    // The on-by-default, secret-free base: local code intelligence + memory + reasoning, plus
    // the OAuth GitHub and hosted Context7 docs servers. No stack servers on a bare
    // repo, and never the opt-in n24q02m toolset at project scope.
    const names = Object.keys(serversOf(w));
    expect(names).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "sequential-thinking",
      "github",
      "context7",
    ]);
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
    expect(aws.args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "awslabs.core-mcp-server@1.0.27",
    ]);
    expect(pw.args).toEqual(["@playwright/mcp@0.0.76"]);
    expect(`${aws.args.join(" ")} ${pw.args.join(" ")}`).not.toContain("@latest");
  });

  it("hardens every generated uvx MCP launcher against startup fetches and .env reads", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "aws-sdk": "^2" } }),
    );
    const w = (await command.plan(makeCtx({ root }))).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    const uvxServers = Object.values(serversOf(w)).filter(
      (server) => server.type === "stdio" && server.command === "uvx",
    );

    expect(uvxServers.length).toBeGreaterThan(0);
    for (const server of uvxServers) {
      if (server.type !== "stdio") throw new Error("expected stdio server");
      expect(server.args).toEqual(
        expect.arrayContaining(["--offline", "--no-python-downloads", "--no-env-file"]),
      );
    }
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
      "codebase-memory-mcp",
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

describe("aih mcp — --self-host (GitHub via local Docker + .env.example)", () => {
  it("swaps GitHub to a pinned local Docker stdio server with a PAT env ref", async () => {
    const p = await command.plan(makeCtx({ options: { selfHost: true } }));
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");
    expect(gh.type).toBe("stdio");
    if (gh.type !== "stdio") throw new Error("expected stdio server");
    expect(gh.command).toBe("docker");
    expect(gh.args).toContain("ghcr.io/github/github-mcp-server:v1.5.0");
    expect(gh.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toMatch(/^\$\{GITHUB_PERSONAL_ACCESS_TOKEN\}$/);
    expect(gh.credentials).toBe("token");
    expect(gh.supplyChain).toBe("pinned");
  });

  it("ignores an invalid ambient GITHUB_HOST when GitHub is self-hosted", async () => {
    const p = await command.plan(
      makeCtx({
        options: { selfHost: true },
        env: { GITHUB_HOST: "github.internal.example" },
      }),
    );
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("stdio");
    expect(p.actions.some((a) => a.kind === "probe" && a.describe === "org-policy parse")).toBe(
      false,
    );
  });

  it("default (no --self-host) keeps GitHub as the hosted OAuth http endpoint", async () => {
    const w = (await command.plan(makeCtx())).actions.find(
      (a) => a.kind === "write",
    ) as WriteAction;
    const gh = pick(serversOf(w), "github");
    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(gh.credentials).toBe("oauth");
    expect(JSON.stringify(gh)).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("--github-auth token keeps hosted GitHub and authenticates with an env-sourced header", async () => {
    const p = await command.plan(makeCtx({ options: { githubAuth: "token" } }));
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(gh.credentials).toBe("token");
    expect(gh.headers?.Authorization).toBe("Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}");
    expect(JSON.stringify(gh)).not.toContain("ghp_literal_secret");
  });

  it("--github-auth token writes only the PAT placeholder to .env.example", async () => {
    const p = await command.plan(
      makeCtx({
        options: { githubAuth: "token" },
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_literal_secret" },
      }),
    );
    const envExample = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".env.example",
    );

    expect(envExample).toBeDefined();
    expect(envExample?.contents).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=");
    expect(JSON.stringify(p.actions)).not.toContain("ghp_literal_secret");
  });

  it("--github-auth rejects invalid values in every mode", async () => {
    for (const options of [
      { githubAuth: "banana" },
      { mode: "none", githubAuth: "banana" },
      { mode: "offline", githubAuth: "banana" },
    ]) {
      await expect(command.plan(makeCtx({ options }))).rejects.toThrow(
        "--github-auth must be one of: oauth, token",
      );
    }
  });

  it("--github-auth token ignores an ambient GITHUB_HOST to avoid token egress to env-controlled hosts", async () => {
    const p = await command.plan(
      makeCtx({
        options: { githubAuth: "token" },
        env: { GITHUB_HOST: "https://evil.example" },
      }),
    );
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(gh.headers?.Authorization).toBe("Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}");
    expect(JSON.stringify(gh)).not.toContain("evil.example");
  });

  it("--github-auth token ignores AIH_ORG_POLICY host overrides for token egress", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "uncommitted-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          githubHost: "https://evil.example",
          incumbentHosts: ["evil.example"],
        },
      }),
    );
    const p = await command.plan(
      makeCtx({
        root,
        options: { githubAuth: "token" },
        env: { AIH_ORG_POLICY: "uncommitted-policy.json" },
      }),
    );
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(gh.headers?.Authorization).toBe("Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}");
    expect(JSON.stringify(gh)).not.toContain("evil.example");
  });

  it("--github-auth token classifies the root-policy host with the same trusted policy", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          githubHost: "https://github.internal.example",
          incumbentHosts: ["github.internal.example"],
        },
      }),
    );
    writeFileSync(
      join(root, "operator-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );
    const p = await command.plan(
      makeCtx({
        root,
        options: { githubAuth: "token" },
        env: { AIH_ORG_POLICY: "operator-policy.json" },
      }),
    );
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://github.internal.example/mcp/");
    expect(gh.egress).toBe("vendor-incumbent");
  });

  it("writes a .env.example documenting the PAT placeholder (never a value)", async () => {
    const p = await command.plan(makeCtx({ options: { selfHost: true } }));
    const envExample = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".env.example",
    );
    expect(envExample).toBeDefined();
    expect(envExample?.contents).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=");
  });

  it("default writes no .env.example (no secret placeholders)", async () => {
    const p = await command.plan(makeCtx());
    expect(p.actions.some((a) => a.kind === "write" && a.path === ".env.example")).toBe(false);
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
    expect(text).toContain("mcp-gateway-rbac.json");
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

  it("writes a structured gateway RBAC config from catalog plus org-policy", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["code-review-graph", "better-email", "missing-server"],
          allowManagedOnly: false,
        },
      }),
    );
    const p = await command.plan(makeCtx({ root, options: { scope: "remote" } }));
    const rbac = p.actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/") === ".ai-context/mcp-gateway-rbac.json",
    );
    expect(rbac).toBeDefined();
    const roles = (rbac?.json as { roles: Array<{ idpGroup: string; allowedServers: string[] }> })
      ?.roles;
    const orgDefault = roles?.find((role) => role.idpGroup === "mcp-org-default");
    expect(orgDefault?.allowedServers).toEqual(["better-email", "code-review-graph"]);
    expect(JSON.stringify(rbac?.json)).toContain("missing-server");
  });

  it("fails closed during planning when org-policy is malformed", async () => {
    const root = makeTmp();
    writeFileSync(join(root, "aih-org-policy.json"), "{ broken");

    await expect(command.plan(makeCtx({ root, options: { scope: "remote" } }))).rejects.toThrow(
      /aih-org-policy\.json cannot be parsed/,
    );
  });

  it("reports MCP catalog errors without blaming org-policy parsing", async () => {
    await expect(
      command.plan(makeCtx({ env: { GITHUB_HOST: "github.internal.example" } })),
    ).rejects.toThrow(/MCP catalog cannot be built: GITHUB_HOST must be an https origin/);
  });

  it("BOUNDARY: no write or exec action targets a remote host — gateway/SSO is doc only", async () => {
    const p = await command.plan(makeCtx({ options: { scope: "remote" } }));

    // No exec actions at all (no remote, and nothing local to mutate here).
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);

    // Writes are local project/context artifacts; their contents never trigger a call —
    // hosted servers are recorded as plain URL strings under mcpServers/RBAC config.
    const writes = p.actions.filter((a) => a.kind === "write") as WriteAction[];
    expect(writes.map((w) => w.path.replace(/\\/g, "/")).sort()).toEqual([
      ".ai-context/mcp-gateway-rbac.json",
      ".mcp.json",
    ]);
    const dotMcp = writes.find((w) => w.path === ".mcp.json") as WriteAction;
    const blob = JSON.stringify(dotMcp.json);
    // Remote endpoints live inside mcpServers as config, not as a top-level action target.
    expect(blob).toContain("n24q02m.com");
    expect(writes.every((w) => !w.path.startsWith("http"))).toBe(true);
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

describe("aih mcp — MCP write hygiene", () => {
  it("--cli opencode writes the global config, preserves existing provider settings, and disables missing-token servers", async () => {
    const root = makeTmp();
    const home = makeTmp();
    const opencodeDir = join(home, ".config", "opencode");
    mkdirSync(opencodeDir, { recursive: true });
    const opencodePath = join(opencodeDir, "opencode.json");
    writeFileSync(
      opencodePath,
      jsonFile({
        provider: { openai: { keyRef: "$OPENAI_API_KEY" } },
        model: "openai/gpt-5",
        mcp: {
          existing: { type: "local", command: ["custom-mcp"], enabled: true },
        },
      }),
    );

    const p = await command.plan(
      makeCtx({
        root,
        env: { HOME: home, USERPROFILE: home },
        options: { cli: "opencode", githubAuth: "token" },
      }),
    );
    const opencode = p.actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith(".config/opencode/opencode.json"),
    );
    const warning = p.actions.find(
      (a) => a.kind === "digest" && a.describe === "MCP server hygiene warnings",
    );

    expect(opencode).toBeDefined();
    expect(opencode?.external).toBe(true);
    const merged = JSON.parse(resolveContents(opencode as WriteAction, opencodePath)) as {
      provider: Record<string, unknown>;
      model: string;
      mcp: Record<string, { enabled?: boolean }>;
    };
    expect(merged.provider).toEqual({ openai: { keyRef: "$OPENAI_API_KEY" } });
    expect(merged.model).toBe("openai/gpt-5");
    expect(merged.mcp.existing).toEqual({ type: "local", command: ["custom-mcp"], enabled: true });
    expect(merged.mcp.github?.enabled).toBe(false);
    expect(warning?.kind === "digest" ? warning.text : "").toContain(
      "GITHUB_PERSONAL_ACCESS_TOKEN",
    );
    expect(warning?.kind === "digest" ? warning.text : "").toContain("OpenCode enabled:false");
  });

  it("flags placeholder remote hosts before writing OpenCode config", async () => {
    const root = makeTmp();
    const home = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          githubHost: "https://github.internal.example",
          incumbentHosts: ["github.internal.example"],
        },
      }),
    );

    const p = await command.plan(
      makeCtx({
        root,
        env: { HOME: home, USERPROFILE: home },
        options: { cli: "opencode" },
      }),
    );
    const opencode = p.actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith(".config/opencode/opencode.json"),
    );
    const warning = p.actions.find(
      (a) => a.kind === "digest" && a.describe === "MCP server hygiene warnings",
    );

    expect(
      (opencode?.json as { mcp: Record<string, { enabled?: boolean }> })?.mcp.github?.enabled,
    ).toBe(false);
    expect(warning?.kind === "digest" ? warning.text : "").toContain(
      "placeholder URL host github.internal.example",
    );
  });

  it("--verify surfaces npm MCP package version-pin drift from the configured registry", async () => {
    const run = fakeRunner((argv) => {
      if (argv[0] === "uv") return { code: 0, stdout: "uv 0.5.0\n" };
      if (
        argv.join(" ") ===
        "npm view @modelcontextprotocol/server-sequential-thinking@2025.12.18 version"
      ) {
        return { code: 0, stdout: "2025.12.19\n" };
      }
      return undefined;
    });
    const ctx = makeCtx({ verify: true, run });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe === "MCP package pins match resolved versions",
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("mcp.version-drift");
    expect(check?.detail).toContain(
      "@modelcontextprotocol/server-sequential-thinking pinned 2025.12.18 but registry resolved 2025.12.19",
    );
  });

  it("--verify routes npm MCP package pin probes through cmd on Windows", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (argv[0] === "uv") return { code: 0, stdout: "uv 0.5.0\n" };
      if (
        argv.join(" ") ===
        "cmd /c npm view @modelcontextprotocol/server-sequential-thinking@2025.12.18 version"
      ) {
        return { code: 0, stdout: "2025.12.18\n" };
      }
      return undefined;
    });
    const ctx = makeCtx({ verify: true, run, platform: "windows" });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe === "MCP package pins match resolved versions",
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check?.verdict).toBe("pass");
    expect(calls).toContainEqual([
      "cmd",
      "/c",
      "npm",
      "view",
      "@modelcontextprotocol/server-sequential-thinking@2025.12.18",
      "version",
    ]);
  });
});

describe("aih mcp — per-CLI config (honors --cli)", () => {
  it("S1/S2 treats an empty managed allowlist as deny-all across every MCP writer", async () => {
    const root = makeTmp();
    const home = makeTmp();
    const baseline = await command.plan(makeCtx({ root, options: { cli: "claude" } }));
    const baselineMcp = baseline.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({
        operatorSetting: { keep: true },
        mcpServers: {
          "code-review-graph": { type: "stdio", command: "operator-mcp", args: ["serve"] },
          "sequential-thinking": serversOf(baselineMcp as WriteAction)["sequential-thinking"],
          operator: { type: "stdio", command: "operator-only", args: [] },
        },
      }),
    );
    writeMcpPolicy(root, { allowedServers: [], allowManagedOnly: true });

    const p = await command.plan(
      makeCtx({
        root,
        env: { HOME: home, USERPROFILE: home },
        options: {
          allTools: true,
          scope: "remote",
          posture: "enterprise",
          githubAuth: "token",
        },
      }),
    );
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    const jsonClientWrites = writes.filter((write) => jsonConfigServerNames(write) !== undefined);
    const codex = writes.find((write) =>
      write.path.replace(/\\/g, "/").endsWith(".codex/config.toml"),
    );
    const managed = writes.find((write) => write.path === ".claude/managed-settings.json");
    const gateway = writes.find((write) => write.path.endsWith("mcp-gateway-rbac.json"));
    const gatewayJson = gateway?.json as { catalog: Record<string, unknown> };

    expect(jsonClientWrites).toHaveLength(9);
    for (const write of jsonClientWrites) expect(jsonConfigServerNames(write)).toEqual([]);
    expect(codex?.contents).not.toContain("[mcp_servers.");
    expect((managed?.json as { allowedMcpServers?: unknown[] })?.allowedMcpServers).toEqual([]);
    expect(gatewayJson?.catalog).toEqual({});
    expect(writes.some((write) => write.path === ".env.example")).toBe(false);
    const dotMcp = writes.find((write) => write.path === ".mcp.json");
    const merged = JSON.parse(resolveContents(dotMcp as WriteAction, join(root, ".mcp.json"))) as {
      operatorSetting?: unknown;
      mcpServers: Record<string, { command?: string }>;
    };
    expect(merged.operatorSetting).toEqual({ keep: true });
    expect(merged.mcpServers["code-review-graph"]?.command).toBe("operator-mcp");
    expect(merged.mcpServers.operator?.command).toBe("operator-only");
    expect(merged.mcpServers["sequential-thinking"]).toBeUndefined();

    const offline = await command.plan(makeCtx({ root, options: { mode: "offline" } }));
    const offlineMcp = offline.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const offlineManaged = offline.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === "managed-mcp.json.example",
    );
    expect(Object.keys(serversOf(offlineMcp as WriteAction))).toEqual([]);
    expect(Object.keys(serversOf(offlineManaged as WriteAction))).toEqual([]);
  });

  it("S1/S2 applies populated lists and leaves allowManagedOnly false unchanged", async () => {
    const root = makeTmp();
    const home = makeTmp();
    writeMcpPolicy(root, {
      allowedServers: ["code-review-graph", "sequential-thinking"],
      allowManagedOnly: true,
      disabledServers: ["sequential-thinking"],
    });

    const restricted = await command.plan(
      makeCtx({
        root,
        env: { HOME: home, USERPROFILE: home },
        options: { allTools: true, posture: "enterprise" },
      }),
    );
    const restrictedWrites = restricted.actions.filter((a): a is WriteAction => a.kind === "write");
    for (const write of restrictedWrites) {
      const names = jsonConfigServerNames(write);
      if (names !== undefined) expect(names).toEqual(["code-review-graph"]);
    }
    const codex = restrictedWrites.find((write) =>
      write.path.replace(/\\/g, "/").endsWith(".codex/config.toml"),
    );
    expect(codex?.contents).toContain('mcp_servers."code-review-graph"');
    expect(codex?.contents).not.toContain("sequential-thinking");

    writeMcpPolicy(root, { allowedServers: [], allowManagedOnly: false });
    const unrestricted = await command.plan(makeCtx({ root, options: { cli: "claude" } }));
    const dotMcp = unrestricted.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    expect(Object.keys(serversOf(dotMcp as WriteAction))).toEqual(
      expect.arrayContaining(["code-review-graph", "sequential-thinking"]),
    );
  });

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

  it("--cli codex --github-auth token renders Codex's native bearer-token key", async () => {
    const home = makeTmp();
    const p = await command.plan(
      makeCtx({
        env: { HOME: home, USERPROFILE: home },
        options: { cli: "codex", githubAuth: "token" },
      }),
    );
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    const codex = writes.find((w) => w.path.replace(/\\/g, "/").endsWith(".codex/config.toml"));
    const envExample = writes.find((w) => w.path === ".env.example");

    expect(codex?.contents).toContain('[mcp_servers."github"]');
    expect(codex?.contents).toContain('bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"');
    expect(codex?.contents).not.toContain('[mcp_servers."github".headers]');
    expect(codex?.contents).not.toContain("Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}");
    expect(envExample?.contents).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=");
  });

  it("S1/S2 preserves operator TOML while clearing the AIH-managed server block", async () => {
    const root = makeTmp();
    const home = makeTmp();
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.github]",
        'url = "https://github.internal.example/mcp/"',
        "",
        "# >>> aih managed (mcp) >>>",
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
    );
    writeMcpPolicy(root, {
      allowedServers: [],
      allowManagedOnly: true,
      disabledServers: ["github"],
    });

    const p = await command.plan(
      makeCtx({ root, env: { HOME: home, USERPROFILE: home }, options: { cli: "codex" } }),
    );
    const codex = p.actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith(".codex/config.toml"),
    );

    expect(codex?.contents).toContain('model = "gpt-5"');
    expect(codex?.contents).toContain("[mcp_servers.github]");
    expect(codex?.contents).toContain("https://github.internal.example/mcp/");
    expect(codex?.contents).not.toContain("[mcp_servers.context7]");
  });

  it("preserves Codex managed TOML block markers while pruning the final disabled table", () => {
    const existing = [
      'model = "gpt-5"',
      "",
      "# >>> aih managed (mcp) >>>",
      "[mcp_servers.github]",
      'url = "https://api.githubcopilot.com/mcp/"',
      "# <<< aih managed (mcp) <<<",
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");

    const pruned = removeMcpTomlServers(existing, ["github"]);
    const rewritten = upsertTextBlock(
      pruned,
      "mcp",
      '[mcp_servers."code-review-graph"]\ncommand = "uvx"',
    );

    expect(pruned).toContain("# >>> aih managed (mcp) >>>");
    expect(pruned).toContain("# <<< aih managed (mcp) <<<");
    expect(pruned).toContain("[ui]");
    expect(rewritten.match(/# >>> aih managed \(mcp\) >>>/g)).toHaveLength(1);
    expect(rewritten).toContain("[ui]\n");
    expect(rewritten).toContain('theme = "dark"');
  });

  it("removes disabled Codex TOML entries with inline-comment table headers", () => {
    const existing = [
      "[mcp_servers.github] # operator note",
      'url = "https://api.githubcopilot.com/mcp/"',
      "",
      "[mcp_servers.context7] # operator note",
      'url = "https://mcp.context7.com/mcp"',
      "",
      "[mcp_servers.local]",
      'command = "local-mcp"',
      "",
    ].join("\n");

    const pruned = removeMcpTomlServers(existing, ["github", "context7"]);

    expect(pruned).not.toContain("github");
    expect(pruned).not.toContain("api.githubcopilot.com");
    expect(pruned).not.toContain("context7");
    expect(pruned).not.toContain("mcp.context7.com");
    expect(pruned).toContain("[mcp_servers.local]");
    expect(pruned).toContain('command = "local-mcp"');
  });

  it("removes disabled Codex TOML entries with single-quoted table keys", () => {
    const existing = [
      "[mcp_servers.'github']",
      'url = "https://api.githubcopilot.com/mcp/"',
      "",
      "[mcp_servers.'context7'.env]",
      'TOKEN = "$' + '{CONTEXT7_API_KEY}"',
      "",
      "[mcp_servers.local]",
      'command = "local-mcp"',
      "",
    ].join("\n");

    const pruned = removeMcpTomlServers(existing, ["github", "context7"]);

    expect(pruned).not.toContain("github");
    expect(pruned).not.toContain("api.githubcopilot.com");
    expect(pruned).not.toContain("context7");
    expect(pruned).not.toContain("CONTEXT7_API_KEY");
    expect(pruned).toContain("[mcp_servers.local]");
  });

  it("detects existing Codex TOML names with single-quoted table keys", () => {
    const existing = [
      "[mcp_servers.'github']",
      'url = "https://api.githubcopilot.com/mcp/"',
      "",
      "# >>> aih managed (mcp) >>>",
      "[mcp_servers.'context7']",
      'url = "https://mcp.context7.com/mcp"',
      "# <<< aih managed (mcp) <<<",
      "",
    ].join("\n");

    const names = existingMcpTomlNames(existing, "mcp");

    expect(names.has("github")).toBe(true);
    expect(names.has("'github'")).toBe(false);
    expect(names.has("context7")).toBe(false);
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

  it("replaces generated JSON server entries so stale auth fields do not survive", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer pasted-token-value" },
          },
          userLocal: { type: "stdio", command: "local-mcp", args: [] },
        },
      }),
    );

    const p = await command.plan(makeCtx({ root, options: { cli: "claude" } }));
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    if (dotMcp === undefined) throw new Error("expected .mcp.json write");
    const merged = JSON.parse(resolveContents(dotMcp, join(root, ".mcp.json"))) as {
      mcpServers: Record<string, { headers?: unknown }>;
    };

    expect(merged.mcpServers.github?.headers).toBeUndefined();
    expect(merged.mcpServers.userLocal).toBeDefined();
  });

  it("warns when first-run default targeting selects global MCP config files", async () => {
    const root = makeTmp();
    const home = makeTmp();
    const run = fakeRunner((argv) =>
      argv[0] === "which" && ["codex", "gemini"].includes(argv[1] ?? "")
        ? { code: 0, stdout: `/usr/bin/${argv[1]}\n` }
        : { code: 1 },
    );

    const p = await command.plan(makeCtx({ root, env: { HOME: home, USERPROFILE: home }, run }));
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    const targetNotice = p.actions.find(
      (a) => a.kind === "digest" && a.describe === "MCP target selection",
    );

    expect(writes.some((w) => w.path.replace(/\\/g, "/").endsWith(".codex/config.toml"))).toBe(
      true,
    );
    expect(writes.some((w) => w.path.replace(/\\/g, "/").endsWith(".gemini/settings.json"))).toBe(
      true,
    );
    expect(targetNotice?.kind === "digest" ? targetNotice.text : "").toContain(
      "global MCP config files",
    );
    expect(targetNotice?.kind === "digest" ? targetNotice.text : "").toContain(
      "~/.codex/config.toml",
    );
  });

  it("--all-tools writes each tool's OWN MCP config — never Claude's .mcp.json for a TOML/global tool", async () => {
    const p = await command.plan(makeCtx({ options: { allTools: true } }));
    const writes = p.actions.filter((a): a is WriteAction => a.kind === "write");
    const paths = writes.map((w) => w.path.replace(/\\/g, "/"));
    // Repo-relative natives keep their own paths (claude/kimi dedupe to one .mcp.json).
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".cursor/mcp.json");
    expect(paths.some((pa) => pa.endsWith(".config/opencode/opencode.json"))).toBe(true);
    expect(paths.some((pa) => pa.endsWith(".vscode/mcp.json"))).toBe(true);
    // Codex gets its TOML written (external), NOT a .mcp.json it cannot read.
    const codex = writes.find((w) => w.path.replace(/\\/g, "/").endsWith(".codex/config.toml"));
    expect(codex?.external).toBe(true);
    expect(codex?.contents).toContain("[mcp_servers.");
  });
});

describe("aih mcp — enterprise posture (governance gate, opt-in)", () => {
  it("warns when enterprise apply writes policy-denied servers without --mcp-compliant", async () => {
    const p = await command.plan(makeCtx({ options: { posture: "enterprise" } }));
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const warning = p.actions.find(
      (a) => a.kind === "doc" && a.describe === "Enterprise MCP apply warning",
    );

    expect(Object.keys(serversOf(dotMcp as WriteAction))).toContain("context7");
    expect(warning?.kind === "doc" ? warning.text : "").toContain("context7");
    expect(warning?.kind === "doc" ? warning.text : "").toContain("third-party egress");
    expect(warning?.kind === "doc" ? warning.text : "").toContain("mcp --verify");
  });

  it("prints quarantined server details and then verifies the compliant config cleanly", async () => {
    const root = makeTmp();
    const apply = await runMcp([
      "--root",
      root,
      "--cli",
      "claude",
      "--posture",
      "enterprise",
      "--mcp-compliant",
      "--apply",
    ]);
    const verify = await runMcp([
      "--root",
      root,
      "--cli",
      "claude",
      "--posture",
      "enterprise",
      "--mcp-compliant",
      "--verify",
    ]);

    expect(apply.code).toBe(0);
    expect(apply.out).toContain("[digest] — Quarantined MCP servers");
    expect(apply.out).toContain("context7");
    expect(apply.out).toContain("third-party egress");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).not.toContain("context7");
    expect(verify.code).toBe(0);
    expect(verify.out).toContain("Verification:");
    expect(verify.out).toContain("0 failed");
  });

  it("--mcp-compliant verify fails when an exact generated denied server remains on disk", async () => {
    const root = makeTmp();
    const stalePlan = await command.plan(makeCtx({ root, options: { posture: "enterprise" } }));
    const staleWrite = stalePlan.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const staleServers = serversOf(staleWrite as WriteAction);
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({ mcpServers: { context7: staleServers.context7 } }),
    );

    const verify = await runMcp([
      "--root",
      root,
      "--cli",
      "claude",
      "--posture",
      "enterprise",
      "--mcp-compliant",
      "--verify",
    ]);

    expect(verify.code).toBe(1);
    expect(verify.out).toContain("MCP configs contain no quarantined generated servers");
    expect(verify.out).toContain("context7");
    expect(verify.out).toContain("rerun with --apply");
  });

  it("--mcp-compliant drops denied servers, quarantines them in guidance, and verifies clean", async () => {
    const ctx = makeCtx({
      options: { posture: "enterprise", mcpCompliant: true },
      verify: true,
    });
    const p = await command.plan(ctx);
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const servers = serversOf(dotMcp as WriteAction);
    const quarantine = p.actions.find(
      (a) => a.kind === "doc" && a.describe === "Quarantined MCP servers",
    );
    const policyProbe = p.actions.find(
      (a) => a.kind === "probe" && a.describe === "MCP servers comply with enterprise policy",
    );
    const check = policyProbe?.kind === "probe" ? await policyProbe.run(ctx) : undefined;

    expect(Object.keys(servers)).toContain("code-review-graph");
    expect(Object.keys(servers)).not.toContain("context7");
    expect(quarantine?.kind === "doc" ? quarantine.text : "").toContain("context7");
    expect(quarantine?.kind === "doc" ? quarantine.text : "").toContain("third-party egress");
    expect(check?.verdict).toBe("pass");
  });

  it("--mcp-compliant keeps reviewed third-party egress approvals", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["context7"],
          approvals: [
            {
              server: "context7",
              subject: context7ApprovalSubject(),
              acceptEgress: true,
              reason: "approved docs lookup",
              reviewer: "security",
              approvedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const p = await command.plan(
      makeCtx({ root, options: { posture: "enterprise", mcpCompliant: true } }),
    );
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const managed = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".claude/managed-settings.json",
    );
    const governance = p.actions.find(
      (a) =>
        a.kind === "doc" &&
        a.describe ===
          "MCP governance (enterprise posture) — per-server verdicts + skipped-with-reason",
    );

    expect(Object.keys(serversOf(dotMcp as WriteAction))).toContain("context7");
    expect(JSON.stringify(managed?.json)).toContain("code-review-graph@2.3.6");
    expect(governance?.kind === "doc" ? governance.text : "").toContain(
      "third-party egress accepted by org policy",
    );
  });

  it("--mcp-compliant removes denied generated servers when merging an existing .mcp.json", async () => {
    const root = makeTmp();
    const remotePlan = await command.plan(makeCtx({ root, options: { scope: "remote" } }));
    const remoteWrite = remotePlan.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const remoteServers = serversOf(remoteWrite as WriteAction);
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({
        mcpServers: {
          "better-email": remoteServers["better-email"],
          context7: remoteServers.context7,
          existingLocal: { type: "stdio", command: "custom-mcp", args: ["serve"] },
        },
      }),
    );

    const p = await command.plan(
      makeCtx({ root, options: { posture: "enterprise", mcpCompliant: true } }),
    );
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const merged = JSON.parse(resolveContents(dotMcp as WriteAction, join(root, ".mcp.json"))) as {
      mcpServers: Record<string, unknown>;
    };
    const quarantine = p.actions.find(
      (a) => a.kind === "doc" && a.describe === "Quarantined MCP servers",
    );

    expect(Object.keys(merged.mcpServers)).not.toContain("better-email");
    expect(Object.keys(merged.mcpServers)).not.toContain("context7");
    expect(Object.keys(merged.mcpServers)).toContain("existingLocal");
    expect(quarantine?.kind === "doc" ? quarantine.text : "").toContain("better-email");
  });

  it("--mcp-compliant preserves a same-name operator-remediated server", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({
        mcpServers: {
          context7: { type: "http", url: "https://context7.internal.example/mcp" },
        },
      }),
    );

    const p = await command.plan(
      makeCtx({ root, options: { posture: "enterprise", mcpCompliant: true } }),
    );
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const merged = JSON.parse(resolveContents(dotMcp as WriteAction, join(root, ".mcp.json"))) as {
      mcpServers: Record<string, { url?: string }>;
    };

    expect(merged.mcpServers.context7?.url).toBe("https://context7.internal.example/mcp");
  });

  it("writes a real managed-settings MCP allowlist under enterprise posture", async () => {
    const p = await command.plan(makeCtx({ options: { posture: "enterprise" } }));
    const managed = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".claude/managed-settings.json",
    );
    expect(managed).toBeDefined();
    expect(managed?.merge).toBe(true);
    expect(managed?.json).toMatchObject({ allowManagedMcpServersOnly: true });
    expect(JSON.stringify(managed?.json)).toContain("code-review-graph@2.3.6");
  });

  it("does not auto-pass hosted GitHub when org-policy declares no incumbent GitHub host", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["code-review-graph"],
          allowManagedOnly: true,
          incumbentHosts: [],
        },
      }),
    );
    const ctx = makeCtx({ root, options: { posture: "enterprise" }, verify: true });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check?.verdict).toBe("fail");
    expect(check?.detail).toContain("github");
    expect(check?.detail).toContain("set host");
    expect(check?.detail).toContain("disable");
  });

  it("uses a configured GitHub host instead of the hardcoded hosted default", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          githubHost: "https://github.internal.example",
          incumbentHosts: ["github.internal.example"],
        },
      }),
    );
    const p = await command.plan(makeCtx({ root }));
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://github.internal.example/mcp/");
    expect(gh.url).not.toBe("https://api.githubcopilot.com/mcp/");
  });

  it("uses GITHUB_HOST when no policy GitHub host is set", async () => {
    const p = await command.plan(makeCtx({ env: { GITHUB_HOST: "https://github.env.example" } }));
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");

    expect(gh.type).toBe("http");
    if (gh.type !== "http") throw new Error("expected http server");
    expect(gh.url).toBe("https://github.env.example/mcp/");
  });

  it("does not classify a GITHUB_HOST override as incumbent without org-policy", async () => {
    const ctx = makeCtx({
      env: { GITHUB_HOST: "https://unreviewed.example" },
      options: { posture: "enterprise" },
      verify: true,
    });
    const p = await command.plan(ctx);
    const gh = pick(serversOf(p.actions.find((a) => a.kind === "write") as WriteAction), "github");
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(gh.egress).toBe("third-party");
    expect(check?.detail).toContain("github");
  });

  it("keeps hosted GitHub allowed when org-policy declares its host incumbent", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["code-review-graph", "github"],
          allowManagedOnly: true,
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );
    const ctx = makeCtx({ root, options: { posture: "enterprise" }, verify: true });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check?.detail).not.toContain("github");
  });

  it("can disable the hosted GitHub server through org-policy", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          disabledServers: ["github"],
        },
      }),
    );
    const p = await command.plan(makeCtx({ root }));
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;

    expect(Object.keys(serversOf(w))).not.toContain("github");
  });

  it("preserves non-identical same-name entries when their servers are disabled", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, ".mcp.json"),
      jsonFile({
        mcpServers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
          context7: { type: "http", url: "https://mcp.context7.com/mcp" },
          existingLocal: { type: "stdio", command: "custom-mcp", args: ["serve"] },
        },
      }),
    );
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          disabledServers: ["github", "context7"],
        },
      }),
    );
    const p = await command.plan(makeCtx({ root }));
    const w = p.actions.find((a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json");
    const merged = JSON.parse(resolveContents(w as WriteAction, join(root, ".mcp.json"))) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(merged.mcpServers)).toContain("github");
    expect(Object.keys(merged.mcpServers)).toContain("context7");
    expect(Object.keys(merged.mcpServers)).toContain("existingLocal");
  });

  it("ignores an invalid ambient GITHUB_HOST when org-policy disables GitHub", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          disabledServers: ["github"],
        },
      }),
    );
    const p = await command.plan(
      makeCtx({ root, env: { GITHUB_HOST: "github.internal.example" } }),
    );
    const w = p.actions.find((a) => a.kind === "write") as WriteAction;

    expect(Object.keys(serversOf(w))).not.toContain("github");
    expect(p.actions.some((a) => a.kind === "probe" && a.describe === "org-policy parse")).toBe(
      false,
    );
  });

  it("intersects the managed MCP allowlist with org-policy grants", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    const p = await command.plan(makeCtx({ root, options: { posture: "enterprise" } }));
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const managed = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".claude/managed-settings.json",
    );

    if (dotMcp === undefined) throw new Error("expected .mcp.json write");
    expect(Object.keys(serversOf(dotMcp))).not.toContain("sequential-thinking");
    const managedJson = JSON.stringify(managed?.json);
    expect(managedJson).toContain("code-review-graph@2.3.6");
    expect(managedJson).not.toContain("server-sequential-thinking");
  });

  it("replaces stale managed MCP allowlist entries during JSON merge", async () => {
    const root = makeTmp();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "managed-settings.json"),
      jsonFile({
        localOnly: true,
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.3.6", "serve"] }],
      }),
    );
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["code-review-graph", "sequential-thinking"],
          allowManagedOnly: true,
          disabledServers: ["code-review-graph"],
        },
      }),
    );

    const p = await command.plan(makeCtx({ root, options: { posture: "enterprise" } }));
    const managed = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".claude/managed-settings.json",
    );
    if (managed === undefined) throw new Error("expected managed-settings write");
    const merged = JSON.parse(
      resolveContents(managed, join(root, ".claude", "managed-settings.json")),
    ) as { localOnly?: boolean; allowedMcpServers?: unknown[] };
    const allowlist = JSON.stringify(merged.allowedMcpServers);

    expect(merged.localOnly).toBe(true);
    expect(allowlist).toContain("server-sequential-thinking");
    expect(allowlist).not.toContain("code-review-graph");
  });

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

  it("lets org-policy approved third-party MCP egress pass the enterprise probe with a visible reason", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["context7"],
          approvals: [
            {
              server: "context7",
              subject: context7ApprovalSubject(),
              acceptEgress: true,
              reason: "legal approved hosted docs lookup",
              reviewer: "security-platform",
              approvedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );
    const ctx = makeCtx({ root, options: { posture: "enterprise" }, verify: true });
    const p = await command.plan(ctx);
    const govText = p.actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check).toMatchObject({ verdict: "pass" });
    expect(govText).toContain("Warn (1)");
    expect(govText).toContain("context7");
    expect(govText).toContain("legal approved hosted docs lookup");
  });

  it("uses AIH_ORG_POLICY as the winning source over a committed local MCP approval", async () => {
    const root = makeTmp();
    writeFileSync(
      join(root, "aih-org-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["context7"],
          approvals: [
            {
              server: "context7",
              subject: context7ApprovalSubject(),
              acceptEgress: true,
              reason: "local repo approval should not win over fleet policy",
              approvedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );
    writeFileSync(
      join(root, "operator-policy.json"),
      jsonFile({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["github"],
          incumbentHosts: ["api.githubcopilot.com"],
        },
      }),
    );

    const ctx = makeCtx({
      root,
      env: { AIH_ORG_POLICY: "operator-policy.json" },
      options: { posture: "enterprise" },
      verify: true,
    });
    const p = await command.plan(ctx);
    const probe = p.actions.find(
      (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
    );
    const check = probe?.kind === "probe" ? await probe.run(ctx) : undefined;

    expect(check).toMatchObject({ verdict: "fail", code: "mcp.policy-denied" });
    expect(check?.detail).toContain("context7");
    expect(check?.detail).not.toContain("local repo approval should not win");
  });

  it("plans mcp approve as a local org-policy write with review evidence", async () => {
    const root = makeTmp();
    const p = await mcpApproveCommand.plan(
      makeCtx({
        root,
        options: {
          server: "context7",
          acceptEgress: true,
          reason: "vendor risk accepted for docs lookup",
          reviewer: "security-platform",
        },
      }),
    );
    const write = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === "aih-org-policy.json",
    );

    expect(write?.json).toMatchObject({
      schemaVersion: 1,
      minimumPosture: "enterprise",
      mcp: {
        allowedServers: ["context7"],
        approvals: [
          {
            server: "context7",
            subject: context7ApprovalSubject(),
            acceptEgress: true,
            reason: "vendor risk accepted for docs lookup",
            reviewer: "security-platform",
          },
        ],
      },
    });
    const approval = (
      write?.json as { mcp?: { approvals?: Array<{ approvedAt?: string; subject?: string }> } }
    )?.mcp?.approvals?.[0];
    expect(approval?.approvedAt).toBe("0000-00-00T00:00:00.000Z");
    expect(approval?.subject).toBe(context7ApprovalSubject());
    expect(write?.describe).toContain("Preview creating local org policy");
    expect(write?.describe).toContain("approvedAt is set when rerun with --apply");
  });

  it("refuses mcp approve local writes while AIH_ORG_POLICY is active", () => {
    expect(() =>
      mcpApproveCommand.plan(
        makeCtx({
          env: { AIH_ORG_POLICY: "operator-policy.json" },
          options: {
            server: "context7",
            acceptEgress: true,
            reason: "vendor risk accepted for docs lookup",
          },
        }),
      ),
    ).toThrow(/AIH_ORG_POLICY is active/);
  });

  it("refuses mcp approve when the server is not in the current catalog", () => {
    expect(() =>
      mcpApproveCommand.plan(
        makeCtx({
          options: {
            server: "not-a-catalog-server",
            acceptEgress: true,
            reason: "vendor risk accepted for docs lookup",
          },
        }),
      ),
    ).toThrow(/not in the current MCP catalog/);
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

  it("default vibe posture adds NO governance doc and NO policy probe", async () => {
    const p = await command.plan(makeCtx({ options: {} }));
    expect(p.actions.some((a) => a.kind === "doc")).toBe(false);
    expect(
      p.actions.some(
        (a) => a.kind === "probe" && a.describe.includes("comply with enterprise policy"),
      ),
    ).toBe(false);
  });
});
