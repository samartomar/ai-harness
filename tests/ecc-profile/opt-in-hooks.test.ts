import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedHookEvent } from "../../src/ecc-profile/hook-core.js";
import {
  approveLearningCandidate,
  createFileLearningStore,
  createFileObservabilityStore,
  createLearningHandler,
  createPersonalObservabilityHandler,
  LEARNING_LIMITS,
  type LearningStateRecord,
  type LearningStateStore,
  OBSERVABILITY_LIMITS,
  type ObservabilityRecord,
  type ObservabilityStore,
  OPT_IN_ECC_HOOK_IDS,
  optInEccHookEvents,
  serializeLearningState,
} from "../../src/ecc-profile/opt-in-hooks.js";

const WORKTREE = "C:/fixtures/project";
const signal = new AbortController().signal;

function event(
  eventName: NormalizedHookEvent["event"],
  overrides: Partial<NormalizedHookEvent> = {},
): NormalizedHookEvent {
  return {
    version: 1,
    client: "codex",
    event: eventName,
    nativeEvent: eventName,
    sessionId: "session-secret",
    transcriptPath: null,
    cwd: WORKTREE,
    ...overrides,
  };
}

function memoryLearningStore(): LearningStateStore & { records: LearningStateRecord[] } {
  const records: LearningStateRecord[] = [];
  return {
    records,
    list: () => structuredClone(records),
    save(record) {
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) records.splice(index, 1);
      records.push(structuredClone(record));
    },
    prune(beforeEpochMs) {
      const retained = records.filter((record) => record.updatedAtEpochMs >= beforeEpochMs);
      records.splice(0, records.length, ...retained);
    },
  };
}

function memoryObservabilityStore(): ObservabilityStore & { records: ObservabilityRecord[] } {
  const records: ObservabilityRecord[] = [];
  return {
    records,
    list: () => structuredClone(records),
    save(record) {
      records.push(structuredClone(record));
    },
    prune(beforeEpochMs) {
      const retained = records.filter((record) => record.updatedAtEpochMs >= beforeEpochMs);
      records.splice(0, records.length, ...retained);
    },
  };
}

describe("ECC opt-in learning hook", () => {
  it("exposes an explicit, fail-open internal handler contract", () => {
    const learning = createLearningHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store: memoryLearningStore(),
    });
    const observability = createPersonalObservabilityHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store: memoryObservabilityStore(),
    });
    expect(OPT_IN_ECC_HOOK_IDS).toEqual(["learning", "personal-observability"]);
    expect(optInEccHookEvents()).toEqual({
      learning: ["after-tool", "tool-failure", "after-compact", "session-end", "stop"],
      "personal-observability": [
        "session-start",
        "session-end",
        "after-tool",
        "tool-failure",
        "after-compact",
        "stop",
      ],
    });
    for (const handler of [learning, observability]) {
      expect(handler.failurePolicy).toBe("open");
      expect(handler.redactionPolicy).toBe("sensitive-values");
      expect(handler.storagePolicy).toBe("aih-state");
    }
    expect(() =>
      createLearningHandler({
        enabled: "yes" as unknown as boolean,
        repositoryId: "repo",
        canonicalWorktree: WORKTREE,
        harness: "codex",
        store: memoryLearningStore(),
      }),
    ).toThrow("explicit");
  });

  it("stays disabled until the caller records explicit opt-in", async () => {
    const store = memoryLearningStore();
    const handler = createLearningHandler({
      enabled: false,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
    });
    expect(handler.enabled).toBe(false);
    await handler.run(event("after-compact", { compactSummary: "retain me" }), signal);
    expect(store.records).toEqual([]);
  });

  it("records only redacted observations and non-discoverable candidates", async () => {
    const store = memoryLearningStore();
    const handler = createLearningHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => 42,
    });
    await handler.run(
      event("after-compact", {
        prompt: "raw prompt must not persist",
        compactSummary:
          "Prefer focused checks. API_TOKEN=secret-value\nAuthorization: Basic dXNlcjpwYXNz",
        tool: {
          name: "shell",
          input: { command: "raw input" },
          response: { output: "raw output" },
        },
      }),
      signal,
    );

    expect(store.records.map((record) => record.kind)).toEqual(["observation", "candidate"]);
    const serialized = JSON.stringify(store.records);
    expect(serialized).toContain("Prefer focused checks");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("dXNlcjpwYXNz");
    expect(serialized).not.toContain("raw prompt");
    expect(serialized).not.toContain("raw input");
    expect(serialized).not.toContain("raw output");
    expect(serialized).not.toContain("session-secret");
    expect(store.records[1]).toMatchObject({
      kind: "candidate",
      discoverable: false,
      status: "pending-review",
    });
  });

  it("rejects foreign-worktree events without writing", async () => {
    const store = memoryLearningStore();
    const handler = createLearningHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
    });
    expect(() =>
      handler.run(
        event("after-compact", { cwd: "C:/fixtures/other", compactSummary: "x" }),
        signal,
      ),
    ).toThrow("foreign worktree");
    expect(store.records).toEqual([]);
  });

  it("observes tool outcomes without manufacturing promotion candidates", async () => {
    const store = memoryLearningStore();
    let clock = 10;
    const handler = createLearningHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => clock++,
    });
    await handler.run(event("after-tool", { tool: { name: "tests", input: {} } }), signal);
    await handler.run(
      event("tool-failure", {
        tool: { name: "build", input: {}, error: "Authorization: Bearer hidden" },
      }),
      signal,
    );
    await handler.run(event("session-end", { lastAssistantMessage: null }), signal);
    expect(store.records.map((record) => record.kind)).toEqual(["observation", "observation"]);
    expect(JSON.stringify(store.records)).not.toContain("hidden");
  });

  it("requires recorded human intent and candidate provenance before approval", async () => {
    const store = memoryLearningStore();
    const handler = createLearningHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => 42,
    });
    await handler.run(
      event("after-compact", { compactSummary: "Use focused verification." }),
      signal,
    );
    const candidate = store.records.find((record) => record.kind === "candidate");
    if (candidate?.kind !== "candidate") throw new Error("candidate missing");

    expect(() =>
      approveLearningCandidate({
        store,
        candidateId: candidate.id,
        humanIntent: { approvedBy: "", reason: "ship", approvedAtEpochMs: 43 },
        provenance: {
          sourceObservationId: candidate.sourceObservationId,
          candidateSha256: candidate.sha256,
        },
      }),
    ).toThrow("approvedBy");
    expect(() =>
      approveLearningCandidate({
        store,
        candidateId: candidate.id,
        humanIntent: { approvedBy: "maintainer", reason: "reviewed", approvedAtEpochMs: 43 },
        provenance: {
          sourceObservationId: candidate.sourceObservationId,
          candidateSha256: "0".repeat(64),
        },
      }),
    ).toThrow("provenance");
    expect(() =>
      approveLearningCandidate({
        store,
        candidateId: "not-a-digest",
        humanIntent: { approvedBy: "maintainer", reason: "reviewed", approvedAtEpochMs: 43 },
        provenance: {
          sourceObservationId: candidate.sourceObservationId,
          candidateSha256: candidate.sha256,
        },
      }),
    ).toThrow("candidateId");
    expect(() =>
      approveLearningCandidate({
        store,
        candidateId: candidate.id,
        humanIntent: { approvedBy: "maintainer", reason: "reviewed", approvedAtEpochMs: 41 },
        provenance: {
          sourceObservationId: candidate.sourceObservationId,
          candidateSha256: candidate.sha256,
        },
      }),
    ).toThrow("predates");

    const approval = approveLearningCandidate({
      store,
      candidateId: candidate.id,
      humanIntent: { approvedBy: "maintainer", reason: "reviewed", approvedAtEpochMs: 43 },
      provenance: {
        sourceObservationId: candidate.sourceObservationId,
        candidateSha256: candidate.sha256,
      },
    });
    expect(approval).toMatchObject({
      kind: "approval",
      candidateId: candidate.id,
      sourceObservationId: candidate.sourceObservationId,
      candidateSha256: candidate.sha256,
      approvedBy: "maintainer",
    });
    expect(candidate.discoverable).toBe(false);
  });

  it("serializes learning state deterministically", () => {
    const store = memoryLearningStore();
    const base = {
      version: 1 as const,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      sessionId: "a".repeat(64),
      event: "after-compact" as const,
      summary: "summary",
    };
    store.records.push(
      { ...base, kind: "observation", id: "b".repeat(64), updatedAtEpochMs: 2 },
      { ...base, kind: "observation", id: "a".repeat(64), updatedAtEpochMs: 1 },
    );
    const [record] = store.records;
    if (!record) throw new Error("learning record missing");
    const first = serializeLearningState(store.records);
    expect(first).toBe(serializeLearningState([...store.records].reverse()));
    expect(first.endsWith("\n")).toBe(true);
    expect(() =>
      serializeLearningState([...store.records, { ...record, repositoryId: "" }]),
    ).toThrow("repositoryId");
    expect(() =>
      serializeLearningState(
        Array.from({ length: LEARNING_LIMITS.maxRecords + 1 }, (_, index) => ({
          ...record,
          id: index.toString(16).padStart(64, "0"),
        })),
      ),
    ).toThrow("record limit");
  });
});

describe("ECC personal observability hook", () => {
  it("stores sanitized event metrics without prompts, tool data, or raw session identity", async () => {
    const store = memoryObservabilityStore();
    const handler = createPersonalObservabilityHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => 50,
    });
    await handler.run(
      event("after-tool", {
        prompt: "private prompt",
        durationMs: 125,
        tool: {
          name: "shell API_TOKEN=secret-value",
          input: { command: "private input" },
          response: { output: "private output" },
        },
      }),
      signal,
    );
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      event: "after-tool",
      outcome: "ok",
      durationMs: 125,
      eventCount: 1,
    });
    const serialized = JSON.stringify(store.records);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private input");
    expect(serialized).not.toContain("private output");
    expect(serialized).not.toContain("session-secret");
  });

  it("stays disabled without explicit opt-in and rejects a foreign worktree", async () => {
    const store = memoryObservabilityStore();
    const disabled = createPersonalObservabilityHandler({
      enabled: false,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
    });
    expect(disabled.enabled).toBe(false);
    await disabled.run(event("session-start"), signal);
    expect(store.records).toEqual([]);

    const enabled = createPersonalObservabilityHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
    });
    expect(() => enabled.run(event("session-end", { cwd: "C:/other" }), signal)).toThrow(
      "foreign worktree",
    );
  });

  it("bounds failure metrics and records non-tool lifecycle events", async () => {
    const store = memoryObservabilityStore();
    let clock = 60;
    const handler = createPersonalObservabilityHandler({
      enabled: true,
      repositoryId: "repo",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => clock++,
    });
    await handler.run(event("session-start"), signal);
    await handler.run(
      event("tool-failure", {
        durationMs: OBSERVABILITY_LIMITS.maxDurationMs + 1,
        tool: { name: "build", input: {}, error: "private failure" },
      }),
      signal,
    );
    expect(store.records[0]).not.toHaveProperty("tool");
    expect(store.records[0]).not.toHaveProperty("outcome");
    expect(store.records[1]).toMatchObject({
      tool: "build",
      outcome: "failed",
      durationMs: OBSERVABILITY_LIMITS.maxDurationMs,
    });
    expect(JSON.stringify(store.records)).not.toContain("private failure");
    expect(() =>
      createPersonalObservabilityHandler({
        enabled: 1 as unknown as boolean,
        repositoryId: "repo",
        canonicalWorktree: WORKTREE,
        harness: "codex",
        store,
      }),
    ).toThrow("explicit");
  });
});

describe("ECC opt-in file stores", () => {
  it("keeps learning state outside Git scope and rotates deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-learning-state-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      const store = createFileLearningStore({
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "repo",
        harness: "codex",
      });
      let clock = 1_000;
      const handler = createLearningHandler({
        enabled: true,
        repositoryId: "repo",
        canonicalWorktree: worktree,
        harness: "codex",
        store,
        now: () => clock++,
      });
      for (let index = 0; index <= LEARNING_LIMITS.maxRecords / 2; index += 1) {
        await handler.run(
          event("after-compact", {
            cwd: worktree,
            sessionId: `session-${index}`,
            compactSummary: `candidate ${index}`,
          }),
          signal,
        );
      }
      const records = store.list();
      expect(records).toHaveLength(LEARNING_LIMITS.maxRecords);
      expect(
        records.some((record) => record.kind !== "approval" && record.summary === "candidate 0"),
      ).toBe(false);
      expect(
        records.some(
          (record) =>
            record.kind !== "approval" &&
            record.summary === `candidate ${LEARNING_LIMITS.maxRecords / 2}`,
        ),
      ).toBe(true);
      const stateFiles = readdirSync(join(stateRoot, "learning"));
      expect(stateFiles).toHaveLength(1);
      const [stateFileName] = stateFiles;
      if (!stateFileName) throw new Error("learning state file missing");
      expect(readFileSync(join(stateRoot, "learning", stateFileName), "utf8")).toContain(
        '"kind": "candidate"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("prunes observability state by retention and record cap", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-observability-state-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      const store = createFileObservabilityStore({
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "repo",
        harness: "codex",
      });
      for (let index = 0; index <= OBSERVABILITY_LIMITS.maxRecords; index += 1) {
        store.save({
          version: 1,
          id: index.toString(16).padStart(64, "0"),
          repositoryId: "repo",
          canonicalWorktree: worktree,
          harness: "codex",
          sessionId: "a".repeat(64),
          updatedAtEpochMs: index,
          client: "codex",
          event: "after-tool",
          tool: "shell",
          outcome: "ok",
          durationMs: index,
          eventCount: 1,
        });
      }
      expect(store.list()).toHaveLength(OBSERVABILITY_LIMITS.maxRecords);
      store.prune(OBSERVABILITY_LIMITS.maxRecords - 2);
      expect(store.list().map((record) => record.updatedAtEpochMs)).toEqual([
        OBSERVABILITY_LIMITS.maxRecords - 2,
        OBSERVABILITY_LIMITS.maxRecords - 1,
        OBSERVABILITY_LIMITS.maxRecords,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects in-worktree, linked, malformed, and cross-scope state", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-opt-in-boundary-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      expect(() =>
        createFileLearningStore({
          stateRoot: worktree,
          canonicalWorktree: worktree,
          repositoryId: "repo",
          harness: "codex",
        }),
      ).toThrow("outside");

      const store = createFileLearningStore({
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "repo",
        harness: "codex",
      });
      const handler = createLearningHandler({
        enabled: true,
        repositoryId: "repo",
        canonicalWorktree: worktree,
        harness: "codex",
        store,
        now: () => 1,
      });
      await handler.run(
        event("after-compact", { cwd: worktree, compactSummary: "valid checkpoint" }),
        signal,
      );
      const [stateFileName] = readdirSync(join(stateRoot, "learning"));
      if (!stateFileName) throw new Error("learning state file missing");
      const stateFile = join(stateRoot, "learning", stateFileName);
      writeFileSync(stateFile, "{}\n", "utf8");
      expect(() => store.list()).toThrow("malformed");
      writeFileSync(stateFile, "not-json\n", "utf8");
      expect(() => store.list()).toThrow("malformed");
      writeFileSync(stateFile, "[]\n", "utf8");
      await handler.run(
        event("after-compact", { cwd: worktree, compactSummary: "valid checkpoint" }),
        signal,
      );
      const crossScope = JSON.parse(readFileSync(stateFile, "utf8")) as Array<
        Record<string, unknown>
      >;
      const firstRecord = crossScope.find((record) => record.kind === "observation");
      if (!firstRecord) throw new Error("learning observation missing");
      firstRecord.repositoryId = "other";
      writeFileSync(stateFile, `${JSON.stringify(crossScope)}\n`, "utf8");
      expect(() => store.list()).toThrow("store scope");
      rmSync(stateFile);
      const outside = join(root, "outside.json");
      writeFileSync(outside, "[]\n", "utf8");
      let linkCreated = false;
      try {
        symlinkSync(outside, stateFile, "file");
        linkCreated = true;
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      if (linkCreated) expect(() => store.list()).toThrow("regular file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid roots and configured file limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-opt-in-limits-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      expect(() =>
        createFileLearningStore({
          stateRoot: "relative",
          canonicalWorktree: worktree,
          repositoryId: "repo",
          harness: "codex",
        }),
      ).toThrow("absolute");
      expect(() =>
        createFileObservabilityStore({
          stateRoot,
          canonicalWorktree: worktree,
          repositoryId: "repo",
          harness: "codex",
          maxFileBytes: 0,
        }),
      ).toThrow("maxFileBytes");
      const store = createFileLearningStore({
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "repo",
        harness: "codex",
        maxFileBytes: 100,
      });
      const handler = createLearningHandler({
        enabled: true,
        repositoryId: "repo",
        canonicalWorktree: worktree,
        harness: "codex",
        store,
        now: () => 1,
      });
      await expect(
        Promise.resolve().then(() =>
          handler.run(
            event("after-compact", { cwd: worktree, compactSummary: "x".repeat(200) }),
            signal,
          ),
        ),
      ).rejects.toThrow("file limit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
