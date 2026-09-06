const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is missing`);
  return value;
};

const requireResult = (name, actual, expected) => {
  if (actual !== expected) throw new Error(`${name} result is ${actual}; expected ${expected}`);
};

const eventName = required("EVENT_NAME");
const fullSuite = required("FULL_SUITE");
const classifyResult = required("CLASSIFY_RESULT");
const releasePreparationResult = required("RELEASE_PREP_RESULT");
const qualityResult = required("QUALITY_RESULT");
const selectedResult = required("SELECTED_RESULT");
const fullResult = required("FULL_RESULT");
const windowsResult = required("WINDOWS_RESULT");
const testLane = required("TEST_LANE");
const workbenchResult = required("WORKBENCH_RESULT");
const providerResult = required("PROVIDER_RESULT");
const affectedProviders = JSON.parse(required("AFFECTED_PROVIDERS_JSON"));
const packedArtifactRequired = required("REQUIRES_PACKED_ARTIFACT");
const genericBrowserRequired = required("REQUIRES_GENERIC_BROWSER_JOURNEYS");

if (eventName !== "pull_request" && eventName !== "push") throw new Error(`unsupported CI event: ${eventName}`);
if (fullSuite !== "true" && fullSuite !== "false") throw new Error(`invalid full-suite decision: ${fullSuite}`);
const knownProviders = new Set(["aih", "ecc", "mattpocock", "organization", "superpowers"]);
if (
  !Array.isArray(affectedProviders) ||
  affectedProviders.some((provider) => typeof provider !== "string" || !knownProviders.has(provider)) ||
  JSON.stringify([...new Set(affectedProviders)].sort()) !== JSON.stringify(affectedProviders)
) {
  throw new Error("invalid affected providers");
}
if (!["true", "false"].includes(packedArtifactRequired) || !["true", "false"].includes(genericBrowserRequired)) throw new Error("invalid explicit Workbench requirement");
if (!["docs", "core", "workbench", "both", "full"].includes(testLane)) throw new Error("invalid test lane: " + testLane);

const full = fullSuite === "true";
const browserRequired = genericBrowserRequired === "true";
if (full && (!browserRequired || testLane !== "full" || affectedProviders.length !== 0)) {
  throw new Error("full receipt must require the generic browser lane with no provider subset");
}
if (!full && testLane === "full") throw new Error("selected receipt cannot claim the full lane");
const providerRequired = !full && affectedProviders.length > 0 && !browserRequired;
if (packedArtifactRequired !== (full || providerRequired || browserRequired ? "true" : "false")) throw new Error("packed artifact requirement does not match required execution");
requireResult("Workbench browser lane", workbenchResult, browserRequired ? "success" : "skipped");
requireResult("provider lane", providerResult, providerRequired ? "success" : "skipped");
requireResult("classifier", classifyResult, "success");
requireResult("quality", qualityResult, "success");
requireResult("release preparation guard", releasePreparationResult, eventName === "pull_request" ? "success" : "skipped");

if (full) {
  requireResult("selected lane", selectedResult, "skipped");
  requireResult("full Ubuntu/macOS lane", fullResult, "success");
  requireResult("full Windows lane", windowsResult, "success");
} else {
  requireResult("selected lane", selectedResult, "success");
  requireResult("full Ubuntu/macOS lane", fullResult, "skipped");
  requireResult("full Windows lane", windowsResult, "skipped");
}

console.log(`Accepted ${full ? "complete" : "selected"} CI lane.`);
