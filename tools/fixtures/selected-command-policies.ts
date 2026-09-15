import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { compilePolicy } from "../../src/org-policy/workbench/policy-compiler.js";
import { defaultPreparedWorkbenchCatalog } from "../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../src/org-policy/workbench/selection-engine.js";

const fixtureRoot = process.argv[2];
if (!fixtureRoot || !isAbsolute(fixtureRoot)) {
  throw new Error("Expected the absolute prepared command fixture root");
}

const fixture = JSON.parse(
  readFileSync(join(fixtureRoot, "PREPARED.json"), "utf8"),
) as {
  commit: string;
  store: string;
  verifier: string;
};
if (
  process.env.AIH_WORKBENCH_DATA !== fixture.store ||
  process.env.AIH_WORKBENCH_VERIFIER_HOME !== fixture.verifier
) {
  throw new Error(
    "Run with the prepared fixture's isolated Workbench store and verifier home",
  );
}

const prepared = defaultPreparedWorkbenchCatalog();
const commandAssetId = "ecc/baseline:commands";
const requiredModuleId = "ecc/module:commands-core";

for (const [name, skill] of [
  ["Harbor", "tdd-workflow"],
  ["Cedar", "security-review"],
] as const) {
  const expected = [commandAssetId, requiredModuleId, `ecc/skill:${skill}`];
  for (const assetId of expected) {
    const asset = prepared.bundle.assets[assetId];
    if (
      asset === undefined ||
      asset.sourceId !== "source:ecc" ||
      asset.sourceRevisionId !== fixture.commit
    ) {
      throw new Error(
        `Imported command fixture does not provide ${assetId} at its exact pin`,
      );
    }
  }

  let state = createWorkbenchState();
  for (const assetId of [
    commandAssetId,
    requiredModuleId,
    `ecc/skill:${skill}`,
  ]) {
    const selected = reduceWorkbenchAction(prepared.bundle, state, {
      type: "select-root",
      assetId,
      origin: { kind: "administrator" },
    });
    if (!selected.accepted) {
      throw new Error(
        selected.diagnostics?.map((item) => item.message).join("; "),
      );
    }
    state = selected.state;
  }
  const compiled = compilePolicy(
    {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        supportedClis: ["claude", "codex", "cursor", "kimi"],
        policyVersion: "fictional-complete-commands-v1",
        catalog: { reviewed: [], custom: [] },
      },
    },
    state,
    prepared.bundle,
    prepared.bindings,
    "author",
    prepared.sourceInputs,
  );
  if (!compiled.accepted) throw new Error(compiled.diagnostics.join("; "));
  const policy = compiled.policy as Record<string, unknown>;
  if (policy.schemaVersion !== 3)
    throw new Error("Workbench did not compile schema version 3");
  const external = (
    policy.governance as {
      externalSelections?: { framework: string; items: { id: string }[] }[];
    }
  ).externalSelections;
  const ids = external
    ?.find((selection) => selection.framework === "ecc")
    ?.items.map((item) => item.id);
  if (
    JSON.stringify(ids?.sort()) !==
    JSON.stringify(expected.map((id) => id.slice(4)).sort())
  ) {
    throw new Error(
      "Workbench did not compile the exact governed ECC selection",
    );
  }
  const output = join(fixtureRoot, `${name}-policy-v2.json`);
  if (existsSync(output)) throw new Error(`${output} already exists`);
  writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx" });
}
