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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  planEccProfileLifecycle,
  readEccProfileOwnership,
} from "../../src/ecc-profile/lifecycle.js";
import type { EccProjection, RenderedProjectionFile } from "../../src/ecc-profile/render.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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

    await executePlan(planEccProfileLifecycle(root, next, "rollback"), ctx(true));
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

  it("preserves an AIH-created merge-file sentinel across update and uninstall", async () => {
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
    expect(existsSync(join(root, ".codex/config.toml"))).toBe(false);
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
      /does not close over the pinned projection/i,
    );
    expect(() => planEccProfileLifecycle(root, projection(), "repair")).toThrow(
      /does not close over the pinned projection/i,
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
      /does not close over the pinned projection/i,
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

  it("rejects an update whose rollback receipt would exceed its read boundary", async () => {
    const bytes = `${"x".repeat(4 * 1024 * 1024 - 1025)}\n`;
    const initial = projection();
    initial.files = Array.from({ length: 9 }, (_, index) =>
      projectedFile(COMMIT_A, `.agents/skills/large-${index}/SKILL.md`, bytes),
    );
    await executePlan(planEccProfileLifecycle(root, initial, "install"), ctx(true));
    const next = projection(COMMIT_B);
    next.files = Array.from({ length: 9 }, (_, index) =>
      projectedFile(
        COMMIT_B,
        `.agents/skills/large-${index}/SKILL.md`,
        `${"y".repeat(4 * 1024 * 1024 - 1025)}\n`,
      ),
    );

    expect(() => planEccProfileLifecycle(root, next, "update")).toThrow(
      /ownership receipt.*(size|limit|large)/i,
    );
  }, 30_000);

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

  it("removes AIH-created merge files across update and rollback", async () => {
    await executePlan(planEccProfileLifecycle(root, projection(), "install"), ctx(true));
    const withoutConfig = projection(COMMIT_B, "# example v2\n");
    withoutConfig.files = withoutConfig.files.filter(
      (file) => file.destination !== ".codex/config.toml",
    );
    await executePlan(planEccProfileLifecycle(root, withoutConfig, "update"), ctx(true));
    expect(existsSync(join(root, ".codex/config.toml"))).toBe(false);

    await executePlan(planEccProfileLifecycle(root, withoutConfig, "rollback"), ctx(true));
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toContain(
      "# >>> aih managed (ecc-profile) >>>",
    );

    await executePlan(planEccProfileLifecycle(root, withoutConfig, "update"), ctx(true));
    await executePlan(planEccProfileLifecycle(root, withoutConfig, "rollback"), ctx(true));
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
});
