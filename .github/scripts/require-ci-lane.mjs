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

if (eventName !== "pull_request" && eventName !== "push") throw new Error(`unsupported CI event: ${eventName}`);
if (fullSuite !== "true" && fullSuite !== "false") throw new Error(`invalid full-suite decision: ${fullSuite}`);
if (!["docs", "core", "workbench", "both", "full"].includes(testLane)) throw new Error("invalid test lane: " + testLane);

const full = fullSuite === "true";
if (full && testLane !== "full") throw new Error("full receipt must select the full lane");
if (!full && testLane === "full") throw new Error("selected receipt cannot claim the full lane");
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
