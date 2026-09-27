import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_REVIEW_GRAPH_ALLOWED_TOOLS,
  CodeReviewGraphMcpPolicyGuard,
  isolatedCodeReviewGraphEnvironment,
} from "../../src/ecc-profile/code-review-graph-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { project: string; state: string; cache: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "aih-crg-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-crg-state-")));
  const cache = realpathSync(mkdtempSync(join(tmpdir(), "aih-crg-cache-")));
  roots.push(project, state, cache);
  return { project, state, cache };
}

describe("Code Review Graph 2.3.9 runtime boundary", () => {
  it("normalizes the Windows Path spelling without admitting unrelated environment variables", () => {
    const { state, cache } = fixture();
    const child = isolatedCodeReviewGraphEnvironment(
      { Path: "host-search-path", UNRELATED_SETTING: "private" },
      state,
      cache,
    );
    expect(child.PATH).toBe("host-search-path");
    expect(child).not.toHaveProperty("UNRELATED_SETTING");
  });

  it("rejects a relative or regular-file project before accepting requests", () => {
    const { state } = fixture();
    const file = join(state, "not-a-directory");
    writeFileSync(file, "fixture");
    expect(() => new CodeReviewGraphMcpPolicyGuard("relative-project")).toThrow("must be absolute");
    expect(() => new CodeReviewGraphMcpPolicyGuard(file)).toThrow("must be a real directory");
  });

  it("rejects malformed calls and refuses invalid explicit roots while forwarding initialization", () => {
    const { project } = fixture();
    const guard = new CodeReviewGraphMcpPolicyGuard(project);
    expect(guard.inspectClientRequest({ method: "initialize", id: 1 })).toEqual({ forward: true });
    for (const malformed of [null, 42, "request"]) {
      expect(() => guard.inspectClientRequest(malformed)).toThrow("malformed");
    }
    const call = { method: "tools/call", id: 1 };
    for (const id of [undefined, true, {}]) {
      expect(() => guard.inspectClientRequest({ ...call, id })).toThrow("request id");
    }
    for (const params of [null, 42, {}, { name: 7 }]) {
      expect(() => guard.inspectClientRequest({ ...call, params })).toThrow("malformed");
    }
    const name = "get_review_context_tool";
    for (const args of [null, [], "arguments"]) {
      expect(() =>
        guard.inspectClientRequest({ ...call, params: { name, arguments: args } }),
      ).toThrow("malformed Code Review Graph tool arguments");
    }
    for (const repoRoot of [42, "relative-root", join(project, "missing")]) {
      expect(
        guard.inspectClientRequest({
          ...call,
          params: { name, arguments: { repo_root: repoRoot } },
        }),
      ).toMatchObject({ forward: false, response: { id: 1, error: { code: -32002 } } });
    }
    expect(guard.inspectClientRequest({ ...call, params: { name } })).toEqual({ forward: true });
  });

  it("rejects malformed or duplicate upstream tool descriptions before filtering", () => {
    const { project } = fixture();
    const guard = new CodeReviewGraphMcpPolicyGuard(project);
    for (const result of [null, 42, {}, { tools: "invalid" }]) {
      expect(() => guard.filterToolsList(result)).toThrow("response is malformed");
    }
    for (const tool of [null, 42, {}, { name: 7 }]) {
      expect(() => guard.filterToolsList({ tools: [tool] })).toThrow("malformed tool");
    }
    const tool = { name: CODE_REVIEW_GRAPH_ALLOWED_TOOLS[0] };
    expect(() => guard.filterToolsList({ tools: [tool, tool] })).toThrow("duplicate");
  });

  it("builds a child environment from a narrow host allowlist and strips every cloud family", () => {
    const { state, cache } = fixture();
    const parent = {
      PATH: "safe-path",
      SystemRoot: "C:\\Windows",
      HOME: "/home/alice",
      CRG_OPENAI_API_KEY: "fake-openai",
      CRG_OPENAI_BASE_URL: "https://fake.invalid",
      CRG_OPENAI_MODEL: "fake-model",
      MINIMAX_API_KEY: "fake-minimax",
      VOYAGE_API_KEY: "fake-voyage",
      CRG_VOYAGE_BASE_URL: "https://voyage.invalid",
      CRG_VOYAGE_MODEL: "fake-voyage-model",
      GOOGLE_API_KEY: "fake-google",
      CRG_ACCEPT_CLOUD_EMBEDDINGS: "1",
      CRG_EMBEDDING_MODEL: "fake-ambient-model",
      CRG_ALLOW_REMOTE_CODE: "1",
      OPENAI_API_KEY: "unrelated-but-still-not-forwarded",
      SECRET_FROM_ANOTHER_TOOL: "must-not-cross-boundary",
      HF_HUB_OFFLINE: "0",
      TRANSFORMERS_OFFLINE: "0",
      UV_PROJECT_ENVIRONMENT: "/ambient/venv",
    } satisfies NodeJS.ProcessEnv;

    const child = isolatedCodeReviewGraphEnvironment(parent, state, cache);

    expect(child).toMatchObject({
      PATH: "safe-path",
      SystemRoot: "C:\\Windows",
      CRG_DATA_DIR: state,
      UV_CACHE_DIR: cache,
      UV_PROJECT_ENVIRONMENT: join(state, "runtime-env"),
      UV_OFFLINE: "1",
      UV_NO_ENV_FILE: "1",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
    for (const key of [
      "CRG_OPENAI_API_KEY",
      "CRG_OPENAI_BASE_URL",
      "CRG_OPENAI_MODEL",
      "MINIMAX_API_KEY",
      "VOYAGE_API_KEY",
      "CRG_VOYAGE_BASE_URL",
      "CRG_VOYAGE_MODEL",
      "GOOGLE_API_KEY",
      "CRG_ACCEPT_CLOUD_EMBEDDINGS",
      "CRG_EMBEDDING_MODEL",
      "CRG_ALLOW_REMOTE_CODE",
      "OPENAI_API_KEY",
      "SECRET_FROM_ANOTHER_TOOL",
    ]) {
      expect(child).not.toHaveProperty(key);
    }
    expect(parent.CRG_OPENAI_API_KEY).toBe("fake-openai");
  });

  it("forwards the exact five local operations and fixes them to the configured root", () => {
    const { project } = fixture();
    const guard = new CodeReviewGraphMcpPolicyGuard(project);

    for (const name of CODE_REVIEW_GRAPH_ALLOWED_TOOLS) {
      const decision = guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: name,
        method: "tools/call",
        params: { name, arguments: { repo_root: project } },
      });
      expect(decision).toEqual({ forward: true });
    }
  });

  it("fails closed on explicit embedding refresh, a foreign root, or an excluded tool", () => {
    const { project } = fixture();
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), "aih-crg-foreign-")));
    roots.push(foreign);
    const guard = new CodeReviewGraphMcpPolicyGuard(project);
    const call = (name: string, args: Record<string, unknown>) =>
      guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: args },
      });

    expect(call("build_or_update_graph_tool", { embedding_provider: "openai" })).toMatchObject({
      forward: false,
      response: { error: { code: -32003 } },
    });
    expect(call("build_or_update_graph_tool", { embedding_model: "fake-model" })).toMatchObject({
      forward: false,
      response: { error: { code: -32003 } },
    });
    expect(call("get_review_context_tool", { repo_root: foreign })).toMatchObject({
      forward: false,
      response: { error: { code: -32002 } },
    });
    expect(call("embed_graph_tool", { repo_root: project })).toMatchObject({
      forward: false,
      response: { error: { code: -32601 } },
    });
  });

  it("filters tools/list to the reviewed order and rejects an incomplete upstream surface", () => {
    const { project } = fixture();
    const guard = new CodeReviewGraphMcpPolicyGuard(project);
    const tools = [
      ...[...CODE_REVIEW_GRAPH_ALLOWED_TOOLS]
        .reverse()
        .map((name) => ({ name, description: name })),
      { name: "embed_graph_tool", description: "excluded" },
    ];
    expect(guard.filterToolsList({ tools }).tools.map((tool) => tool.name)).toEqual(
      CODE_REVIEW_GRAPH_ALLOWED_TOOLS,
    );
    expect(() => guard.filterToolsList({ tools: tools.slice(1) })).toThrow(
      /missing reviewed tools/i,
    );
  });
});
