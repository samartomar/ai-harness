import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBaselineVetRequestV1Json } from "@aihq/scan";
import { afterEach, describe, expect, it } from "vitest";
import { defineCandidateSourceInventory } from "../../src/baseline-evidence/candidate-preparation.js";
import { hashSourceTree } from "../../src/baseline-evidence/hash.js";

const roots: string[] = [];
const tool = resolve("tools/prepare-candidate-baseline-requests.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-candidate-request-tool-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(join(source, "skills", "demo"), { recursive: true });
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(source, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
  const inventory = join(root, "inventory.json");
  writeFileSync(
    inventory,
    JSON.stringify({
      protocol: "CandidateBaselineInventoryV1",
      producer: { id: "aih-core-candidate-preparation-v1" },
      source: {
        id: "fixture",
        owner: "example",
        repository: "fixture",
        pinnedCommit: "a".repeat(40),
        treeSha256: hashSourceTree(source).treeSha256,
      },
      components: [
        { id: "runtime:root", paths: ["README.md"], content: "general" },
        { id: "skill:demo", paths: ["skills/demo"], content: "skill" },
      ],
      exclusions: [],
    }),
    "utf8",
  );
  return { root, source, inventory, output: join(root, "requests") };
}

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", tool, ...args], {
    encoding: "utf8",
  });
}

describe("candidate request preparation tool", () => {
  it("ships the six reviewed candidate inventories outside package runtime", () => {
    const directory = resolve(".github/baseline-candidates");
    const expected = new Map([
      ["aih-core.inventory.json", ["aih-core", 16]],
      ["anthropics-skills.inventory.json", ["anthropics-skills", 23]],
      ["ecc.inventory.json", ["ecc", 942]],
      ["mattpocock-skills.inventory.json", ["mattpocock-skills", 46]],
      ["ponytail.inventory.json", ["ponytail", 36]],
      ["superpowers.inventory.json", ["superpowers", 30]],
    ] as const);

    expect(readdirSync(directory).sort()).toEqual([...expected.keys()].sort());
    for (const [name, [id, componentCount]] of expected) {
      const inventory = defineCandidateSourceInventory(
        JSON.parse(readFileSync(join(directory, name), "utf8")),
      );
      expect(inventory.source.id).toBe(id);
      expect(inventory.components).toHaveLength(componentCount);
    }
  });

  it("writes canonical bounded requests for one sealed inventory", () => {
    const { source, inventory, output } = fixture();
    const result = run(["--inventory", inventory, "--source", source, "--output", output]);

    expect(result.status, result.stderr).toBe(0);
    const request = parseBaselineVetRequestV1Json(
      readFileSync(join(output, "batch-001.request.json"), "utf8"),
    );
    expect(request.source).toMatchObject({ id: "fixture", pinnedCommit: "a".repeat(40) });
    expect(request.components.map((component) => component.id)).toEqual([
      "runtime:root",
      "skill:demo",
    ]);
  });

  it("fails closed on source drift, unknown arguments, and an existing output", () => {
    const { source, inventory, output } = fixture();
    writeFileSync(join(source, "drift.txt"), "drift\n", "utf8");
    expect(run(["--inventory", inventory, "--source", source, "--output", output]).status).not.toBe(
      0,
    );
    expect(run(["--unknown", inventory]).status).not.toBe(0);

    const clean = fixture();
    mkdirSync(clean.output);
    expect(
      run(["--inventory", clean.inventory, "--source", clean.source, "--output", clean.output])
        .status,
    ).not.toBe(0);
  });
});
