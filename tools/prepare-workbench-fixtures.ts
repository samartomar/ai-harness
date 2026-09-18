import { syntheticWorkbenchModel, syntheticEvidenceWorkbenchModel } from "./workbench-synthetic-fixture.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compactJourneyWorkbenchModel } from "./workbench-journey-fixture.js";
import { parseOrgPolicyContents } from "../src/org-policy/schema.js";
import { defaultStudioPolicy, policyStudioModel } from "../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../src/org-policy/studio-template.js";

const directory = process.argv[2];
if (!directory) throw new Error("Workbench fixture output directory is required");
await mkdir(directory, { recursive: true });
const journeyHtml = policyStudioHtml(compactJourneyWorkbenchModel());
const repeatedJourneyHtml = policyStudioHtml(compactJourneyWorkbenchModel());
if (journeyHtml !== repeatedJourneyHtml)
  throw new Error("Compact Workbench fixture generation is not byte-stable");
await Promise.all([
  writeFile(resolve(directory, "aih-policy-workbench.html"), journeyHtml, "utf8"),
  writeFile(resolve(directory, "journeys-compact.html"), journeyHtml, "utf8"),
]);
console.log("Prepared compact offline Workbench fixture: " + Buffer.byteLength(journeyHtml) + " bytes");

// NEW-SHELL-PLAN.md §3: the same models rendered by the new admin shell, for
// specs that run with the fixture option `shell: "new"`.
await mkdir(resolve(directory, "new-shell"), { recursive: true });
const newShellJourneyHtml = policyStudioHtml({ ...compactJourneyWorkbenchModel(), shell: "new" });
await Promise.all([
  writeFile(resolve(directory, "new-shell", "aih-policy-workbench.html"), newShellJourneyHtml, "utf8"),
  writeFile(resolve(directory, "new-shell", "journeys-compact.html"), newShellJourneyHtml, "utf8"),
]);

for (const size of [10, 1000, 10000]) {
  await writeFile(resolve(directory, `synthetic-${size}.html`), policyStudioHtml(syntheticWorkbenchModel(size)), "utf8");
  // S3: the sources screen specs run these on the new shell.
  await writeFile(resolve(directory, "new-shell", `synthetic-${size}.html`), policyStudioHtml({ ...syntheticWorkbenchModel(size), shell: "new" }), "utf8");
}

await writeFile(resolve(directory, "synthetic-evidence.html"), policyStudioHtml(syntheticEvidenceWorkbenchModel()), "utf8");

for (const missing of ["workbenchBundle", "workbenchBindings", "both"]) {
  const broken = syntheticWorkbenchModel(10);
  if (missing === "both") {
    Reflect.deleteProperty(broken, "workbenchBundle");
    Reflect.deleteProperty(broken, "workbenchBindings");
  } else Reflect.deleteProperty(broken, missing);
  await writeFile(resolve(directory, "invalid-" + missing + ".html"), policyStudioHtml(broken), "utf8");
  await writeFile(resolve(directory, "new-shell", "invalid-" + missing + ".html"), policyStudioHtml({ ...broken, shell: "new" }), "utf8");
}

const malformedPolicy = syntheticWorkbenchModel(10);
Object.assign(malformedPolicy.initialPolicy, {
  schemaVersion: 3, minimumCoreVersion: "0.6.0",
  authoringSelections: { selectionVersion: "workbench-selection/v1", roots: [], exclusions: [], requests: [], drafts: [] },
  security: { strix: { ...{ enabled: false, required: false, targetKind: "local-fixture", mode: "quick", maxBudgetCents: 1, maxTurns: 1, timeoutMs: 1, telemetry: "off", imageDigest: "sha256:" + "a".repeat(64), allowLiveTargets: false, allowMounts: false }, maxTurns: 999 } },
});
await writeFile(resolve(directory, "invalid-policy.html"), policyStudioHtml(malformedPolicy), "utf8");
await writeFile(resolve(directory, "new-shell", "invalid-policy.html"), policyStudioHtml({ ...malformedPolicy, shell: "new" }), "utf8");

// P5b/P5c user door: the packaged default policy stands in for the bound org
// policy. It is written to a real file; the digest and initialPolicy both come
// from the exact bytes read back from that file, as the server does.
const boundPolicyPath = resolve(directory, "bound-policy", "aih-org-policy.json");
await mkdir(resolve(directory, "bound-policy"), { recursive: true });
await writeFile(boundPolicyPath, `${JSON.stringify(defaultStudioPolicy(), null, 2)}\n`, "utf8");
const boundPolicyBytes = await readFile(boundPolicyPath);
const userDoorModel = policyStudioModel(undefined, undefined, {
  initialPolicy: parseOrgPolicyContents(boundPolicyPath, boundPolicyBytes),
});
const userDoorBinding = resolve(directory, "project", ".aih-config.json");
await writeFile(resolve(directory, "user-door.html"), policyStudioHtml({
  ...userDoorModel,
  door: "user",
  policySource: { kind: "binding", path: boundPolicyPath, sha256: createHash("sha256").update(boundPolicyBytes).digest("hex"), valid: true },
}), "utf8");
await writeFile(resolve(directory, "user-door-invalid.html"), policyStudioHtml({
  ...userDoorModel,
  door: "user",
  policySource: { kind: "binding", path: userDoorBinding, valid: false, error: "Policy binding is invalid: <marker>" },
}), "utf8");
