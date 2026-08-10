import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubTrustSource, LocalTrustSource } from "../../src/trust/fetch.js";
import type { TrustLock } from "../../src/trust/lock.js";
import {
  PROMOTION_SNAPSHOT_LIMITS,
  snapshotSkillPromotion,
} from "../../src/workspace/promotion-snapshot.js";

let sourceRoot: string;

function source(): LocalTrustSource {
  return {
    kind: "local",
    id: "vendor-source",
    source: sourceRoot,
    root: sourceRoot,
    display: sourceRoot,
  };
}

function binding() {
  return { id: "vendor-source", kind: "local" as const, source: sourceRoot };
}

function skill(name: string, contents = Buffer.from(`# ${name}\n`, "utf8")): string {
  const dir = join(sourceRoot, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), contents);
  return dir;
}

function emptyLock(): TrustLock {
  return { schemaVersion: 1, sources: [] };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contextDir: ".ai-context",
    source: source(),
    sourceBinding: binding(),
    selectedSkills: new Set(["alpha"]),
    workingTrustLock: emptyLock(),
    promotedAt: "2026-08-09T12:00:00.000Z",
    analyzersRun: ["static"],
    findings: [{ name: "scan", verdict: "pass" as const }],
    ...overrides,
  };
}

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-promotion-snapshot-"));
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("repo-local skill promotion snapshots", () => {
  it("preserves exact Buffer bytes, canonicalizes artifacts, and threads a working lock", () => {
    const alphaBytes = Buffer.from("# alpha \u2603\n", "utf8");
    skill("zeta");
    skill("alpha", alphaBytes);
    const working: TrustLock = {
      schemaVersion: 1,
      sources: [
        {
          id: "vendor-source",
          kind: "local",
          source: sourceRoot,
          promotedAt: "2026-08-08T00:00:00.000Z",
          promotedSkills: ["zeta"],
          analyzersRun: ["old"],
          artifactHashes: [{ path: "skills/zeta/SKILL.md", sha256: "a".repeat(64) }],
          findings: [],
        },
      ],
    };

    const snapshot = snapshotSkillPromotion(request({ workingTrustLock: working }));
    writeFileSync(join(sourceRoot, "skills", "alpha", "SKILL.md"), "changed\n");

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({
      sourceRel: "skills/alpha/SKILL.md",
      targetRel: ".ai-context/skills/vendor-source/alpha/SKILL.md",
    });
    expect(snapshot.files[0]?.contents).toEqual(alphaBytes);
    expect(snapshot.files[0]?.contents).not.toBe(alphaBytes);
    expect(snapshot.promotedSkills).toEqual(["alpha"]);
    expect(snapshot.artifactHashes).toEqual([
      {
        path: "skills/alpha/SKILL.md",
        sha256: "0416501cfdcbce7d36fc4e4403eeee17329fd1923d7791cb9ce441e9a3dfcdb1",
      },
    ]);
    expect(snapshot.nextTrustLock.sources[0]?.promotedSkills).toEqual(["alpha", "zeta"]);
    expect(snapshot.nextTrustLock.sources[0]?.artifactHashes.map(({ path }) => path)).toEqual([
      "skills/alpha/SKILL.md",
      "skills/zeta/SKILL.md",
    ]);
    expect(snapshot.nextTrustLockBytes).toEqual(
      Buffer.from(`${JSON.stringify(snapshot.nextTrustLock, null, 2)}\n`, "utf8"),
    );
    expect(existsSync(join(sourceRoot, ".ai-context"))).toBe(false);
    expect(existsSync(join(sourceRoot, ".aih", "trust-lock.json"))).toBe(false);
  });

  it("uses full-source replacement but subset union for deterministic batch snapshots", () => {
    skill("alpha");
    skill("zeta");
    const first = snapshotSkillPromotion(request());
    const second = snapshotSkillPromotion(
      request({
        selectedSkills: new Set(["zeta"]),
        workingTrustLock: first.nextTrustLock,
        promotedAt: "2026-08-09T12:01:00.000Z",
      }),
    );
    expect(second.nextTrustLock.sources).toHaveLength(1);
    expect(second.nextTrustLock.sources[0]?.promotedSkills).toEqual(["alpha", "zeta"]);

    const secondSource = snapshotSkillPromotion(
      request({
        source: { ...source(), id: "vendor-source-two" },
        sourceBinding: { ...binding(), id: "vendor-source-two" },
        selectedSkills: new Set(["zeta"]),
        workingTrustLock: second.nextTrustLock,
      }),
    );
    expect(secondSource.nextTrustLock.sources.map(({ id }) => id)).toEqual([
      "vendor-source",
      "vendor-source-two",
    ]);

    const replacement = snapshotSkillPromotion(
      request({ selectedSkills: undefined, workingTrustLock: second.nextTrustLock }),
    );
    expect(replacement.promotedSkills).toEqual(["alpha", "zeta"]);
    expect(replacement.nextTrustLock.sources[0]?.promotedSkills).toEqual(["alpha", "zeta"]);
  });

  it("binds source identity and emits byte-identical locks for input permutations", () => {
    skill("alpha");
    skill("zeta");
    expect(() =>
      snapshotSkillPromotion(
        request({ sourceBinding: { ...binding(), source: `${sourceRoot}-other` } }),
      ),
    ).toThrow(/binding|identity/i);

    const left = snapshotSkillPromotion(
      request({
        selectedSkills: new Set(["alpha", "zeta"]),
      }),
    );
    const right = snapshotSkillPromotion(
      request({
        selectedSkills: new Set(["zeta", "alpha"]),
      }),
    );
    expect(left.nextTrustLockBytes).toEqual(right.nextTrustLockBytes);
  });

  it("never executes inherited JSON hooks and still detects source-byte changes", () => {
    skill("alpha");
    let calls = 0;
    const objectPrototype = Object.prototype as { toJSON?: () => unknown };
    const arrayPrototype = Array.prototype as unknown as { toJSON?: () => unknown };
    const objectHook = objectPrototype.toJSON;
    const arrayHook = arrayPrototype.toJSON;
    objectPrototype.toJSON = () => {
      calls += 1;
      return { corrupted: true };
    };
    arrayPrototype.toJSON = () => {
      calls += 1;
      return ["corrupted"];
    };
    try {
      const before = snapshotSkillPromotion(request());
      writeFileSync(join(sourceRoot, "skills", "alpha", "SKILL.md"), "changed\n");
      const after = snapshotSkillPromotion(request());
      expect(calls).toBe(0);
      expect(JSON.parse(before.nextTrustLockBytes.toString("utf8"))).toMatchObject({
        schemaVersion: 1,
        sources: [{ id: "vendor-source" }],
      });
      expect(before.artifactHashes).not.toEqual(after.artifactHashes);
    } finally {
      if (objectHook === undefined) delete objectPrototype.toJSON;
      else objectPrototype.toJSON = objectHook;
      if (arrayHook === undefined) delete arrayPrototype.toJSON;
      else arrayPrototype.toJSON = arrayHook;
    }
  });

  it("revalidates a promotion leaf at the point of use", () => {
    skill("alpha");
    const outsideRoot = mkdtempSync(join(tmpdir(), "aih-promotion-swap-"));
    const outside = join(outsideRoot, "outside.md");
    writeFileSync(outside, "outside\n");
    let swapped = false;
    try {
      expect(() =>
        snapshotSkillPromotion(request(), {
          beforeFileRead(path) {
            if (swapped || !path.endsWith("SKILL.md")) return;
            swapped = true;
            rmSync(path);
            symlinkSync(outside, path);
          },
        }),
      ).toThrow(/source|unsafe|outside|changed/i);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses a parent-directory swap that redirects the lexical leaf outside", () => {
    skill("alpha");
    const outsideRoot = mkdtempSync(join(tmpdir(), "aih-promotion-parent-swap-"));
    const outsideAlpha = join(outsideRoot, "alpha");
    mkdirSync(outsideAlpha);
    writeFileSync(join(outsideAlpha, "SKILL.md"), "outside bytes\n");
    const alpha = join(sourceRoot, "skills", "alpha");
    const held = join(sourceRoot, "skills", "alpha-held");
    let swapped = false;
    try {
      expect(() =>
        snapshotSkillPromotion(request(), {
          beforeFileRead(path) {
            if (swapped || !path.endsWith("SKILL.md")) return;
            swapped = true;
            renameSync(alpha, held);
            symlinkSync(outsideAlpha, alpha, "dir");
          },
        }),
      ).toThrow("unable to snapshot unsafe promotion source");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("re-pins the original leaf after its parent changes following resolution", () => {
    skill("alpha");
    const outsideRoot = mkdtempSync(join(tmpdir(), "aih-promotion-resolve-swap-"));
    const outsideAlpha = join(outsideRoot, "alpha");
    mkdirSync(outsideAlpha);
    writeFileSync(join(outsideAlpha, "SKILL.md"), "outside bytes\n");
    const alpha = join(sourceRoot, "skills", "alpha");
    const held = join(sourceRoot, "skills", "alpha-held");
    let swapped = false;
    try {
      expect(() =>
        snapshotSkillPromotion(request(), {
          afterFileResolve(path) {
            if (swapped || !path.endsWith("SKILL.md")) return;
            swapped = true;
            renameSync(alpha, held);
            symlinkSync(outsideAlpha, alpha, "dir");
          },
        }),
      ).toThrow("unable to snapshot unsafe promotion source");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("binds GitHub promotion bytes to the exact fetch metadata commit", () => {
    const quarantineRoot = mkdtempSync(join(tmpdir(), "aih-promotion-github-"));
    const treePath = join(quarantineRoot, "tree");
    const metadataPath = join(quarantineRoot, "fetch-metadata.json");
    const github: GitHubTrustSource = {
      kind: "github",
      id: "owner-repo",
      source: "owner/repo",
      owner: "owner",
      repo: "repo",
      ref: "main",
      quarantineRoot,
      treePath,
      metadataPath,
      display: "owner/repo",
    };
    mkdirSync(join(treePath, "skills", "alpha"), { recursive: true });
    writeFileSync(join(treePath, "skills", "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        kind: "github",
        owner: "owner",
        repo: "repo",
        ref: "main",
        pinnedSha: "a".repeat(40),
        source: "owner/repo",
        treePath,
      }),
    );
    try {
      expect(() =>
        snapshotSkillPromotion({
          ...request(),
          source: github,
          sourceBinding: {
            id: github.id,
            kind: "github",
            source: github.source,
            ref: github.ref,
            pinnedSha: "b".repeat(40),
          },
        }),
      ).toThrow(/binding|metadata|identity/i);
    } finally {
      rmSync(quarantineRoot, { recursive: true, force: true });
    }
  });

  it("emits the same lock bytes for equivalent cross-source batch orderings", () => {
    skill("alpha");
    const timestamp = "2026-08-09T12:00:00.000Z";
    const forId = (id: string, lock: TrustLock) =>
      snapshotSkillPromotion(
        request({
          source: { ...source(), id },
          sourceBinding: { ...binding(), id },
          workingTrustLock: lock,
          promotedAt: timestamp,
        }),
      );
    const ab = forId("source-b", forId("source-a", emptyLock()).nextTrustLock);
    const ba = forId("source-a", forId("source-b", emptyLock()).nextTrustLock);
    expect(ab.nextTrustLockBytes).toEqual(ba.nextTrustLockBytes);
  });

  it("rejects hostile input by descriptors before getters, proxies, or filesystem reads", () => {
    skill("alpha");
    let getterCalls = 0;
    let proxyCalls = 0;
    let readCalls = 0;
    const expectInvalid = (input: unknown) => {
      expect(() =>
        snapshotSkillPromotion(input as never, {
          beforeFileRead() {
            readCalls += 1;
          },
        }),
      ).toThrow("invalid promotion snapshot input");
    };

    const bindingAccessor = request();
    Object.defineProperty(bindingAccessor, "sourceBinding", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return binding();
      },
    });
    expectInvalid(bindingAccessor);

    expectInvalid(
      request({
        selectedSkills: new Proxy(new Set(["alpha"]), {
          get(target, property, receiver) {
            proxyCalls += 1;
            return Reflect.get(target, property, receiver);
          },
        }),
      }),
    );

    const sourceAccessor = {
      ...emptyLock(),
      sources: [
        Object.defineProperty({}, "id", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "source";
          },
        }),
      ],
    };
    expectInvalid(request({ workingTrustLock: sourceAccessor }));

    const findingAccessor = Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "scan";
      },
    });
    expectInvalid(request({ findings: [findingAccessor] }));

    expectInvalid(Object.assign(Object.create({ inherited: true }), request()));
    const cyclic = request() as Record<string, unknown>;
    cyclic.cycle = cyclic;
    expectInvalid(cyclic);

    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(readCalls).toBe(0);
  });

  it("rejects portable colon paths and keeps hostile errors control- and path-free", () => {
    skill("alpha");
    for (const contextDir of ["C:/escape", "D:relative", "safe:stream"]) {
      expect(() => snapshotSkillPromotion(request({ contextDir }))).toThrow(
        "invalid promotion snapshot input",
      );
    }

    skill("BAD\u202ename");
    skill("bad\u202ename");
    let collision: Error | undefined;
    try {
      snapshotSkillPromotion(request({ selectedSkills: undefined }));
    } catch (error) {
      collision = error as Error;
    }
    expect(collision).toBeInstanceOf(Error);
    expect(collision?.message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);

    const absentRoot = join(sourceRoot, "does-not-exist");
    let filesystem: Error | undefined;
    try {
      snapshotSkillPromotion(
        request({
          source: { ...source(), root: absentRoot, source: absentRoot },
          sourceBinding: { ...binding(), source: absentRoot },
        }),
      );
    } catch (error) {
      filesystem = error as Error;
    }
    expect(filesystem).toBeInstanceOf(Error);
    expect(filesystem?.message).not.toContain(absentRoot);
  });

  it("refuses over-depth, over-count, oversized, and over-aggregate source trees", () => {
    const reset = () => {
      rmSync(sourceRoot, { recursive: true, force: true });
      mkdirSync(sourceRoot, { recursive: true });
    };

    skill("alpha");
    let deep = join(sourceRoot, "skills", "alpha");
    for (let index = 0; index <= PROMOTION_SNAPSHOT_LIMITS.maxDepth; index += 1) {
      deep = join(deep, `d${index}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "deep.md"), "deep\n");
    expect(() => snapshotSkillPromotion(request())).toThrow("promotion source exceeds limits");

    reset();
    skill("alpha");
    for (let index = 0; index < PROMOTION_SNAPSHOT_LIMITS.maxFiles; index += 1) {
      writeFileSync(join(sourceRoot, "skills", "alpha", `f${index}.md`), "x");
    }
    expect(() => snapshotSkillPromotion(request())).toThrow("promotion source exceeds limits");

    reset();
    skill("alpha");
    truncateSync(
      join(sourceRoot, "skills", "alpha", "SKILL.md"),
      PROMOTION_SNAPSHOT_LIMITS.maxFileBytes + 1,
    );
    expect(() => snapshotSkillPromotion(request())).toThrow("promotion source exceeds limits");

    reset();
    skill("alpha");
    const aggregateFiles =
      Math.floor(PROMOTION_SNAPSHOT_LIMITS.maxTotalBytes / PROMOTION_SNAPSHOT_LIMITS.maxFileBytes) +
      1;
    for (let index = 0; index < aggregateFiles; index += 1) {
      const path = join(sourceRoot, "skills", "alpha", index === 0 ? "SKILL.md" : `a${index}.md`);
      if (index !== 0) writeFileSync(path, "");
      truncateSync(path, PROMOTION_SNAPSHOT_LIMITS.maxFileBytes);
    }
    expect(() => snapshotSkillPromotion(request())).toThrow("promotion source exceeds limits");
  }, 30_000);

  it("refuses missing, partial nested, colliding, and unsafe source shapes", () => {
    skill("alpha");
    expect(() => snapshotSkillPromotion(request({ selectedSkills: new Set(["missing"]) }))).toThrow(
      /not found/i,
    );

    skill("parent");
    skill("parent/child");
    expect(() => snapshotSkillPromotion(request({ selectedSkills: new Set(["parent"]) }))).toThrow(
      /nested/i,
    );

    expect(() =>
      snapshotSkillPromotion(request({ selectedSkills: new Set(["alpha", "Alpha"]) })),
    ).toThrow(/duplicate|collision/i);

    const outsideRoot = mkdtempSync(join(tmpdir(), "aih-promotion-outside-"));
    const outsideFile = join(outsideRoot, "outside.md");
    writeFileSync(outsideFile, "outside\n");
    let symlinkCreated = false;
    try {
      symlinkSync(outsideFile, join(sourceRoot, "skills", "alpha", "alias.md"));
      symlinkCreated = true;
    } catch {
      // Symlink creation is unavailable on some Windows test hosts.
    }
    if (symlinkCreated) {
      expect(() => snapshotSkillPromotion(request())).toThrow(/outside|escape|symbolic|unsafe/i);
    }
    if (symlinkCreated) rmSync(join(sourceRoot, "skills", "alpha", "alias.md"));
    rmSync(outsideRoot, { recursive: true, force: true });

    let hardlinkCreated = false;
    try {
      linkSync(
        join(sourceRoot, "skills", "alpha", "SKILL.md"),
        join(sourceRoot, "skills", "alpha", "hardlink.md"),
      );
      hardlinkCreated = true;
    } catch {
      // Hardlink creation is unavailable on some test filesystems.
    }
    if (hardlinkCreated) expect(() => snapshotSkillPromotion(request())).toThrow(/hard|unsafe/i);
  });
});
