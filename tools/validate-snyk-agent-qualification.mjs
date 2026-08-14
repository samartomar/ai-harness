import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const ANALYZER = "snyk-agent-scan@uv:0.5.17";
const CHECK_NAME = "trust detector snyk-agent-scan";
const COMPLETED_PREFIX =
  "Snyk Agent Scan completed with JSON output, --no-bootstrap, and no MCP auto-exec bypass. No findings != safe. Analyzers run: ";
const ADVISORY_PREFIX = "No findings != safe. Static analyzers actually run: ";
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function analyzerList(value, prefix, suffix, name) {
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith(suffix)) {
    fail(`${name} does not match the reviewed format`);
  }
  const body = value.slice(prefix.length, value.length - suffix.length);
  const analyzers = body.split(", ").filter((candidate) => candidate.length > 0);
  if (analyzers.filter((candidate) => candidate === ANALYZER).length !== 1) {
    fail(`${name} does not contain the exact Snyk analyzer identity once`);
  }
  return analyzers;
}

function firstLine(value, name) {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value.split(/\r?\n/, 1)[0];
}

const [resultPath, summaryPath, ...extraArgs] = process.argv.slice(2);
if (
  extraArgs.length > 0 ||
  !resultPath ||
  !summaryPath ||
  !isAbsolute(resultPath) ||
  !isAbsolute(summaryPath) ||
  resultPath === summaryPath
) {
  fail("qualification requires distinct absolute result and summary paths");
}

const resultFd = openSync(resultPath, "r");
let raw;
try {
  const resultSize = fstatSync(resultFd).size;
  if (resultSize < 2 || resultSize > MAX_RESULT_BYTES) {
    fail("qualification result size is outside the reviewed boundary");
  }
  raw = readFileSync(resultFd, "utf8");
} finally {
  closeSync(resultFd);
}
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  fail("qualification result is not valid JSON");
}

const result = record(parsed, "qualification result");
if (result.capability !== "trust scan") fail("qualification result is not a trust scan");
const report = record(result.report, "qualification report");
if (report.ok !== true || !Array.isArray(report.checks)) {
  fail("qualification report is not a successful structured report");
}

const snykChecks = report.checks.filter(
  (candidate) =>
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    candidate.name === CHECK_NAME,
);
if (snykChecks.length !== 1 || snykChecks[0].verdict !== "pass") {
  fail("qualification requires exactly one passing Snyk detector check");
}
const checkAnalyzers = analyzerList(
  snykChecks[0].detail,
  COMPLETED_PREFIX,
  "",
  "Snyk detector check",
);

if (!Array.isArray(result.digests)) fail("qualification result is missing digests");
const advisories = result.digests.filter(
  (candidate) =>
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    candidate.describe === "trust runtime advisory",
);
if (advisories.length !== 1) fail("qualification requires one trust runtime advisory");
const advisoryAnalyzers = analyzerList(
  firstLine(advisories[0].text, "trust runtime advisory"),
  ADVISORY_PREFIX,
  ".",
  "trust runtime advisory",
);
if (JSON.stringify(advisoryAnalyzers) !== JSON.stringify(checkAnalyzers)) {
  fail("qualification analyzer evidence disagrees across structured outputs");
}

const commit = process.env.GITHUB_SHA ?? "";
const runId = process.env.GITHUB_RUN_ID ?? "";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
if (!/^[0-9a-f]{40}$/.test(commit)) fail("GitHub commit identity is invalid");
if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
  fail("GitHub run identity is invalid");
}

const summary = {
  schemaVersion: 1,
  commit,
  workflowRunId: runId,
  workflowRunAttempt: runAttempt,
  analyzer: ANALYZER,
  target: "synthetic-skill-fixture",
  status: "qualified",
  resultSha256: createHash("sha256").update(raw).digest("hex"),
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
