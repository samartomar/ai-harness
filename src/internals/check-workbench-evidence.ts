import { policyStudioModel } from "../org-policy/studio-model.js";
import { inspectWorkbenchEvidenceCoverageV1 } from "../org-policy/workbench/delivery-readiness.js";
import { prepareWorkbenchEvidenceCompositionsForReleaseV1 } from "../org-policy/workbench/providers/evidence-compositions.js";

// Repository-owned release inspection: no target, scanner, network, or trust promotion.
const bundle = policyStudioModel().workbenchBundle;
const result = inspectWorkbenchEvidenceCoverageV1(
  bundle,
  new Date().toISOString(),
  prepareWorkbenchEvidenceCompositionsForReleaseV1(bundle),
);
const sources = [...new Set(result.assets.map((asset) => asset.sourceId))].map((sourceId) => {
  const assets = result.assets.filter((asset) => asset.sourceId === sourceId);
  return {
    sourceId,
    total: assets.length,
    covered: assets.filter((asset) => asset.problem === undefined).length,
    gaps: Object.fromEntries(
      [...new Set(assets.flatMap((asset) => (asset.problem ? [asset.problem] : [])))].map(
        (problem) => [problem, assets.filter((asset) => asset.problem === problem).length],
      ),
    ),
  };
});
console.log(JSON.stringify({ ready: result.ready, sources }, null, 2));
if (!result.ready) {
  console.error(
    "Workbench release blocked: every bundled item requires verified source evidence or a valid Core-derived composition.",
  );
  process.exitCode = 1;
}
