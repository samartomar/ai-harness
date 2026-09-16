import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
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
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  createDeveloperToolReconciler,
  type DeveloperToolRuntimeOperation,
} from "../../src/tools/developer-tools-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function context(): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-runtime-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-runtime-state-")));
  roots.push(root, state);
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: process.env.PATH };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
}

function operation(id: string): DeveloperToolRuntimeOperation {
  return async ({ layout }) => {
    const ownedPaths = [];
    if (id === "serena") {
      mkdirSync(layout.serenaStateRoot, { recursive: true });
      const path = join(layout.serenaStateRoot, "serena_config.yml");
      const contents = "managed fixture\n";
      if (!existsSync(path)) writeFileSync(path, contents);
      ownedPaths.push({ path, sha256: sha(contents), ownership: "file" as const });
    }
    return {
      state: "verified",
      detail: `${id} fixture verified`,
      sourceDigest: sha(`source:${id}`),
      ownedPaths,
      changed: false,
    };
  };
}

describe("developer-tool runtime receipts", () => {
  it("persists project-scoped identity and reuses the same receipt for the worktree", async () => {
    const ctx = context();
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        "code-review-graph": operation("code-review-graph"),
        "codebase-memory-mcp": operation("codebase-memory-mcp"),
        serena: operation("serena"),
        context7: operation("context7"),
        markitdown: operation("markitdown"),
        playwright: operation("playwright"),
        "token-optimizer": operation("token-optimizer"),
      },
    });

    for (const id of [
      "code-review-graph",
      "codebase-memory-mcp",
      "serena",
      "token-optimizer",
      "context7",
      "markitdown",
      "playwright",
    ] as const) {
      await reconcile({
        id,
        ctx,
        selected: true,
        acceptTokenOptimizerLicense: true,
        tokenOptimizerProfile: "quiet",
      });
    }

    const layout = defaultNativeRuntimeLayout(ctx);
    const receipt = JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8"));
    expect(receipt).toMatchObject({
      version: "aih-developer-tools-receipt/v1",
      canonicalRoot: realpathSync(ctx.root),
      tools: {
        "code-review-graph": { sourceDigest: sha("source:code-review-graph") },
        "codebase-memory-mcp": { sourceDigest: sha("source:codebase-memory-mcp") },
        serena: { sourceDigest: sha("source:serena") },
        context7: { sourceDigest: sha("source:context7") },
        markitdown: { sourceDigest: sha("source:markitdown") },
        playwright: { sourceDigest: sha("source:playwright") },
      },
    });
    expect(receipt.tools["token-optimizer"]).toBeUndefined();
    expect(layout.runtimeReceiptPath.startsWith(layout.projectStateRoot)).toBe(true);
  });

  it.each(["code-review-graph", "codebase-memory-mcp", "context7", "playwright"] as const)(
    "rejects a forged same-root $id ownership claim without deleting project data",
    (id) => {
      const ctx = context();
      const layout = defaultNativeRuntimeLayout(ctx);
      const ownedRoot =
        id === "code-review-graph"
          ? layout.graphStateRoot
          : id === "codebase-memory-mcp"
            ? layout.memoryStateRoot
            : layout.projectStateRoot;
      const preserved = join(ownedRoot, `${id}-preserved.data`);
      const contents = `preserved ${id} data\n`;
      mkdirSync(ownedRoot, { recursive: true });
      writeFileSync(preserved, contents);
      writeFileSync(
        layout.runtimeReceiptPath,
        `${JSON.stringify({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: realpathSync(ctx.root),
          tools: {
            [id]: {
              sourceDigest: sha(`source:${id}`),
              ownedPaths: [{ path: preserved, sha256: sha(contents), ownership: "file" }],
            },
          },
        })}\n`,
      );

      expect(() => createDeveloperToolReconciler(ctx)).toThrow(
        `${id} does not support receipt-owned files`,
      );
      expect(readFileSync(preserved, "utf8")).toBe(contents);
    },
  );

  it("rejects a forged Serena claim for a same-root file other than its generated config", () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const preserved = join(layout.serenaStateRoot, "custom.yml");
    const contents = "operator-owned Serena data\n";
    mkdirSync(layout.serenaStateRoot, { recursive: true });
    writeFileSync(preserved, contents);
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [{ path: preserved, sha256: sha(contents), ownership: "file" }],
          },
        },
      })}\n`,
    );

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(
      "serena ownership receipt path is not a supported generated artifact",
    );
    expect(readFileSync(preserved, "utf8")).toBe(contents);
  });

  it("rejects a linked Serena state ancestor before reading or deleting outside data", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "aih-serena-outside-state-")));
    roots.push(outside);
    const outsideConfig = join(outside, "serena_config.yml");
    const contents = "outside Serena data\n";
    mkdirSync(layout.projectStateRoot, { recursive: true });
    writeFileSync(outsideConfig, contents);
    symlinkSync(outside, layout.serenaStateRoot, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [
              {
                path: join(layout.serenaStateRoot, "serena_config.yml"),
                sha256: sha(contents),
                ownership: "file",
              },
            ],
          },
        },
      })}\n`,
    );
    const reconcile = createDeveloperToolReconciler(ctx);

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: false,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("receipt-owned path has a non-directory or linked ancestor");
    expect(readFileSync(outsideConfig, "utf8")).toBe(contents);
  });

  it("removes unchanged owned integration on exclusion and preserves custom files", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: { serena: operation("serena") },
    });
    await reconcile({
      id: "serena",
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet",
    });
    const custom = join(layout.serenaStateRoot, "custom.yml");
    writeFileSync(custom, "operator owned\n");

    const excluded = await reconcile({
      id: "serena",
      ctx,
      selected: false,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet",
    });

    expect(excluded).toMatchObject({ state: "policy-excluded", changed: true });
    expect(existsSync(join(layout.serenaStateRoot, "serena_config.yml"))).toBe(false);
    expect(readFileSync(custom, "utf8")).toBe("operator owned\n");
  });

  it("ceases receipt-owned Serena configuration when a later runtime policy excludes it", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const normalOperation = operation("serena");
    let excluded = false;
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        serena: async (request) => {
          if (!excluded) return normalOperation(request);
          return {
            state: "policy-excluded",
            detail: "Serena is disabled by the effective policy",
            sourceDigest: sha("source:serena"),
            ownedPaths: [],
            changed: false,
          };
        },
      },
    });
    const request = {
      id: "serena" as const,
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet" as const,
    };
    await reconcile(request);
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    expect(existsSync(config)).toBe(true);

    excluded = true;
    await expect(reconcile(request)).resolves.toMatchObject({
      state: "policy-excluded",
      detail: "Serena is disabled by the effective policy",
      changed: true,
    });
    expect(existsSync(config)).toBe(false);
    expect(
      JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8")).tools.serena,
    ).toBeUndefined();
  });

  it("keeps unchanged receipt-owned Serena configuration across a repeat reconciliation", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: { serena: operation("serena") },
    });
    const request = {
      id: "serena" as const,
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet" as const,
    };
    await reconcile(request);
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    const receiptBefore = readFileSync(layout.runtimeReceiptPath, "utf8");

    await expect(reconcile(request)).resolves.toMatchObject({
      state: "verified",
      changed: false,
    });
    expect(readFileSync(config, "utf8")).toBe("managed fixture\n");
    expect(readFileSync(layout.runtimeReceiptPath, "utf8")).toBe(receiptBefore);
  });

  it("blocks exclusion when receipt-owned material changed and preserves it", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: { serena: operation("serena") },
    });
    await reconcile({
      id: "serena",
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet",
    });
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    writeFileSync(config, "operator changed\n");

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: false,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("changed since the ownership receipt");
    expect(readFileSync(config, "utf8")).toBe("operator changed\n");
  });

  it("delegates Token Optimizer exclusion to its production cleanup operation", async () => {
    const ctx = context();
    const selections: boolean[] = [];
    const reconcile = createDeveloperToolReconciler(ctx, {
      production: {
        tokenOptimizer: async (input) => {
          selections.push(input.selected);
          return {
            toolId: "token-optimizer",
            state: "policy-excluded",
            detail: "unchanged Token Optimizer integration removed",
            changed: true,
          };
        },
      },
    });

    const excluded = await reconcile({
      id: "token-optimizer",
      ctx,
      selected: false,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet",
    });

    expect(selections).toEqual([false]);
    expect(excluded).toEqual({
      id: "token-optimizer",
      state: "policy-excluded",
      detail: "unchanged Token Optimizer integration removed",
      changed: true,
    });
  });

  it("rejects a reconciliation call that changes its PlanContext identity before runtime work", async () => {
    const ctx = context();
    let calls = 0;
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        serena: async () => {
          calls += 1;
          return {
            state: "verified",
            detail: "unexpected operation",
            sourceDigest: sha("unexpected"),
            ownedPaths: [],
            changed: false,
          };
        },
      },
    });
    const changedContext = { ...ctx, env: { ...ctx.env } };

    await expect(
      reconcile({
        id: "serena",
        ctx: changedContext,
        selected: true,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("developer-tool reconciler context changed");
    expect(calls).toBe(0);
  });

  it("rejects a project-contained runtime state before materializing it", () => {
    const ctx = context();
    ctx.env.XDG_STATE_HOME = ctx.root;

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(
      "developer-tool project state must remain outside and disjoint from the project",
    );
    expect(existsSync(join(ctx.root, "aih"))).toBe(false);
  });

  it("rejects structurally unsafe ownership receipts before any reconciliation work", () => {
    const scenarios = [
      {
        label: "non-object tools",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: root,
          tools: null,
        }),
        message: "developer-tool runtime receipt tools must be an object",
      },
      {
        label: "unexpected top-level field",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: root,
          tools: {},
          unexpected: true,
        }),
        message: "developer-tool runtime receipt has unsupported or missing fields",
      },
      {
        label: "foreign canonical worktree",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: join(root, "foreign-project"),
          tools: {},
        }),
        message: "developer-tool runtime receipt does not belong to this canonical worktree",
      },
      {
        label: "unknown tool",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: root,
          tools: { unreviewed_tool: {} },
        }),
        message: "developer-tool runtime receipt contains an unsupported tool",
      },
      {
        label: "invalid source digest",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: root,
          tools: { serena: { sourceDigest: "forged", ownedPaths: [] } },
        }),
        message: "serena receipt source digest is invalid",
      },
      {
        label: "non-array owned paths",
        make: (root: string) => ({
          version: "aih-developer-tools-receipt/v1",
          canonicalRoot: root,
          tools: { serena: { sourceDigest: sha("source:serena"), ownedPaths: {} } },
        }),
        message: "serena receipt ownedPaths is invalid",
      },
    ];

    for (const scenario of scenarios) {
      const ctx = context();
      const layout = defaultNativeRuntimeLayout(ctx);
      mkdirSync(layout.projectStateRoot, { recursive: true });
      writeFileSync(
        layout.runtimeReceiptPath,
        `${JSON.stringify(scenario.make(realpathSync(ctx.root)))}\n`,
      );

      expect(() => createDeveloperToolReconciler(ctx), scenario.label).toThrow(scenario.message);
    }
  });

  it("rejects duplicate receipt-owned Serena paths before a cleanup can run", () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    const contents = "managed fixture\n";
    mkdirSync(layout.serenaStateRoot, { recursive: true });
    writeFileSync(config, contents);
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [
              { path: config, sha256: sha(contents), ownership: "file" },
              { path: config, sha256: sha(contents), ownership: "file" },
            ],
          },
        },
      })}\n`,
    );

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(
      "serena receipt contains duplicate owned paths",
    );
    expect(readFileSync(config, "utf8")).toBe(contents);
  });

  it("rejects a non-UTF-8 ownership receipt before operation dispatch", () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    mkdirSync(layout.projectStateRoot, { recursive: true });
    writeFileSync(layout.runtimeReceiptPath, Buffer.from([0xff, 0xfe, 0xfd]));

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(
      "developer-tool runtime receipt is not valid UTF-8",
    );
  });

  it("removes a stale receipt when its generated Serena file was already removed", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: { serena: operation("serena") },
    });
    const request = {
      id: "serena" as const,
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet" as const,
    };
    await reconcile(request);
    rmSync(layout.serenaStateRoot, { recursive: true, force: true });

    await expect(reconcile({ ...request, selected: false })).resolves.toMatchObject({
      state: "policy-excluded",
      changed: true,
    });
    expect(
      JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8")).tools.serena,
    ).toBeUndefined();
  });

  it("rejects a selected operation with an invalid source identity", async () => {
    const ctx = context();
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        serena: async () => ({
          state: "verified",
          detail: "forged result",
          sourceDigest: "not-a-sha256",
          ownedPaths: [],
          changed: false,
        }),
      },
    });

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: true,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("serena operation returned an invalid source digest");
  });

  it("detects receipt replacement between operation completion and receipt save", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        serena: async () => {
          const config = join(layout.serenaStateRoot, "serena_config.yml");
          const contents = "managed fixture\n";
          mkdirSync(layout.serenaStateRoot, { recursive: true });
          writeFileSync(config, contents);
          writeFileSync(layout.runtimeReceiptPath, "tampered between operation and save\n");
          return {
            state: "verified",
            detail: "fixture verified",
            sourceDigest: sha("source:serena"),
            ownedPaths: [{ path: config, sha256: sha(contents), ownership: "file" as const }],
            changed: false,
          };
        },
      },
    });

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: true,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("developer-tool runtime receipt changed during reconciliation");
  });

  it("rejects a Token Optimizer cleanup result that is not a terminal exclusion", async () => {
    const ctx = context();
    const reconcile = createDeveloperToolReconciler(ctx, {
      production: {
        tokenOptimizer: async () => ({
          toolId: "token-optimizer",
          state: "verified",
          detail: "fixture incorrectly retained setup",
          changed: false,
        }),
      },
    });

    await expect(
      reconcile({
        id: "token-optimizer",
        ctx,
        selected: false,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("token-optimizer exclusion did not report policy-excluded");
  });

  it.each([
    {
      label: "a relative path",
      kind: "relative",
      message: "serena ownership receipt path is invalid",
    },
    {
      label: "a path escaping the Serena state root",
      kind: "escape",
      message: "serena ownership receipt path escapes its project state root",
    },
  ])("rejects $label in an ownership receipt", ({ kind, message }) => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const path =
      kind === "relative"
        ? "relative-config.yml"
        : join(layout.serenaStateRoot, "..", "escaped.yml");
    mkdirSync(layout.projectStateRoot, { recursive: true });
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [{ path, sha256: sha("fixture"), ownership: "file" }],
          },
        },
      })}\n`,
    );

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(message);
  });

  it("does not unlink a receipt-owned Serena config that was replaced by a directory", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [{ path: config, sha256: sha("managed fixture\n"), ownership: "file" }],
          },
        },
      })}\n`,
    );
    const reconcile = createDeveloperToolReconciler(ctx);

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: false,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("receipt-owned path is not a safe regular file");
    expect(existsSync(config)).toBe(true);
  });

  it("rejects a receipt path that is not a regular file before dispatching operations", () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    mkdirSync(layout.runtimeReceiptPath, { recursive: true });

    expect(() => createDeveloperToolReconciler(ctx)).toThrow(
      "developer-tool runtime receipt is not a safe regular file",
    );
  });

  it("does not unlink a hard-linked receipt-owned Serena config", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    const config = join(layout.serenaStateRoot, "serena_config.yml");
    const alternate = join(layout.serenaStateRoot, "alternate.yml");
    const contents = "managed fixture\n";
    mkdirSync(layout.serenaStateRoot, { recursive: true });
    writeFileSync(config, contents);
    linkSync(config, alternate);
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: realpathSync(ctx.root),
        tools: {
          serena: {
            sourceDigest: sha("source:serena"),
            ownedPaths: [{ path: config, sha256: sha(contents), ownership: "file" }],
          },
        },
      })}\n`,
    );
    const reconcile = createDeveloperToolReconciler(ctx);

    await expect(
      reconcile({
        id: "serena",
        ctx,
        selected: false,
        acceptTokenOptimizerLicense: false,
        tokenOptimizerProfile: "quiet",
      }),
    ).rejects.toThrow("receipt-owned path is not an unambiguous regular file");
    expect(readFileSync(config, "utf8")).toBe(contents);
    expect(readFileSync(alternate, "utf8")).toBe(contents);
  });
});
