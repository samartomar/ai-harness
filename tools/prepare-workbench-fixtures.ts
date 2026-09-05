import { syntheticWorkbenchModel, syntheticEvidenceWorkbenchModel } from "./workbench-synthetic-fixture.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compactJourneyWorkbenchModel } from "./workbench-journey-fixture.js";
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

for (const size of [10, 1000, 10000]) await writeFile(resolve(directory, `synthetic-${size}.html`), policyStudioHtml(syntheticWorkbenchModel(size)), "utf8");

await writeFile(resolve(directory, "synthetic-evidence.html"), policyStudioHtml(syntheticEvidenceWorkbenchModel()), "utf8");

for (const missing of ["workbenchBundle", "workbenchBindings", "both"]) {
  const broken = syntheticWorkbenchModel(10);
  if (missing === "both") {
    Reflect.deleteProperty(broken, "workbenchBundle");
    Reflect.deleteProperty(broken, "workbenchBindings");
  } else Reflect.deleteProperty(broken, missing);
  await writeFile(resolve(directory, "invalid-" + missing + ".html"), policyStudioHtml(broken), "utf8");
}

const malformedPolicy = syntheticWorkbenchModel(10);
Object.assign(malformedPolicy.initialPolicy, {
  schemaVersion: 3, minimumCoreVersion: "0.6.0",
  authoringSelections: { selectionVersion: "workbench-selection/v1", roots: [], exclusions: [], requests: [], drafts: [] },
  security: { strix: { ...{ enabled: false, required: false, targetKind: "local-fixture", mode: "quick", maxBudgetCents: 1, maxTurns: 1, timeoutMs: 1, telemetry: "off", imageDigest: "sha256:" + "a".repeat(64), allowLiveTargets: false, allowMounts: false }, maxTurns: 999 } },
});
await writeFile(resolve(directory, "invalid-policy.html"), policyStudioHtml(malformedPolicy), "utf8");
