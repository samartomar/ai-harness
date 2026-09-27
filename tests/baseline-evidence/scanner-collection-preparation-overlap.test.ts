import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The checkout head is the only process the definition gate reads; everything else is real.
const PIN = "0123456789abcdef0123456789abcdef01234567";
vi.mock("node:child_process", () => ({ execFileSync: () => `${PIN}\n` }));

import { prepareWorkbenchCollectionEvidenceCommandV1 } from "../../src/internals/prepare-workbench-collection-evidence.js";

let root: string;
let source: string;

function write(relative: string, text: string): void {
  const path = join(source, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function definition(components: readonly { id: string; paths: string[] }[]): string {
  const path = join(root, "ecc.definition.json");
  writeFileSync(
    path,
    JSON.stringify({ id: "ecc", owner: "affaan-m", repo: "ECC", pinnedSha: PIN, components }),
  );
  return path;
}

/** ECC's shape at its requalification pin: two components both carry AGENTS.md. */
const ECC_VIEWS = [
  { id: "module:agents-core", paths: [".agents", "agents", "AGENTS.md"] },
  { id: "baseline:agents", paths: [".agents/plugins/marketplace.json", "AGENTS.md"] },
];

function run(definitionPath: string, extra: readonly string[] = []) {
  mkdirSync(join(root, "publications"), { recursive: true });
  return prepareWorkbenchCollectionEvidenceCommandV1([
    "--catalog",
    "ecc",
    "--source",
    source,
    "--publication-root",
    join(root, "publications"),
    "--output",
    join(root, "output.json"),
    "--definition",
    definitionPath,
    "--source-bundle",
    join(root, "missing-bundle.json"),
    ...extra,
  ]);
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-collection-overlap-"));
  source = join(root, "source");
  write("AGENTS.md", "# agents\n");
  write(".agents/plugins/marketplace.json", "{}\n");
  write("agents/planner.md", "---\nname: planner\n---\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("--definition-overlap on the collection preparation command", () => {
  it("refuses ECC's overlapping views by default and under disjoint, before any publication is read", async () => {
    const overlap =
      /baseline definition: components module:agents-core and baseline:agents overlap/u;
    await expect(run(definition(ECC_VIEWS))).rejects.toThrow(overlap);
    await expect(run(definition(ECC_VIEWS), ["--definition-overlap", "disjoint"])).rejects.toThrow(
      overlap,
    );
  });

  it("admits ECC's overlapping views under compiler-catalog and moves on to the candidate bundle", async () => {
    await expect(
      run(definition(ECC_VIEWS), ["--definition-overlap", "compiler-catalog"]),
    ).rejects.toThrow(/unusable candidate source bundle/u);
  });

  it.each(["disjoint", "compiler-catalog"])(
    "refuses overlap inside one component under %s",
    async (mode) => {
      const inner = definition([
        { id: "module:agents-core", paths: [".agents", ".agents/plugins"] },
      ]);
      await expect(run(inner, ["--definition-overlap", mode])).rejects.toThrow(
        "baseline definition: component module:agents-core paths overlap: .agents, .agents/plugins",
      );
    },
  );

  it.each([
    ["an unknown mode", ["--definition-overlap", "any"]],
    ["a repeated mode", ["--definition-overlap", "disjoint", "--definition-overlap", "disjoint"]],
  ])("rejects %s as a usage error", async (_label, extra) => {
    await expect(run(definition(ECC_VIEWS), extra)).rejects.toThrow(/^Usage: /u);
  });
});
