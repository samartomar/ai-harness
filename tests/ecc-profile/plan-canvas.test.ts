import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyReviewedPlanCanvasServerTransform,
  createPlanCanvasAdapter,
  createPlanCanvasArtifactSnapshot,
  materializePlanCanvasRuntime,
  PLAN_CANVAS_LIMITS,
  PLAN_CANVAS_RUNTIME_PIN,
  type PlanCanvasReview,
  planCanvasReviewLabel,
  verifyPlanCanvasRuntimeRoot,
} from "../../src/ecc-profile/plan-canvas.js";
import type { RunOptions } from "../../src/internals/proc.js";

const roots: string[] = [];
const runtimeSourceFixture = resolve("tests/fixtures/ecc-profile/plan-canvas-runtime-source");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-plan-canvas-"));
  roots.push(root);
  const artifacts = join(root, "artifacts");
  const state = join(root, "state");
  const runtime = join(root, "runtime");
  mkdirSync(artifacts);
  mkdirSync(state);
  mkdirSync(runtime);
  const plan = join(artifacts, "feature.plan.md");
  writeFileSync(plan, "# Feature plan\n\nReview this revision.\n", "utf8");
  return { root, artifacts, state, runtime, plan };
}

function createFileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  }
}

function authenticatedRuntime(stateRoot: string) {
  return materializePlanCanvasRuntime({
    sourceRoot: runtimeSourceFixture,
    verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
    destinationRoot: join(stateRoot, "verified-runtime"),
  });
}

describe("Plan Canvas runtime pin", () => {
  it("applies the reviewed server hardening transform exactly once", () => {
    const source = [
      "const { EventEmitter } = require('events');",
      "const MAX_BODY_BYTES = 1024 * 1024;",
      `  if (!store) throw new Error('createPlanCanvasServer requires a session store');

  const allowedHostnames = buildAllowedHostnames(host);`,
      "return sendJson(res, 200, { ok: true, app: 'ecc-plan-canvas', version });",
      `  function watchSession(session) {
    if (watchers.has(session.key)) return;
    const dir = path.dirname(session.file);`,
      `      if (!fs.existsSync(path.resolve(body.file))) {
        return sendJson(res, 404, { error: \`artifact not found: \${body.file}\` });
      }
      const { session, refused } = store.open(body.file, { reopen: Boolean(body.reopen) });`,
      `      let content;
      try {
        content = fs.readFileSync(session.file, 'utf8');
      } catch {
        return sendHtml(res, 404, \`<h1>Artifact missing</h1><p>\${session.file} no longer exists.</p>\`, { csp: false });
      }`,
      `    let data;
    try {
      data = fs.readFileSync(resolved);
    } catch {
      return sendJson(res, 404, { error: 'asset not found' });
    }`,
    ].join("\n\n");

    const hardened = applyReviewedPlanCanvasServerTransform(source);
    expect(hardened).toContain("const ARTIFACT_ROOT = resolveArtifactRoot();");
    expect(hardened).toContain("readContainedFile(body.file)");
    expect(hardened).toContain("readContainedFile(session.file).data.toString('utf8')");
    expect(hardened).toContain("readContainedFile(resolved, { baseDir }).data");
    expect(hardened).not.toContain("fs.existsSync(path.resolve(body.file))");
    expect(() => applyReviewedPlanCanvasServerTransform("unreviewed source")).toThrow(
      /does not match/i,
    );
    expect(() => applyReviewedPlanCanvasServerTransform(`${source}\n${source}`)).toThrow(
      /does not match/i,
    );
  });

  it("binds the independently published artifact and complete runtime closure", () => {
    expect(PLAN_CANVAS_RUNTIME_PIN).toMatchObject({
      package: "ecc-universal",
      exactVersion: "2.1.0",
      integrity:
        "sha512-+WiK+Ray5/xUtPbzrNkiNCG90ZeKXXSOXGMUPkcPAt1U473jSkSiurH69Kqy4AWZDvKRWZ6ZeA6Vx3cNsMOiCg==",
      sourceRepository: "https://github.com/affaan-m/ECC",
      releaseAncestorCommit: "4da6deac1888690e7fb8572d097ee23db630f7a0",
      license: "MIT",
      entrypoint: "scripts/plan-canvas.js",
      sourceClosureSha256: "ffafd7303cff4728bbe39b0921d03b3e2d5e63c1f8afe4116b9f8297bb96a947",
      closureSha256: "5f096b2e8678c1daad44268001cab5e73b0eb1bf13a4bf7b283cffb2d90339ac",
      hardeningOverlay: {
        sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
        path: "scripts/lib/loopback-guard.js",
        rawSha256: "3efcc93c9c631876f824e61f97945a8260fba9ad7ea14baffee3de0781b74bcb",
        reason: "Reject malformed and out-of-range Host-header ports before URL parsing.",
      },
      serverHardening: {
        sourcePath: "scripts/lib/plan-canvas/server.js",
        sourceSha256: "cf60c4a2f295355bf1173a9cd2beb043a76a4e09322471572316d8b1eb95db5b",
        outputSha256: "31dc01d3f5911afe92a5b46b7386bc644d05944429527593d95cc2ab88f16d9d",
      },
    });
    expect(PLAN_CANVAS_RUNTIME_PIN.files).toHaveLength(8);
    expect(PLAN_CANVAS_RUNTIME_PIN.files.map((file) => file.path)).toEqual([
      "package.json",
      "scripts/plan-canvas.js",
      "scripts/lib/loopback-guard.js",
      "scripts/lib/plan-canvas/markdown.js",
      "scripts/lib/plan-canvas/sdk.js",
      "scripts/lib/plan-canvas/server.js",
      "scripts/lib/plan-canvas/sessions.js",
      "scripts/lib/plan-canvas/ui.js",
    ]);
    expect(PLAN_CANVAS_RUNTIME_PIN.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(112_130);
  });

  it("fails closed before reading an unverified, incomplete, modified, or linked runtime", () => {
    const { runtime } = fixture();
    expect(() => verifyPlanCanvasRuntimeRoot(runtime, "sha512-caller-fabricated")).toThrow(
      /integrity/i,
    );
    expect(() => verifyPlanCanvasRuntimeRoot(runtime, PLAN_CANVAS_RUNTIME_PIN.integrity)).toThrow(
      /package\.json/i,
    );

    for (const file of PLAN_CANVAS_RUNTIME_PIN.files) {
      const destination = join(runtime, ...file.path.split("/"));
      mkdirSync(resolve(destination, ".."), { recursive: true });
      writeFileSync(destination, Buffer.alloc(file.bytes));
    }
    expect(() => verifyPlanCanvasRuntimeRoot(runtime, PLAN_CANVAS_RUNTIME_PIN.integrity)).toThrow(
      /hash mismatch/i,
    );

    const entrypoint = join(runtime, "scripts", "plan-canvas.js");
    rmSync(entrypoint);
    const outside = join(runtime, "..", "outside.js");
    writeFileSync(outside, "outside", "utf8");
    if (createFileSymlink(outside, entrypoint)) {
      expect(() => verifyPlanCanvasRuntimeRoot(runtime, PLAN_CANVAS_RUNTIME_PIN.integrity)).toThrow(
        /regular file|linked/i,
      );
    }
  });

  it("materializes the authenticated source fixture deterministically and rejects boundary conflicts", () => {
    const { root } = fixture();
    const destinationRoot = join(root, "materialized");
    const first = materializePlanCanvasRuntime({
      sourceRoot: runtimeSourceFixture,
      verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
      destinationRoot,
    });
    const second = materializePlanCanvasRuntime({
      sourceRoot: runtimeSourceFixture,
      verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
      destinationRoot,
    });

    expect(second).toEqual(first);
    expect(first).toEqual(
      verifyPlanCanvasRuntimeRoot(destinationRoot, PLAN_CANVAS_RUNTIME_PIN.integrity),
    );
    expect(
      readFileSync(join(first.root, "scripts", "lib", "plan-canvas", "server.js"), "utf8"),
    ).toContain("AIH_PLAN_CANVAS_ARTIFACT_ROOT");
    const cli = readFileSync(join(first.root, "scripts", "plan-canvas.js"), "utf8");
    const markdown = readFileSync(
      join(first.root, "scripts", "lib", "plan-canvas", "markdown.js"),
      "utf8",
    );
    const sessions = readFileSync(
      join(first.root, "scripts", "lib", "plan-canvas", "sessions.js"),
      "utf8",
    );
    const ui = readFileSync(join(first.root, "scripts", "lib", "plan-canvas", "ui.js"), "utf8");
    expect(cli).toContain("AIH_PLAN_CANVAS_DAEMON_TOKEN");
    expect(cli).toContain("aihTokenProof");
    expect(markdown).toContain("if (kind !== 'relative') return alt;");
    expect(ui).toContain("msg.item.kind === 'annotation'");
    expect(sessions).toContain("error.code === 'ENOENT'");
    expect(sessions).toContain("Plan Canvas session state is corrupt or unreadable");
    expect(() =>
      materializePlanCanvasRuntime({
        sourceRoot: runtimeSourceFixture,
        verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
        destinationRoot: "relative-runtime",
      }),
    ).toThrow(/absolute/i);

    const fileDestination = join(root, "runtime-file");
    writeFileSync(fileDestination, "not a directory", "utf8");
    expect(() =>
      materializePlanCanvasRuntime({
        sourceRoot: runtimeSourceFixture,
        verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
        destinationRoot: fileDestination,
      }),
    ).toThrow(/not a directory/i);

    expect(() =>
      createPlanCanvasAdapter({
        runtime: { ...first },
        stateRoot: join(root, "state"),
      }),
    ).toThrow(/authenticated runtime acquisition/i);
  });

  it("blocks remote Markdown image egress and preserves corrupt session state", () => {
    const { root } = fixture();
    const runtime = authenticatedRuntime(root);
    const requireRuntime = createRequire(import.meta.url);
    const markdown = requireRuntime(
      join(runtime.root, "scripts", "lib", "plan-canvas", "markdown.js"),
    ) as { renderMarkdown(value: string): string };
    const rendered = markdown.renderMarkdown(
      "![remote](https://attacker.example/pixel.png) ![local](asset.png)",
    );
    expect(rendered).not.toContain("attacker.example");
    expect(rendered).toContain('<img src="asset.png"');

    const stateDir = join(root, "corrupt-state");
    mkdirSync(stateDir);
    const stateFile = join(stateDir, "sessions.json");
    writeFileSync(stateFile, "{not-json", "utf8");
    const sessions = requireRuntime(
      join(runtime.root, "scripts", "lib", "plan-canvas", "sessions.js"),
    ) as { createSessionStore(options: { stateDir: string }): unknown };
    expect(() => sessions.createSessionStore({ stateDir })).toThrow(/corrupt or unreadable/i);
    expect(readFileSync(stateFile, "utf8")).toBe("{not-json");
  });
});

describe("Plan Canvas artifact boundary", () => {
  it.skipIf(process.platform === "win32")(
    "rebases trusted children through a canonical POSIX root alias",
    () => {
      const { root } = fixture();
      const target = join(root, "target");
      const alias = join(root, "alias");
      const artifacts = join(target, "artifacts");
      const state = join(target, "state");
      mkdirSync(artifacts, { recursive: true });
      mkdirSync(state);
      writeFileSync(join(artifacts, "feature.plan.md"), "# Aliased plan\n", "utf8");
      symlinkSync(target, alias, "dir");

      const review = createPlanCanvasArtifactSnapshot({
        artifactRoot: join(alias, "artifacts"),
        artifactPath: join(alias, "artifacts", "feature.plan.md"),
        stateRoot: join(alias, "state"),
      });
      const runtime = materializePlanCanvasRuntime({
        sourceRoot: runtimeSourceFixture,
        verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
        destinationRoot: join(alias, "state", "runtime"),
      });

      expect(review.originalPath).toBe(realpathSync(join(artifacts, "feature.plan.md")));
      expect(runtime.root).toBe(realpathSync(join(state, "runtime")));
    },
  );

  it("creates a deterministic immutable revision snapshot under managed state", () => {
    const { artifacts, state, plan } = fixture();
    const first = createPlanCanvasArtifactSnapshot({
      artifactRoot: artifacts,
      artifactPath: plan,
      stateRoot: state,
    });
    const second = createPlanCanvasArtifactSnapshot({
      artifactRoot: artifacts,
      artifactPath: "feature.plan.md",
      stateRoot: state,
    });

    expect(second).toEqual(first);
    expect(first.originalPath).toBe(realpathSync(plan));
    const snapshotRelative = relative(resolve(state), first.snapshotPath);
    expect(snapshotRelative.startsWith("..")).toBe(false);
    expect(isAbsolute(snapshotRelative)).toBe(false);
    expect(readFileSync(first.snapshotPath, "utf8")).toBe(readFileSync(plan, "utf8"));
    expect(first.revisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.id).toMatch(/^[a-f0-9]{24}$/);
  });

  it("rejects traversal, symlinks, unsupported types, and oversized artifacts", () => {
    const { root, artifacts, state, plan } = fixture();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside", "utf8");
    expect(() =>
      createPlanCanvasArtifactSnapshot({
        artifactRoot: artifacts,
        artifactPath: "../outside.md",
        stateRoot: state,
      }),
    ).toThrow(/outside|escape|contain/i);

    const linked = join(artifacts, "linked.md");
    if (createFileSymlink(outside, linked)) {
      expect(() =>
        createPlanCanvasArtifactSnapshot({
          artifactRoot: artifacts,
          artifactPath: linked,
          stateRoot: state,
        }),
      ).toThrow(/regular file|linked/i);
    }

    const script = join(artifacts, "plan.js");
    writeFileSync(script, "alert(1)", "utf8");
    expect(() =>
      createPlanCanvasArtifactSnapshot({
        artifactRoot: artifacts,
        artifactPath: script,
        stateRoot: state,
      }),
    ).toThrow(/extension/i);

    writeFileSync(plan, Buffer.alloc(PLAN_CANVAS_LIMITS.maxArtifactBytes + 1));
    expect(() =>
      createPlanCanvasArtifactSnapshot({
        artifactRoot: artifacts,
        artifactPath: plan,
        stateRoot: state,
      }),
    ).toThrow(/size|large/i);
  });
});

describe("Plan Canvas on-demand adapter", () => {
  function review(): PlanCanvasReview {
    const { artifacts, state, plan } = fixture();
    return createPlanCanvasArtifactSnapshot({
      artifactRoot: artifacts,
      artifactPath: plan,
      stateRoot: state,
    });
  }

  it("uses only the pinned entrypoint, fixed loopback defaults, bounded I/O, and scrubbed env", async () => {
    const item = review();
    const stateRoot = resolve(item.snapshotPath, "..", "..", "..");
    const runtime = authenticatedRuntime(stateRoot);
    const calls: Array<{ command: string[]; options?: RunOptions }> = [];
    const run = vi.fn(async (command: string[], options?: RunOptions) => {
      calls.push({ command, options });
      return {
        code: 0,
        stdout: JSON.stringify({ status: "open", url: "/canvas/abc" }),
        stderr: "",
        truncated: false,
      };
    });
    const adapter = createPlanCanvasAdapter({
      runtime,
      stateRoot,
      run,
      nodeCommand: process.execPath,
    });

    await adapter.open(item, { launchBrowser: false });
    const call = calls[0];
    expect(call?.command).toEqual([
      process.execPath,
      runtime.entrypoint,
      "open",
      item.snapshotPath,
      "--no-open",
    ]);
    expect(call?.command).not.toContain("--host");
    expect(call?.options?.timeoutMs).toBeLessThanOrEqual(PLAN_CANVAS_LIMITS.maxCommandTimeoutMs);
    expect(call?.options?.maxBufferBytes).toBe(PLAN_CANVAS_LIMITS.maxOutputBytes);
    expect(call?.options?.cwd).toBe(resolve(item.snapshotPath, ".."));
    expect(call?.options?.env).toMatchObject({
      AIH_PLAN_CANVAS_ARTIFACT_ROOT: expect.stringContaining("reviews"),
      ECC_PLAN_CANVAS_IDLE_MS: String(PLAN_CANVAS_LIMITS.idleTimeoutMs),
      ECC_PLAN_CANVAS_STATE_DIR: expect.stringContaining("runtime-state"),
    });
    expect(call?.options?.env?.ECC_PLAN_CANVAS_MERMAID_URL).toMatch(/^data:/);
    expect(call?.options?.env?.AIH_PLAN_CANVAS_DAEMON_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(call?.options?.env ?? {})).not.toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
    );

    const secondCalls: Array<{ command: string[]; options?: RunOptions }> = [];
    const secondAdapter = createPlanCanvasAdapter({
      runtime,
      stateRoot,
      run: async (command, options) => {
        secondCalls.push({ command, options });
        return {
          code: 0,
          stdout: JSON.stringify({ status: "open", url: "/canvas/abc" }),
          stderr: "",
          truncated: false,
        };
      },
    });
    await secondAdapter.open(item, { launchBrowser: false });
    expect(secondCalls[0]?.options?.env?.AIH_PLAN_CANVAS_DAEMON_TOKEN).toBe(
      call?.options?.env?.AIH_PLAN_CANVAS_DAEMON_TOKEN,
    );
  });

  it("binds feedback and verdicts to immutable snapshot bytes", async () => {
    const item = review();
    const responses = [
      { status: "feedback", items: [{ kind: "verdict", verdict: "approve" }] },
      { status: "feedback", items: [{ kind: "verdict", verdict: "request-changes" }] },
    ];
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(responses.shift()),
      stderr: "",
      truncated: false,
    }));
    const stateRoot = resolve(item.snapshotPath, "..", "..", "..");
    const runtime = authenticatedRuntime(stateRoot);
    const adapter = createPlanCanvasAdapter({
      runtime,
      stateRoot,
      run,
      nodeCommand: process.execPath,
    });

    await expect(adapter.awaitFeedback(item)).resolves.toMatchObject({
      status: "feedback",
      revisionSha256: item.revisionSha256,
      items: [{ kind: "verdict", verdict: "approve" }],
    });
    writeFileSync(item.snapshotPath, "tampered after review", "utf8");
    await expect(adapter.awaitFeedback(item)).rejects.toThrow(/revision|changed/i);
  });

  it("fails closed on malformed, oversized, truncated, or failed runtime responses", async () => {
    const item = review();
    const stateRoot = resolve(item.snapshotPath, "..", "..", "..");
    const runtime = authenticatedRuntime(stateRoot);
    const cases = [
      { code: 0, stdout: "not-json", stderr: "", truncated: false },
      { code: 0, stdout: JSON.stringify({ status: "forged" }), stderr: "", truncated: false },
      { code: 0, stdout: "{}", stderr: "", truncated: true },
      { code: 1, stdout: "", stderr: "failed", truncated: false },
    ];
    for (const result of cases) {
      const adapter = createPlanCanvasAdapter({
        runtime,
        stateRoot,
        run: async () => result,
        nodeCommand: process.execPath,
      });
      await expect(adapter.awaitFeedback(item)).rejects.toThrow();
    }
  });

  it("rejects contradictory adapter inputs and invalid lifecycle results", async () => {
    const item = review();
    const stateRoot = resolve(item.snapshotPath, "..", "..", "..");
    const runtime = authenticatedRuntime(stateRoot);

    expect(() =>
      createPlanCanvasAdapter({
        runtime: { ...runtime, integrity: "caller-fabricated" as never },
        stateRoot,
      }),
    ).toThrow(/authenticated runtime acquisition/i);
    expect(() =>
      createPlanCanvasAdapter({
        runtime: { ...runtime, entrypoint: join(runtime.root, "other.js") },
        stateRoot,
      }),
    ).toThrow(/authenticated runtime acquisition/i);
    expect(() => createPlanCanvasAdapter({ runtime, stateRoot, nodeCommand: "node" })).toThrow(
      /absolute/i,
    );
    for (const port of [0, 80, 65_536, 1.5]) {
      expect(() => createPlanCanvasAdapter({ runtime, stateRoot, port })).toThrow(/port/i);
    }

    const responses = [
      { status: "waiting" },
      {
        status: "feedback",
        items: [{ kind: "chat", text: "revise section two" }],
        sessionEnded: false,
        endedBy: "reviewer",
        note: "bounded note",
      },
      { status: "open" },
      { status: "feedback", items: [{ kind: "verdict" }] },
      { status: "waiting" },
      { status: "open" },
    ];
    const calls: string[][] = [];
    const adapter = createPlanCanvasAdapter({
      runtime,
      stateRoot,
      run: async (command) => {
        calls.push(command);
        return {
          code: 0,
          stdout: JSON.stringify(responses.shift()),
          stderr: "",
          truncated: false,
        };
      },
    });
    await expect(adapter.open(item)).rejects.toThrow(/did not open/i);
    await expect(adapter.awaitFeedback(item, "addressed")).resolves.toMatchObject({
      status: "feedback",
      items: [{ kind: "chat", text: "revise section two" }],
      sessionEnded: false,
      endedBy: "reviewer",
      note: "bounded note",
    });
    expect(calls[1]).toEqual(expect.arrayContaining(["--reply", "addressed"]));
    await expect(adapter.awaitFeedback(item)).rejects.toThrow(/await status/i);
    await expect(adapter.awaitFeedback(item)).rejects.toThrow(/invalid result/i);
    await expect(adapter.end(item)).rejects.toThrow(/did not end/i);
    await expect(adapter.stop()).rejects.toThrow(/did not stop/i);
    await expect(
      adapter.awaitFeedback(item, "x".repeat(PLAN_CANVAS_LIMITS.maxReplyBytes + 1)),
    ).rejects.toThrow(/size limit/i);
    await expect(
      adapter.awaitFeedback(item, "x".repeat(PLAN_CANVAS_LIMITS.maxReplyCharacters + 1)),
    ).rejects.toThrow(/size limit/i);

    await expect(adapter.awaitFeedback({ ...item, id: "not-an-id" })).rejects.toThrow(/identity/i);
    await expect(
      adapter.awaitFeedback({ ...item, reviewRoot: join(stateRoot, "elsewhere") }),
    ).rejects.toThrow(/managed root/i);
    await expect(
      adapter.awaitFeedback({ ...item, snapshotPath: join(stateRoot, "outside.md") }),
    ).rejects.toThrow(/escape/i);
    expect(planCanvasReviewLabel(item)).toBe(`feature.plan.md@${item.revisionSha256.slice(0, 12)}`);
  });

  it("ends a review before removing only its managed snapshot", async () => {
    const item = review();
    const original = item.originalPath;
    const stateRoot = resolve(item.snapshotPath, "..", "..", "..");
    const runtime = authenticatedRuntime(stateRoot);
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ status: "ended" }),
      stderr: "",
      truncated: false,
    }));
    const adapter = createPlanCanvasAdapter({
      runtime,
      stateRoot,
      run,
      nodeCommand: process.execPath,
    });

    await adapter.end(item);
    expect(() => readFileSync(item.snapshotPath)).toThrow();
    expect(readFileSync(original, "utf8")).toContain("Feature plan");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
