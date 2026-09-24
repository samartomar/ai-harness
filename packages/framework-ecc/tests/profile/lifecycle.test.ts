import "../core-invocation.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { upsertTextBlock } from "@aihq/core/framework-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../../../src/internals/execute.js";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  type EccProfileInstalledSourceTrust,
  EccProfileRecoveryRefusalError,
  eccProfileRecoveryIdentity,
  planEccProfileLifecycle,
  planInstalledEccProfileLifecycle,
  readEccProfileOwnership,
} from "../../src/profile/lifecycle.js";
import type { EccProjection, RenderedProjectionFile } from "../../src/profile/render.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
let root: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ctx(apply: boolean): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: ".ai-context",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function projectedFile(
  commit: string,
  destination: string,
  content: string,
  mergeStrategy: "replace" | "toml-merge" = "replace",
): RenderedProjectionFile {
  return {
    provenance: {
      kind: "pinned-file",
      sourcePin: commit,
      path: `skills/example/${destination.replaceAll("/", "-")}`,
      rawSha256: "c".repeat(64),
      fileType: "regular",
      mode: "100644",
    },
    normalizedSha256: sha256(content),
    destination,
    owner: "aih",
    capabilityOwner: "upstream",
    mergeStrategy,
    previousHash: null,
    mode: "100644",
    content,
  };
}

function projection(
  commit = COMMIT_A,
  skill = "# example v1\n",
  config = '[agents.example]\nconfig_file = "agents/example.toml"\n',
): EccProjection {
  return {
    version: 1,
    source: {
      repository: "affaan-m/ECC",
      commit,
      package: "ecc-universal",
      packageVersion: "2.1.0",
      releaseAncestorCommit: "d".repeat(40),
      componentPath: "manifests/install-components.json",
      sourceHash: "e".repeat(64),
      normalizedHash: "e".repeat(64),
      manifestPins: {
        "manifests/install-components.json": {
          rawSha256: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
          canonicalSha256: "2a16746d95a3ee19dc448ccdfdc0e54ef983085245f2d804f615df277ea14665",
        },
        "manifests/install-modules.json": {
          rawSha256: "9293e36a93d62d9016cf8eb13e852a882ac5b68503a5842de230c7d21431bbb7",
          canonicalSha256: "917a4f6961252078a9e8f43eccbe241ef1793f4d8d9d1f170873b824da6bb238",
        },
        "manifests/install-profiles.json": {
          rawSha256: "fddc15a7ea59c5069686eacd5ef90da805b867bed39ddad3ca391363329270f1",
          canonicalSha256: "ec57372aa886af63f6b847eee2c285d672dc35ff48b9ca2da939e215e566c2cb",
        },
      },
      license: "MIT",
      reviewReceipt: {
        id: "reviewed",
        evidencePath: "evidence/review.json",
        sourceCommit: commit,
        evidenceSha256: "f".repeat(64),
      },
    },
    sourceClosure: {
      id: `closure-${commit.slice(0, 8)}`,
      aggregateSha256: "1".repeat(64),
      fileCount: 2,
      totalBytes: 100,
    },
    clients: {
      claude: { client: "claude", skills: [], roles: [], workflows: [] },
      codex: { client: "codex", skills: [], roles: [], workflows: [] },
    },
    files: [
      projectedFile(commit, ".agents/skills/example/SKILL.md", skill),
      projectedFile(commit, ".codex/config.toml", config, "toml-merge"),
    ],
  };
}

function put(relative: string, content: string): void {
  const path = join(root, ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** The identity an authenticated install recorded: the anchor a later rollback must match. */
function anchoredInstall(): EccProfileInstalledSourceTrust[] {
  const source = readEccProfileOwnership(root)?.source;
  if (source === undefined) throw new Error("fixture install recorded no ownership receipt");
  return [source];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-lifecycle-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("AIH-owned ECC projection lifecycle", () => {
  it("previews without writes, then installs transactionally and deterministically", async () => {
    put(".codex/config.toml", 'model = "gpt-5"\n');
    const dry = planEccProfileLifecycle(root, projection(), "install");
    const secondDry = planEccProfileLifecycle(root, projection(), "install");

    expect(dry).toEqual(secondDry);
    expect(dry.actions.at(-1)).toMatchObject({
      kind: "write",
      path: ECC_PROFILE_OWNERSHIP_PATH,
    });
    await executePlan(dry, ctx(false));
    expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);

    await executePlan(dry, ctx(true));
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );
    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("# >>> aih managed (ecc-profile) >>>");
    expect(config).toContain("[agents.example]");

    const receipt = readEccProfileOwnership(root);
    expect(receipt?.source.commit).toBe(COMMIT_A);
    expect(receipt?.files.map((file) => file.destination)).toEqual([
      ".agents/skills/example/SKILL.md",
      ".codex/config.toml",
    ]);
    expect(receipt?.files[1]?.previousHash).toBe(sha256('model = "gpt-5"\n'));

    const repeat = planEccProfileLifecycle(root, projection(), "install");
    expect(repeat.actions.filter((action) => action.kind === "write")).toHaveLength(0);
  });

  it("updates only owned bytes and rolls back to the prior projection", async () => {
    put(".codex/config.toml", 'model = "gpt-5"\n');
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const anchors = anchoredInstall();
    const next = projection(
      COMMIT_B,
      "# example v2\n",
      '[agents.example]\nconfig_file = "agents/example-v2.toml"\n',
    );
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));

    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v2\n",
    );
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain(
      "agents/example-v2.toml",
    );
    expect(readEccProfileOwnership(root)?.rollback?.source.commit).toBe(COMMIT_A);

    await executePlan(planEccProfileLifecycle(root, next, "rollback", anchors), ctx(true));
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );
    const restored = readFileSync(join(root, ".codex/config.toml"), "utf8");
    expect(restored).toContain('model = "gpt-5"');
    expect(restored).toContain("agents/example.toml");
    expect(restored).not.toContain("agents/example-v2.toml");
    expect(readEccProfileOwnership(root)?.source.commit).toBe(COMMIT_A);
  });

  it("repairs a missing owned file but refuses to overwrite modified owned bytes", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    rmSync(join(root, ".agents/skills/example/SKILL.md"));
    await executePlan(planEccProfileLifecycle(root, projection(), "repair"), ctx(true));
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );

    put(".agents/skills/example/SKILL.md", "operator edit\n");
    expect(() => planEccProfileLifecycle(root, projection(), "repair")).toThrow(
      /modified.*example\/SKILL\.md/i,
    );
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "operator edit\n",
    );
  });

  it("uninstalls matching owned bytes while preserving unrelated operator TOML", async () => {
    put(".codex/config.toml", 'model = "gpt-5"\n');
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    await executePlan(planEccProfileLifecycle(root, projection(), "uninstall"), ctx(true));

    expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe('model = "gpt-5"\n');
    expect(existsSync(join(root, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
  });

  it("carries an AIH-created merge-file sentinel across update and keeps the file on uninstall", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const next = projection(
      COMMIT_B,
      "# example v2\n",
      '[agents.example]\nconfig_file = "agents/example-v2.toml"\n',
    );
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));

    const configEntry = readEccProfileOwnership(root)?.files.find(
      (file) => file.destination === ".codex/config.toml",
    );
    expect(configEntry?.previousHash).toBeNull();
    await executePlan(planEccProfileLifecycle(root, next, "uninstall"), ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("\n");
  });

  it("binds uninstall to the exact authenticated projection", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));

    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "uninstall")).toThrow(
      /uninstall projection contradicts the ownership receipt/i,
    );
    expect(existsSync(join(root, ECC_PROFILE_OWNERSHIP_PATH))).toBe(true);
  });

  it("fails closed on modified uninstall targets and malformed ownership", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    put(".agents/skills/example/SKILL.md", "operator edit\n");
    expect(() => planEccProfileLifecycle(root, projection(), "uninstall")).toThrow(
      /modified.*example\/SKILL\.md/i,
    );

    put(ECC_PROFILE_OWNERSHIP_PATH, "{not-json\n");
    expect(() => readEccProfileOwnership(root)).toThrow(/ownership receipt/i);
  });

  it("rejects an ownership receipt that silently omits projected content", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { files: unknown[] };
    receipt.files.pop();
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => planEccProfileLifecycle(root, projection(), "install")).toThrow(
      /(does not close over the pinned projection|projection digest mismatch)/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "repair")).toThrow(
      /(does not close over the pinned projection|projection digest mismatch)/i,
    );
  });

  it("rejects an incomplete active receipt before rollback", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { files: unknown[] };
    receipt.files.pop();
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => planEccProfileLifecycle(root, next, "rollback")).toThrow(
      /(does not close over the pinned projection|projection digest mismatch)/i,
    );
  });

  it("rejects altered rollback snapshot bytes", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      rollback: { files: Array<{ mergeStrategy: string; content: string }> };
    };
    const replacement = receipt.rollback.files.find((file) => file.mergeStrategy === "replace");
    if (replacement === undefined) throw new Error("fixture rollback has no replacement file");
    replacement.content = "# altered snapshot\n";
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => planEccProfileLifecycle(root, next, "rollback")).toThrow(
      /rollback.*(content|hash)|normalized hash/i,
    );
  });

  it("rejects rollback replacement bytes whose installed hash contradicts normalized content", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      rollback: {
        files: Array<{ mergeStrategy: string; content: string; normalizedHash: string }>;
      };
    };
    const replacement = receipt.rollback.files.find((file) => file.mergeStrategy === "replace");
    if (replacement === undefined) throw new Error("fixture rollback has no replacement file");
    replacement.content = "# forged but normalized snapshot\n";
    replacement.normalizedHash = sha256(replacement.content);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => planEccProfileLifecycle(root, next, "rollback")).toThrow(
      /rollback installed hash/i,
    );
  });

  it("rejects rollback TOML whose managed block contradicts normalized content", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      rollback: {
        files: Array<{ mergeStrategy: string; content: string; normalizedHash: string }>;
      };
    };
    const merge = receipt.rollback.files.find((file) => file.mergeStrategy === "toml-merge");
    if (merge === undefined) throw new Error("fixture rollback has no TOML merge file");
    merge.content = '[agents.forged]\nconfig_file = "agents/forged.toml"\n';
    merge.normalizedHash = sha256(merge.content);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => planEccProfileLifecycle(root, next, "rollback")).toThrow(
      /rollback managed-block hash/i,
    );
  });

  it("rejects an update whose rollback receipt would exceed its read boundary", async () => {
    const bytes = `${"x".repeat(4 * 1024 * 1024 - 1025)}\n`;
    const initial = projection();
    initial.files = Array.from({ length: 16 }, (_, index) =>
      projectedFile(COMMIT_A, `.agents/skills/large-${index}/SKILL.md`, bytes),
    );
    await executePlan(planEccProfileLifecycle(root, initial, "install"), ctx(true));
    const next = projection(COMMIT_B);
    next.files = Array.from({ length: 16 }, (_, index) =>
      projectedFile(
        COMMIT_B,
        `.agents/skills/large-${index}/SKILL.md`,
        `${"y".repeat(4 * 1024 * 1024 - 1025)}\n`,
      ),
    );

    expect(() => planEccProfileLifecycle(root, next, "update")).toThrow(
      /ownership receipt.*(size|limit|large)/i,
    );
  }, 60_000);

  it("rejects ownership copied from a foreign worktree root", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      canonicalRoot: string;
    };
    receipt.canonicalRoot = join(root, "foreign-worktree");
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    expect(() => readEccProfileOwnership(root)).toThrow(/foreign worktree/i);
  });

  it("strips AIH-created merge files across update and restores them on rollback", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const anchors = anchoredInstall();
    const withoutConfig = projection(COMMIT_B, "# example v2\n");
    withoutConfig.files = withoutConfig.files.filter(
      (file) => file.destination !== ".codex/config.toml",
    );
    await executePlan(planEccProfileLifecycle(root, withoutConfig, "update"), ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("\n");

    await executePlan(planEccProfileLifecycle(root, withoutConfig, "rollback", anchors), ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain(
      "# >>> aih managed (ecc-profile) >>>",
    );

    await executePlan(planEccProfileLifecycle(root, withoutConfig, "update"), ctx(true));
    await executePlan(planEccProfileLifecycle(root, withoutConfig, "rollback", anchors), ctx(true));
    expect(readEccProfileOwnership(root)?.source.commit).toBe(COMMIT_A);
  });

  it("rejects case-only destination changes across exact-pin updates", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const changed = projection(COMMIT_B);
    const first = changed.files.at(0);
    if (first === undefined) throw new Error("fixture projection has no files");
    changed.files[0] = {
      ...first,
      destination: first.destination.replace("SKILL.md", "skill.md"),
    };

    expect(() => planEccProfileLifecycle(root, changed, "update")).toThrow(/case-only/i);
  });

  it("pins writes and rolls the whole transaction back on apply-time drift", async () => {
    const expanded = projection();
    expanded.files.splice(
      1,
      0,
      projectedFile(COMMIT_A, ".claude/skills/another/SKILL.md", "# another\n"),
    );
    const planned = planEccProfileLifecycle(root, expanded, "install");
    put(".claude/skills/another/SKILL.md", "raced operator file\n");

    await expect(executePlan(planned, ctx(true))).rejects.toThrow(/changed.*plan/i);
    expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, ".claude/skills/another/SKILL.md"), "utf8")).toBe(
      "raced operator file\n",
    );
    expect(existsSync(join(root, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
  });

  it("pins the authorizing ownership receipt during repair", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    rmSync(join(root, ".agents/skills/example/SKILL.md"));
    const planned = planEccProfileLifecycle(root, projection(), "repair");
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    writeFileSync(receiptPath, `${readFileSync(receiptPath, "utf8")} `, "utf8");

    await expect(executePlan(planned, ctx(true))).rejects.toThrow(/ownership-v1\.json.*changed/i);
    expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);
  });

  it("pins removals and rolls the whole transaction back on apply-time drift", async () => {
    put(".codex/config.toml", 'model = "gpt-5"\n');
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const planned = planEccProfileLifecycle(root, projection(), "uninstall");
    put(".agents/skills/example/SKILL.md", "raced operator edit\n");

    await expect(executePlan(planned, ctx(true))).rejects.toThrow(/changed before commit/i);
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "raced operator edit\n",
    );
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain(
      "# >>> aih managed (ecc-profile) >>>",
    );
    expect(existsSync(join(root, ECC_PROFILE_OWNERSHIP_PATH))).toBe(true);
  });

  it("rejects traversal, linked destinations, and contradictory projection provenance", () => {
    const hostile = projection();
    const hostileFile = hostile.files.at(0);
    if (hostileFile === undefined) throw new Error("fixture projection has no files");
    hostile.files[0] = { ...hostileFile, destination: "../escape.md" };
    expect(() => planEccProfileLifecycle(root, hostile, "install")).toThrow(/destination|path/i);

    const contradictory = projection();
    const contradictoryFile = contradictory.files.at(0);
    if (contradictoryFile === undefined) throw new Error("fixture projection has no files");
    contradictory.files[0] = {
      ...contradictoryFile,
      provenance: { ...contradictoryFile.provenance, sourcePin: COMMIT_B },
    } as RenderedProjectionFile;
    expect(() => planEccProfileLifecycle(root, contradictory, "install")).toThrow(/source pin/i);

    const malformedIdentity = projection();
    malformedIdentity.sourceClosure.aggregateSha256 = "not-a-digest";
    expect(() => planEccProfileLifecycle(root, malformedIdentity, "install")).toThrow(
      /source closure/i,
    );

    const outside = mkdtempSync(join(tmpdir(), "aih-ecc-lifecycle-outside-"));
    try {
      mkdirSync(join(root, ".agents"), { recursive: true });
      try {
        symlinkSync(outside, join(root, ".agents", "skills"), "junction");
      } catch {
        return;
      }
      expect(() => planEccProfileLifecycle(root, projection(), "install")).toThrow(
        /symlink|outside|unsafe/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects malformed projection identities, boundaries, and destination ambiguity", () => {
    const wrongRepository = projection();
    (wrongRepository.source as { repository: string }).repository = "example.invalid/ECC";
    expect(() => planEccProfileLifecycle(root, wrongRepository, "install")).toThrow(
      /projection identity/i,
    );

    const wrongReceipt = projection();
    wrongReceipt.source.reviewReceipt.sourceCommit = COMMIT_B;
    expect(() => planEccProfileLifecycle(root, wrongReceipt, "install")).toThrow(
      /review receipt identity/i,
    );

    const empty = projection();
    empty.files = [];
    expect(() => planEccProfileLifecycle(root, empty, "install")).toThrow(/file count/i);

    const outside = projection();
    const outsideFile = outside.files.at(0);
    if (outsideFile === undefined) throw new Error("fixture projection has no files");
    outside.files[0] = { ...outsideFile, destination: "outside/file.md" };
    expect(() => planEccProfileLifecycle(root, outside, "install")).toThrow(
      /outside the managed client namespaces/i,
    );

    const duplicate = projection();
    const duplicateFile = duplicate.files.at(0);
    if (duplicateFile === undefined) throw new Error("fixture projection has no files");
    duplicate.files.push({ ...duplicateFile });
    expect(() => planEccProfileLifecycle(root, duplicate, "install")).toThrow(/ambiguous/i);

    const oversized = projection();
    const oversizedFile = oversized.files.at(0);
    if (oversizedFile === undefined) throw new Error("fixture projection has no files");
    const oversizedContent = "x".repeat(4 * 1024 * 1024 + 1);
    oversized.files[0] = {
      ...oversizedFile,
      content: oversizedContent,
      normalizedSha256: sha256(oversizedContent),
    };
    expect(() => planEccProfileLifecycle(root, oversized, "install")).toThrow(/projected bytes/i);
  });

  it("rejects ambiguous and contradictory ownership receipt metadata", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const original = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      files: Array<{
        destination: string;
        sourcePaths: string[];
        sourcePin: string;
        mergeStrategy: string;
        managedBlockHash: string | null;
      }>;
    };
    const expectRejected = (mutate: (receipt: typeof original) => void, pattern: RegExp) => {
      const receipt = structuredClone(original);
      mutate(receipt);
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      expect(() => readEccProfileOwnership(root)).toThrow(pattern);
    };
    const firstFile = (receipt: typeof original) => {
      const file = receipt.files.at(0);
      if (file === undefined) throw new Error("fixture receipt has no files");
      return file;
    };

    expectRejected((receipt) => receipt.files.push({ ...firstFile(receipt) }), /ambiguous active/i);
    expectRejected((receipt) => {
      firstFile(receipt).destination = "outside/file.md";
    }, /unmanaged active/i);
    expectRejected((receipt) => {
      const file = firstFile(receipt);
      const sourcePath = file.sourcePaths.at(0);
      if (sourcePath === undefined) throw new Error("fixture receipt file has no source path");
      file.sourcePaths = [sourcePath, sourcePath.toUpperCase()];
    }, /ambiguous active source paths/i);
    expectRejected((receipt) => {
      firstFile(receipt).sourcePin = COMMIT_B;
    }, /contradictory source pin/i);
    expectRejected((receipt) => {
      firstFile(receipt).managedBlockHash = "f".repeat(64);
    }, /contradictory merge metadata/i);
  });

  it("enforces lifecycle operation and ownership preconditions", async () => {
    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "update")).toThrow(
      /update requires an ownership receipt/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "repair")).toThrow(
      /repair requires an ownership receipt/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "rollback")).toThrow(
      /rollback requires an ownership receipt/i,
    );

    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "install")).toThrow(
      /already owned at a different pin/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "update")).toThrow(
      /exact new source pin/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "repair")).toThrow(
      /repair projection contradicts/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "rollback")).toThrow(
      /rollback projection contradicts/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "rollback")).toThrow(
      /no rollback snapshot/i,
    );
  });

  it("refuses unowned destinations and incomplete owned state", async () => {
    put(".agents/skills/example/SKILL.md", "operator-owned skill\n");
    expect(() => planEccProfileLifecycle(root, projection(), "install")).toThrow(
      /existing unowned/i,
    );
    rmSync(join(root, ".agents/skills/example/SKILL.md"));

    put(
      ".codex/config.toml",
      "# >>> aih managed (ecc-profile) >>>\n[agents.operator]\n# <<< aih managed (ecc-profile) <<<\n",
    );
    expect(() => planEccProfileLifecycle(root, projection(), "install")).toThrow(
      /ambiguous existing.*managed block/i,
    );
    rmSync(join(root, ".codex/config.toml"));

    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    rmSync(join(root, ".agents/skills/example/SKILL.md"));
    expect(() => planEccProfileLifecycle(root, projection(COMMIT_B), "update")).toThrow(
      /missing; repair before update/i,
    );
  });
});

describe("ECC profile recovery authentication", () => {
  interface ReceiptFile {
    destination: string;
    sourcePin: string;
    sourcePaths: string[];
    normalizedHash: string;
    installedHash: string;
    managedBlockHash: string | null;
    previousHash: string | null;
    owner: "aih";
    capabilityOwner: "upstream";
    mergeStrategy: "replace" | "toml-merge";
    mode: "100644" | "100755";
    content: string;
  }
  interface Receipt {
    source: EccProfileInstalledSourceTrust;
    files: ReceiptFile[];
    rollback?: { source: EccProfileInstalledSourceTrust; files: ReceiptFile[] };
  }

  /** Version 1 binds destination, content and mode; version 2 also binds the merge strategy. */
  function filesDigest(files: readonly ReceiptFile[], version: 1 | 2): string {
    return sha256(
      [...files]
        .sort((left, right) =>
          left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
        )
        .map((file) =>
          version === 1
            ? `${file.destination}\0${file.normalizedHash}\0${file.mode}`
            : `${file.destination}\0${file.normalizedHash}\0${file.mode}\0${file.mergeStrategy}`,
        )
        .join("\n"),
    );
  }

  function identityVersion(source: EccProfileInstalledSourceTrust): 1 | 2 {
    return "recoveryIdentityVersion" in source ? 2 : 1;
  }

  function readReceipt(): Receipt {
    return JSON.parse(readFileSync(join(root, ECC_PROFILE_OWNERSHIP_PATH), "utf8")) as Receipt;
  }

  function writeReceipt(receipt: Receipt): void {
    writeFileSync(
      join(root, ECC_PROFILE_OWNERSHIP_PATH),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
  }

  /** The identity an installation made before recovery identities were versioned recorded. */
  function versionOne(
    source: EccProfileInstalledSourceTrust,
    files: readonly ReceiptFile[],
  ): EccProfileInstalledSourceTrust {
    return {
      repository: source.repository,
      commit: source.commit,
      sourceClosureId: source.sourceClosureId,
      sourceClosureSha256: source.sourceClosureSha256,
      projectionSha256: filesDigest(files, 1),
    };
  }

  /** Rewrite both recorded identities as version 1, as an older release wrote them. */
  function recordVersionOne(): {
    active: EccProfileInstalledSourceTrust;
    snapshot: EccProfileInstalledSourceTrust;
  } {
    const receipt = readReceipt();
    if (receipt.rollback === undefined) throw new Error("fixture has no rollback snapshot");
    receipt.source = versionOne(receipt.source, receipt.files);
    receipt.rollback.source = versionOne(receipt.rollback.source, receipt.rollback.files);
    writeReceipt(receipt);
    return { active: receipt.source, snapshot: receipt.rollback.source };
  }

  /**
   * Switch one snapshot entry's write semantics and recompute every self-declared
   * hash, including the snapshot's own identity digest under its version.
   */
  function switchSnapshotStrategy(destination: string): EccProfileInstalledSourceTrust {
    const receipt = readReceipt();
    if (receipt.rollback === undefined) throw new Error("fixture has no rollback snapshot");
    const entry = receipt.rollback.files.find((file) => file.destination === destination);
    if (entry === undefined) throw new Error(`fixture snapshot has no ${destination}`);
    if (entry.mergeStrategy === "replace") {
      const merged = upsertTextBlock("", "ecc-profile", entry.content);
      entry.mergeStrategy = "toml-merge";
      entry.managedBlockHash = sha256(merged.trimEnd());
      entry.installedHash = sha256(merged);
    } else {
      entry.mergeStrategy = "replace";
      entry.managedBlockHash = null;
      entry.installedHash = sha256(entry.content);
    }
    receipt.rollback.source.projectionSha256 = filesDigest(
      receipt.rollback.files,
      identityVersion(receipt.rollback.source),
    );
    writeReceipt(receipt);
    expect(readEccProfileOwnership(root)?.rollback?.files).toHaveLength(2);
    return receipt.rollback.source;
  }

  async function installThenUpdate(): Promise<{
    original: EccProfileInstalledSourceTrust;
    active: EccProfileInstalledSourceTrust;
    next: EccProjection;
  }> {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const original = readEccProfileOwnership(root)?.source;
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const active = readEccProfileOwnership(root)?.source;
    if (original === undefined || active === undefined) throw new Error("fixture has no receipt");
    return { original, active, next };
  }

  /** A self-consistent snapshot: an extra file, with every self-declared hash recomputed. */
  function injectRollbackFile(): EccProfileInstalledSourceTrust {
    const receiptPath = join(root, ECC_PROFILE_OWNERSHIP_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
    if (receipt.rollback === undefined) throw new Error("fixture has no rollback snapshot");
    const content = "# injected\n";
    receipt.rollback.files.push({
      destination: ".claude/agents/injected.md",
      sourcePin: COMMIT_A,
      sourcePaths: ["agents/injected.md"],
      normalizedHash: sha256(content),
      installedHash: sha256(content),
      managedBlockHash: null,
      previousHash: null,
      owner: "aih",
      capabilityOwner: "upstream",
      mergeStrategy: "replace",
      mode: "100644",
      content,
    });
    receipt.rollback.source.projectionSha256 = filesDigest(
      receipt.rollback.files,
      identityVersion(receipt.rollback.source),
    );
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    expect(readEccProfileOwnership(root)?.rollback?.files).toHaveLength(3);
    return receipt.rollback.source;
  }

  function recoveryRefusal(action: () => unknown): EccProfileRecoveryRefusalError {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(EccProfileRecoveryRefusalError);
      return error as EccProfileRecoveryRefusalError;
    }
    throw new Error("expected a recovery refusal");
  }

  it("refuses an installed rollback whose snapshot identity is not anchored", async () => {
    const { active } = await installThenUpdate();
    const refusal = recoveryRefusal(() =>
      planInstalledEccProfileLifecycle(root, "rollback", [active]),
    );
    expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
    expect(refusal.code).toBe("AIH_FRAMEWORK_PLUGIN");
    expect(refusal.message).toMatch(/rollback snapshot/i);
    expect(refusal.nextRoute).toMatch(/package version/i);
  });

  it("refuses a self-consistent rollback snapshot that adds a file, and writes nothing", async () => {
    const { original, active } = await installThenUpdate();
    const forged = injectRollbackFile();
    expect(forged.commit).toBe(original.commit);
    expect(forged.projectionSha256).not.toBe(original.projectionSha256);

    const refusal = recoveryRefusal(() =>
      planInstalledEccProfileLifecycle(root, "rollback", [active, original]),
    );
    expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
    expect(existsSync(join(root, ".claude/agents/injected.md"))).toBe(false);
    expect(readEccProfileOwnership(root)?.source.commit).toBe(COMMIT_B);
  });

  it("refuses the forged snapshot through the projection-bound rollback as well", async () => {
    const { original, next } = await installThenUpdate();
    injectRollbackFile();
    expect(
      recoveryRefusal(() => planEccProfileLifecycle(root, next, "rollback", [original])).reason,
    ).toBe("framework-profile-recovery-unanchored");
    expect(recoveryRefusal(() => planEccProfileLifecycle(root, next, "rollback")).reason).toBe(
      "framework-profile-recovery-unanchored",
    );
  });

  it("types the refusal for an unanchored active identity on every installed recovery", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    for (const operation of ["repair", "rollback", "uninstall"] as const) {
      const refusal = recoveryRefusal(() => planInstalledEccProfileLifecycle(root, operation, []));
      expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
      expect(refusal.message).toMatch(/installed source identity/i);
    }
  });

  it("rolls back when both the active and the snapshot identities are anchored", async () => {
    const { original, active } = await installThenUpdate();
    await executePlan(
      planInstalledEccProfileLifecycle(root, "rollback", [active, original]),
      ctx(true),
    );
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );
    expect(readEccProfileOwnership(root)?.source).toEqual(original);
  });

  it("refuses a snapshot entry switched from replace to toml-merge, and writes nothing", async () => {
    const { original, active, next } = await installThenUpdate();
    const skill = join(root, ".agents/skills/example/SKILL.md");
    const before = readFileSync(skill, "utf8");
    switchSnapshotStrategy(".agents/skills/example/SKILL.md");

    const refusal = recoveryRefusal(() =>
      planInstalledEccProfileLifecycle(root, "rollback", [active, original]),
    );
    expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
    expect(refusal.message).toMatch(/rollback snapshot/i);
    expect(
      recoveryRefusal(() => planEccProfileLifecycle(root, next, "rollback", [original])).reason,
    ).toBe("framework-profile-recovery-unanchored");
    expect(readFileSync(skill, "utf8")).toBe(before);
    expect(readEccProfileOwnership(root)?.source.commit).toBe(COMMIT_B);
  });

  it("refuses a snapshot entry switched from toml-merge to replace", async () => {
    const { original, active } = await installThenUpdate();
    switchSnapshotStrategy(".codex/config.toml");
    expect(
      recoveryRefusal(() => planInstalledEccProfileLifecycle(root, "rollback", [active, original]))
        .reason,
    ).toBe("framework-profile-recovery-unanchored");
  });

  it("records a versioned recovery identity that binds write semantics", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const receipt = readReceipt();
    expect(receipt.source).toMatchObject({ recoveryIdentityVersion: 2 });
    expect(receipt.source.projectionSha256).toBe(filesDigest(receipt.files, 2));
  });

  it("keeps verifying a recorded version-1 identity whose write semantics a version-2 anchor authenticates", async () => {
    const { original, active } = await installThenUpdate();
    const recorded = recordVersionOne();
    await executePlan(
      planInstalledEccProfileLifecycle(root, "rollback", [
        recorded.active,
        recorded.snapshot,
        active,
        original,
      ]),
      ctx(true),
    );
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );
    expect(readEccProfileOwnership(root)?.source).toEqual(recorded.snapshot);
  });

  it("refuses a version-1 snapshot whose write semantics changed under an unchanged version-1 digest", async () => {
    const { original, active } = await installThenUpdate();
    const recorded = recordVersionOne();
    expect(switchSnapshotStrategy(".agents/skills/example/SKILL.md")).toEqual(recorded.snapshot);
    const refusal = recoveryRefusal(() =>
      planInstalledEccProfileLifecycle(root, "rollback", [
        recorded.active,
        recorded.snapshot,
        active,
        original,
      ]),
    );
    expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
    expect(refusal.message).toMatch(/write semantics/i);
  });

  it("refuses a version-1 identity when no version-2 anchor authenticates its write semantics", async () => {
    await installThenUpdate();
    const recorded = recordVersionOne();
    const refusal = recoveryRefusal(() =>
      planInstalledEccProfileLifecycle(root, "rollback", [recorded.active, recorded.snapshot]),
    );
    expect(refusal.reason).toBe("framework-profile-recovery-unanchored");
    expect(refusal.message).toMatch(/write semantics/i);
  });

  /** Rewrite every recorded entry for `destination` with a forged `previousHash`. */
  function forgePreviousHash(destination: string, value: string | null): void {
    const receipt = readReceipt();
    const entries = [...receipt.files, ...(receipt.rollback?.files ?? [])].filter(
      (file) => file.destination === destination,
    );
    if (entries.length === 0) throw new Error(`fixture receipt has no ${destination}`);
    for (const entry of entries) entry.previousHash = value;
    writeReceipt(receipt);
    expect(readEccProfileOwnership(root)).toBeDefined();
  }

  function mergeAction(planned: { actions: readonly unknown[] }): {
    kind: string;
    describe: string;
    contents?: string;
  } {
    const found = planned.actions.find(
      (action) => (action as { path?: string }).path === ".codex/config.toml",
    );
    if (found === undefined) throw new Error("plan has no .codex/config.toml action");
    return found as { kind: string; describe: string; contents?: string };
  }

  it("keeps a pre-existing whitespace-only merge file whose previousHash was forged to null", async () => {
    put(".codex/config.toml", "  \n");
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const anchors = anchoredInstall();
    forgePreviousHash(".codex/config.toml", null);

    expect(mergeAction(planEccProfileLifecycle(root, projection(), "uninstall")).kind).toBe(
      "write",
    );
    const planned = planInstalledEccProfileLifecycle(root, "uninstall", anchors);
    const action = mergeAction(planned);
    expect(action.kind).toBe("write");
    expect(action.contents).toBe("  \n");
    expect(action.describe).toMatch(/kept \.codex\/config\.toml/i);
    expect(action.describe).toMatch(/cannot prove.*created the whole file/i);

    const result = await executePlan(planned, ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("  \n");
    expect(result.writes.find((write) => write.path === ".codex/config.toml")?.describe).toMatch(
      /kept \.codex\/config\.toml/i,
    );
    expect(existsSync(join(root, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
  });

  it("keeps an AIH-created merge file as its stripped bytes and says so", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    expect(readEccProfileOwnership(root)?.files[1]?.previousHash).toBeNull();
    const planned = planInstalledEccProfileLifecycle(root, "uninstall", anchoredInstall());
    const action = mergeAction(planned);
    expect(action.kind).toBe("write");
    expect(action.describe).toMatch(/kept \.codex\/config\.toml.*remove it by hand/i);

    await executePlan(planned, ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("\n");
    expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);
  });

  it("keeps the merge file when a rollback carried a forged previousHash into the restored receipt", async () => {
    put(".codex/config.toml", "  \n");
    const { original, active } = await installThenUpdate();
    forgePreviousHash(".codex/config.toml", null);

    await executePlan(
      planInstalledEccProfileLifecycle(root, "rollback", [active, original]),
      ctx(true),
    );
    const restored = readEccProfileOwnership(root);
    expect(restored?.source).toEqual(original);
    expect(
      restored?.files.find((file) => file.destination === ".codex/config.toml")?.previousHash,
    ).toBeNull();

    await executePlan(planInstalledEccProfileLifecycle(root, "uninstall", [original]), ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("  \n");
  });

  it("keeps a merge file on rolling back its introduction and on a superseding update", async () => {
    put(".codex/config.toml", "  \n");
    const withoutConfig = projection();
    withoutConfig.files = withoutConfig.files.filter(
      (file) => file.destination !== ".codex/config.toml",
    );
    await executePlan(planEccProfileLifecycle(root, withoutConfig, "install"), ctx(true));
    const original = readEccProfileOwnership(root)?.source;
    if (original === undefined) throw new Error("fixture install recorded no receipt");
    const next = projection(COMMIT_B, "# example v2\n");
    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    const active = readEccProfileOwnership(root)?.source;
    if (active === undefined) throw new Error("fixture update recorded no receipt");
    forgePreviousHash(".codex/config.toml", null);

    const planned = planInstalledEccProfileLifecycle(root, "rollback", [active, original]);
    expect(mergeAction(planned).kind).toBe("write");
    await executePlan(planned, ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("  \n");

    await executePlan(planEccProfileLifecycle(root, next, "update"), ctx(true));
    forgePreviousHash(".codex/config.toml", null);
    const superseding = projection(COMMIT_A, "# example v3\n");
    superseding.files = superseding.files.filter(
      (file) => file.destination !== ".codex/config.toml",
    );
    expect(mergeAction(planEccProfileLifecycle(root, superseding, "update")).kind).toBe("write");
  });
});

describe("same-pin ECC profile projection migration", () => {
  const next = () => projection(COMMIT_A, "# example stub\n");
  const identity = (candidate: EccProjection) => eccProfileRecoveryIdentity(candidate);

  it("updates within the pin only when Core anchors both projection identities", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const installed = identity(projection());
    const changed = identity(next());

    for (const anchors of [[], [installed], [changed]]) {
      expect(() => planEccProfileLifecycle(root, next(), "update", anchors)).toThrow(
        EccProfileRecoveryRefusalError,
      );
    }
    expect(() => planEccProfileLifecycle(root, next(), "update", [installed])).toThrow(
      /new projection.*not an anchored/i,
    );
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );

    await executePlan(
      planEccProfileLifecycle(root, next(), "update", [installed, changed]),
      ctx(true),
    );
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example stub\n",
    );
    expect(readEccProfileOwnership(root)?.source).toEqual(changed);
    expect(readEccProfileOwnership(root)?.rollback?.source).toEqual(installed);
  });

  it("refuses a same-pin update that changes the source closure, even when anchored", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const other = next();
    other.sourceClosure = { ...other.sourceClosure, aggregateSha256: "2".repeat(64) };
    expect(() =>
      planEccProfileLifecycle(root, other, "update", [identity(projection()), identity(other)]),
    ).toThrow(/exact new source pin/i);
  });

  it("refuses repair of an installation a later anchored render of its pin supersedes", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const installed = identity(projection());
    rmSync(join(root, ".agents/skills/example/SKILL.md"));

    expect(() =>
      planInstalledEccProfileLifecycle(root, "repair", [installed, identity(next())]),
    ).toThrow(/superseded.*--lifecycle update/i);
    expect(() =>
      planEccProfileLifecycle(root, projection(), "repair", [installed, identity(next())]),
    ).toThrow(/superseded.*--lifecycle update/i);
    // The current render of the pin still repairs.
    await executePlan(planInstalledEccProfileLifecycle(root, "repair", [installed]), ctx(true));
    expect(readFileSync(join(root, ".agents/skills/example/SKILL.md"), "utf8")).toBe(
      "# example v1\n",
    );
  });
});
