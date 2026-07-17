import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSyntheticMethodologyProjection } from "../../src/methodology/projection-planner.js";
import {
  applySyntheticMethodologyProjectionTransaction,
  cleanSyntheticMethodologyProjectionTransaction,
  createSyntheticMethodologyTransactionFixtureRoot,
  disposeSyntheticMethodologyTransactionFixtureRoot,
  recoverSyntheticMethodologyProjectionTransaction,
  syntheticMethodologyTransactionFixturePath,
  type SyntheticMethodologyTransactionFixtureRoot,
  type SyntheticMethodologyTransactionTestBoundary,
} from "../../src/methodology/transaction.js";

const roots: SyntheticMethodologyTransactionFixtureRoot[] = [];

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(id: string, text: string) {
  const contentDigest = digest(text);
  const sourceIdentity = {
    locator: `synthetic://fixture/${id}`,
    digest: digest(`source-${id}`),
  };
  return {
    id,
    path: `rules/${id}.md`,
    kind: "regular",
    content: { classification: "passive", digest: contentDigest },
    sourceIdentity,
    evidence: {
      target: {
        artifact: id,
        path: `rules/${id}.md`,
        sourceIdentity,
        contentDigest,
      },
      source: "exact",
      trust: "admitted",
      license: "allowed",
    },
    dependencies: [],
  };
}

function transaction(entries: Array<[string, string]> = [["review-loop", "# review\n"]]) {
  const artifacts = entries.map(([id, text]) => artifact(id, text));
  const plan = planSyntheticMethodologyProjection({
    schemaVersion: 1,
    classification: {
      schemaVersion: 1,
      roots: artifacts.map((value) => value.id),
      artifacts,
    },
    mappings: artifacts.map((value) => ({
      id: value.id,
      target: { path: `methodology/v1/rules/${value.id}.md`, owner: "aih-methodology-v1" },
    })),
  });
  if (plan.state !== "planned") throw new Error("test fixture must plan");
  return {
    plan,
    contents: entries.map(([id, text]) => ({ id, bytes: Buffer.from(text, "utf8") })),
  };
}

function root(): SyntheticMethodologyTransactionFixtureRoot {
  const fixtureRoot = createSyntheticMethodologyTransactionFixtureRoot();
  roots.push(fixtureRoot);
  return fixtureRoot;
}

afterEach(() => {
  for (const fixtureRoot of roots.splice(0)) {
    disposeSyntheticMethodologyTransactionFixtureRoot(fixtureRoot);
  }
});

describe("synthetic methodology projection transactions", () => {
  it("applies exact in-memory bytes atomically inside its disposable fixture root and cleans them", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);

    expect(applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction())).toEqual({
      state: "projected",
      manifestDigest: transaction().plan.manifest?.digest,
    });
    expect(readFileSync(join(fixturePath, ".aih/methodology/v1/rules/review-loop.md"), "utf8")).toBe(
      "# review\n",
    );
    expect(cleanSyntheticMethodologyProjectionTransaction(fixtureRoot)).toEqual({ state: "cleaned" });
    expect(existsSync(join(fixturePath, ".aih"))).toBe(false);
  });

  it("rejects content whose exact digest does not bind the planned artifact before any output exists", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    const input = transaction();
    const content = input.contents[0];
    if (content === undefined) throw new Error("test fixture must contain bytes");
    content.bytes = Buffer.from("tampered", "utf8");

    expect(() => applySyntheticMethodologyProjectionTransaction(fixtureRoot, input)).toThrow(
      /content digest/i,
    );
    expect(existsSync(join(fixturePath, ".aih"))).toBe(false);
  });

  it("refuses an unowned output parent without changing its sentinel", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    mkdirSync(join(fixturePath, ".aih"));
    writeFileSync(join(fixturePath, ".aih/sentinel"), "keep", "utf8");

    expect(() => applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction())).toThrow(
      /unowned/i,
    );
    expect(readFileSync(join(fixturePath, ".aih/sentinel"), "utf8")).toBe("keep");
  });

  it("refuses linked output parents without following them", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    const outside = join(fixturePath, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fixturePath, ".aih"), "dir");

    expect(() => applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction())).toThrow(
      /linked|reparse|unowned/i,
    );
    expect(existsSync(join(outside, "methodology"))).toBe(false);
  });

  it("fails closed when a committed projection acquires a hard-linked artifact", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction());
    const file = join(fixturePath, ".aih/methodology/v1/rules/review-loop.md");
    linkSync(file, join(fixturePath, "hard-link"));

    expect(() => cleanSyntheticMethodologyProjectionTransaction(fixtureRoot)).toThrow(
      /linked|hard.link/i,
    );
    expect(readFileSync(file, "utf8")).toBe("# review\n");
  });

  it("refuses to clean a projection tree with an unknown file", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction());
    writeFileSync(join(fixturePath, ".aih/methodology/v1/unowned.txt"), "must remain", "utf8");

    expect(() => cleanSyntheticMethodologyProjectionTransaction(fixtureRoot)).toThrow(/unknown/i);
    expect(readFileSync(join(fixturePath, ".aih/methodology/v1/unowned.txt"), "utf8")).toBe(
      "must remain",
    );
  });

  it("revalidates containment after a test-simulated TOCTOU swap before commit", () => {
    const fixtureRoot = root();
    const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);
    const outside = join(fixturePath, "outside");
    mkdirSync(outside);

    expect(() =>
      applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction(), {
        onBoundary(boundary) {
          if (boundary !== "before-commit") return;
          renameSync(join(fixturePath, ".aih"), join(fixturePath, ".aih-original"));
          symlinkSync(outside, join(fixturePath, ".aih"), "dir");
        },
      }),
    ).toThrow(/containment|linked|reparse/i);
    expect(existsSync(join(outside, "methodology"))).toBe(false);
  });

  it.each([
    "after-container",
    "after-lock",
    "after-stage",
    "after-entry",
    "after-receipt",
    "before-commit",
    "after-commit",
  ] satisfies SyntheticMethodologyTransactionTestBoundary[])(
    "recovers deterministically after injected failure at %s",
    (faultAt) => {
      const fixtureRoot = root();
      const fixturePath = syntheticMethodologyTransactionFixturePath(fixtureRoot);

      expect(() =>
        applySyntheticMethodologyProjectionTransaction(fixtureRoot, transaction(), { faultAt }),
      ).toThrow(/injected/i);
      const recovered = recoverSyntheticMethodologyProjectionTransaction(fixtureRoot);
      expect(["absent", "recovered"]).toContain(recovered.state);
      expect(cleanSyntheticMethodologyProjectionTransaction(fixtureRoot)).toEqual({
        state: recovered.state === "recovered" ? "cleaned" : "absent",
      });
      expect(existsSync(join(fixturePath, ".aih"))).toBe(false);
    },
  );

  it("does not permit arbitrary objects to act as fixture-root capabilities", () => {
    expect(() =>
      applySyntheticMethodologyProjectionTransaction({} as SyntheticMethodologyTransactionFixtureRoot, transaction()),
    ).toThrow(/fixture root/i);
  });
});
