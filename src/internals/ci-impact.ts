import { isWorkbenchTestPath } from "./workbench-test-ownership.js";

export const CI_SELECTOR_VERSION = "1.5.5";

export type CiRiskClass = "docs" | "focused" | "cross-platform" | "full";
export type CiTestLane = "docs" | "core" | "workbench" | "both" | "full";
export type CiOperatingSystem = "ubuntu-latest" | "macos-latest" | "windows-latest";

export interface CiImpactInput {
  baseSha: string;
  headSha: string;
  changedPaths: readonly string[];
  testFiles: readonly string[];
}

export interface CiImpactValidationOptions {
  /** Local working-tree observations can have the same base and committed HEAD. */
  allowIdenticalRevisions?: boolean;
}

export interface CiImpactReceipt {
  schemaVersion: "aih-ci-impact-v2";
  selectorVersion: string;
  baseSha: string;
  headSha: string;
  changedPaths: string[];
  matchedRules: string[];
  selectedTests: string[];
  operatingSystems: CiOperatingSystem[];
  riskClass: CiRiskClass;
  testLane: CiTestLane;
  fullSuite: boolean;
  releasePreparation: boolean;
  fallbackReasons: string[];
  /** Retained empty for v2 receipt compatibility; providers are Catalog-owned. */
  affectedProviders: string[];
  providerTests: string[];
}

const SHA = /^[0-9a-f]{40}$/u;
const ALL_OPERATING_SYSTEMS: CiOperatingSystem[] = [
  "ubuntu-latest",
  "macos-latest",
  "windows-latest",
];

const ROOT_DOCUMENTS = new Set([
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "DISCLAIMER.md",
  "DCO.md",
  "PUBLIC_DOCS_POLICY.md",
  "README.md",
  "RELEASING.md",
  "ROADMAP.md",
  "SECURITY.md",
  "STABILITY.md",
  "SUPPORT.md",
  "TRADEMARKS.md",
  "VERSIONING.md",
]);

const GLOBAL_FILES = new Set([
  ".pre-commit-config.yaml",
  "package-lock.json",
  "package.json",
  "tsconfig.dts.json",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
]);

const GLOBAL_PREFIXES = [".github/workflows/", "schemas/", "tests/fixtures/", "tools/"];

const SELECTOR_PATHS = new Set([
  ".github/scripts/require-ci-lane.mjs",
  ".github/scripts/run-selected-tests.mjs",
  ".githooks/pre-commit",
  "src/internals/ci-impact-command.ts",
  "src/internals/ci-impact.ts",
  "src/internals/ci-local-verification.ts",
  "src/internals/ci-local-verification-command.ts",
  "src/internals/workbench-test-ownership.ts",
  "src/internals/delivery-governance-command.ts",
  "src/internals/delivery-governance.ts",
  "src/internals/staged-check.ts",
  "tests/internals/ci-impact.test.ts",
  "tests/internals/ci-local-verification.test.ts",
  "tests/internals/staged-check.test.ts",
  "tests/release/delivery-governance.test.ts",
]);

const RELEASE_PREPARATION_SIGNAL_PATHS = new Set([
  "release/enterprise-change.json",
  "src/version.ts",
]);

const CROSS_PLATFORM_DOMAINS = new Set([
  "binding",
  "capability",
  "certs",
  "commands",
  "ecc",
  "ecc-profile",
  "fs",
  "heal",
  "init",
  "internals",
  "mcp",
  "org-policy",
  "pack",
  "platform",
  "prune",
  "release",
  "trust",
  "workspace",
]);

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function isSafeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:\//u.test(value) &&
    !value.split("/").includes("..") &&
    !/[\0\r\n]/u.test(value)
  );
}

function domainOf(path: string, root: "src" | "tests"): string | undefined {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) return undefined;
  const relative = path.slice(prefix.length);
  const [first] = relative.split("/");
  if (!first) return undefined;
  return relative.includes("/") ? first : "root";
}

function testsForDomain(domain: string, testFiles: readonly string[]): string[] {
  if (domain === "root") {
    return testFiles.filter((path) => !path.slice("tests/".length).includes("/"));
  }
  return testFiles.filter((path) => path.startsWith(`tests/${domain}/`));
}

function isDocumentation(path: string): boolean {
  return (
    ROOT_DOCUMENTS.has(path) ||
    path.startsWith("docs/") ||
    path.startsWith("guides/") ||
    path.startsWith("ai-coding/") ||
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path === ".github/pull_request_template.md"
  );
}

function isWorkbenchTest(path: string): boolean {
  return isWorkbenchTestPath(path);
}

function scopedTestLane(
  changedPaths: readonly string[],
  selectedTests: readonly string[],
): Exclude<CiTestLane, "docs" | "full"> {
  let core = false;
  let workbench = selectedTests.some(isWorkbenchTest);
  for (const path of changedPaths) {
    if (isDocumentation(path)) continue;
    if (path.startsWith("src/catalog-package/") || path === "src/org-policy/catalog.ts") {
      core = true;
      workbench = true;
      continue;
    }
    if (isWorkbenchTest(path)) {
      workbench = true;
    } else if (path.startsWith("src/org-policy/")) {
      // Shared policy schemas, catalogs, and decisions feed the retained
      // backend policy/data contracts as well as Core consumers.
      core = true;
      workbench = true;
    } else {
      core = true;
    }
  }
  return core && workbench ? "both" : workbench ? "workbench" : "core";
}

function fullReceipt(
  input: Pick<CiImpactInput, "baseSha" | "headSha">,
  changedPaths: string[],
  testFiles: string[],
  matchedRules: readonly string[],
  fallbackReasons: readonly string[],
): CiImpactReceipt {
  return {
    schemaVersion: "aih-ci-impact-v2",
    selectorVersion: CI_SELECTOR_VERSION,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths,
    matchedRules: sortedUnique(matchedRules),
    selectedTests: testFiles,
    operatingSystems: [...ALL_OPERATING_SYSTEMS],
    riskClass: "full",
    testLane: "full",
    fullSuite: true,
    releasePreparation: changedPaths.some((path) => RELEASE_PREPARATION_SIGNAL_PATHS.has(path)),
    fallbackReasons: sortedUnique(fallbackReasons),
    affectedProviders: [],
    providerTests: [],
  };
}

export function classifyCiImpact(
  input: CiImpactInput,
  options: CiImpactValidationOptions = {},
): CiImpactReceipt {
  const changedPaths = sortedUnique(input.changedPaths.map(normalizePath));
  const testFiles = sortedUnique(input.testFiles.map(normalizePath));
  const matchedRules: string[] = [];
  const fallbackReasons: string[] = [];
  const selectedTests = new Set<string>();
  const selectedDomains = new Set<string>();
  let docsOnly = changedPaths.length > 0;
  let crossPlatform = false;

  if (changedPaths.length === 0) fallbackReasons.push("empty-change-set");

  for (const path of changedPaths) {
    if (!isSafeRepositoryPath(path)) {
      fallbackReasons.push(`invalid-path:${path}`);
      docsOnly = false;
      continue;
    }
    if (SELECTOR_PATHS.has(path)) {
      matchedRules.push("selector-control");
      fallbackReasons.push("selector-self-change");
      docsOnly = false;
      continue;
    }
    if (GLOBAL_FILES.has(path) || GLOBAL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      matchedRules.push("global-input");
      fallbackReasons.push(`global-input:${path}`);
      docsOnly = false;
      continue;
    }
    if (isDocumentation(path)) {
      matchedRules.push("documentation");
      for (const test of testFiles.filter((candidate) => candidate.startsWith("tests/docs/"))) {
        selectedTests.add(test);
      }
      continue;
    }
    docsOnly = false;
    if (path.startsWith("src/catalog-package/") || path === "src/org-policy/catalog.ts") {
      matchedRules.push("workbench-shared-input");
      selectedDomains.add("org-policy");
      const sourceDomain = domainOf(path, "src");
      if (sourceDomain !== undefined) {
        for (const test of testsForDomain(sourceDomain, testFiles)) selectedTests.add(test);
      }
      for (const test of testFiles.filter(isWorkbenchTest)) selectedTests.add(test);
      crossPlatform = true;
      continue;
    }
    const sourceDomain = domainOf(path, "src");
    if (sourceDomain !== undefined) {
      matchedRules.push(`source-domain:${sourceDomain}`);
      selectedDomains.add(sourceDomain);
      const ownedTests = testsForDomain(sourceDomain, testFiles);
      for (const test of ownedTests) selectedTests.add(test);
      // Both ECC entry points consume this renderer across domain boundaries.
      // Domain-only selection missed their literal-setting compatibility.
      if (path === "src/mcp/render.ts") {
        matchedRules.push("mcp-renderer-consumers");
        for (const domain of ["ecc", "ecc-profile"]) {
          for (const test of testsForDomain(domain, testFiles)) selectedTests.add(test);
        }
      }
      // Shared policy code can affect source contracts owned outside org-policy.
      if (sourceDomain === "org-policy") {
        for (const test of testFiles.filter(isWorkbenchTest)) selectedTests.add(test);
      }
      if (CROSS_PLATFORM_DOMAINS.has(sourceDomain)) crossPlatform = true;
      continue;
    }

    const testDomain = domainOf(path, "tests");
    if (testDomain !== undefined && path.endsWith(".test.ts")) {
      matchedRules.push(`test-domain:${testDomain}`);
      selectedDomains.add(testDomain);
      if (testFiles.includes(path)) selectedTests.add(path);
      if (CROSS_PLATFORM_DOMAINS.has(testDomain)) crossPlatform = true;
      continue;
    }

    if (
      path.startsWith(".github/") ||
      path.startsWith(".githooks/") ||
      path.startsWith("release/")
    ) {
      matchedRules.push("repository-policy");
      for (const test of testFiles.filter((candidate) => candidate.includes("release"))) {
        selectedTests.add(test);
      }
      continue;
    }

    fallbackReasons.push(`unknown-path:${path}`);
  }
  const providerIds: string[] = [];
  const providerTests: string[] = [];
  if (fallbackReasons.length > 0) {
    return validateCiImpactReceipt(
      fullReceipt(input, changedPaths, testFiles, matchedRules, fallbackReasons),
      options,
    );
  }

  if (!docsOnly && selectedDomains.size > 0 && selectedTests.size === 0) {
    return validateCiImpactReceipt(
      fullReceipt(input, changedPaths, testFiles, matchedRules, [
        "unexpected-empty-test-selection",
      ]),
      options,
    );
  }

  const receipt: CiImpactReceipt = {
    schemaVersion: "aih-ci-impact-v2",
    selectorVersion: CI_SELECTOR_VERSION,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedPaths,
    matchedRules: sortedUnique(matchedRules),
    selectedTests: sortedUnique([...selectedTests]),
    operatingSystems: crossPlatform ? [...ALL_OPERATING_SYSTEMS] : ["ubuntu-latest"],
    riskClass: docsOnly ? "docs" : crossPlatform ? "cross-platform" : "focused",
    testLane: docsOnly ? "docs" : scopedTestLane(changedPaths, [...selectedTests]),
    fullSuite: false,
    releasePreparation: changedPaths.some((path) => RELEASE_PREPARATION_SIGNAL_PATHS.has(path)),
    fallbackReasons: [],
    affectedProviders: providerIds,
    providerTests,
  };
  return validateCiImpactReceipt(receipt, options);
}

export function validateCiImpactReceipt(
  value: CiImpactReceipt,
  options: CiImpactValidationOptions = {},
): CiImpactReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid CI receipt");
  }
  const expectedKeys = [
    "affectedProviders",
    "baseSha",
    "changedPaths",
    "fallbackReasons",
    "fullSuite",
    "headSha",
    "matchedRules",
    "operatingSystems",
    "providerTests",
    "releasePreparation",
    "riskClass",
    "schemaVersion",
    "selectedTests",
    "selectorVersion",
    "testLane",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("CI receipt fields do not match the schema");
  }
  if (value.schemaVersion !== "aih-ci-impact-v2") throw new Error("invalid CI receipt schema");
  if (value.selectorVersion !== CI_SELECTOR_VERSION) throw new Error("unknown selector version");
  if (!SHA.test(value.baseSha) || !SHA.test(value.headSha))
    throw new Error("invalid CI receipt SHA");
  if (value.baseSha === value.headSha && !options.allowIdenticalRevisions)
    throw new Error("CI receipt base and head SHA must differ");

  for (const [name, paths] of [
    ["changed paths", value.changedPaths],
    ["selected tests", value.selectedTests],
  ] as const) {
    if (!Array.isArray(paths) || paths.some((path) => !isSafeRepositoryPath(path))) {
      throw new Error(`invalid ${name}`);
    }
    if (JSON.stringify(paths) !== JSON.stringify(sortedUnique(paths))) {
      throw new Error(`${name} must be sorted and unique`);
    }
  }
  if (
    value.selectedTests.some((path) => !path.startsWith("tests/") || !path.endsWith(".test.ts"))
  ) {
    throw new Error("selected tests must be repository test files");
  }
  if (
    !Array.isArray(value.affectedProviders) ||
    value.affectedProviders.length > 0 ||
    JSON.stringify(value.affectedProviders) !==
      JSON.stringify(sortedUnique(value.affectedProviders))
  ) {
    throw new Error("affected providers must be known, sorted, and unique");
  }
  const expectedProviders: string[] = [];
  if (JSON.stringify(value.affectedProviders) !== JSON.stringify(expectedProviders)) {
    throw new Error("affected providers do not match changed paths");
  }
  const expectedProviderTests: string[] = [];
  if (
    !Array.isArray(value.providerTests) ||
    JSON.stringify(value.providerTests) !== JSON.stringify(expectedProviderTests)
  ) {
    throw new Error("provider tests do not match provider ownership");
  }
  for (const [name, values] of [
    ["matched rules", value.matchedRules],
    ["fallback reasons", value.fallbackReasons],
  ] as const) {
    if (
      !Array.isArray(values) ||
      values.some(
        (entry) => typeof entry !== "string" || entry.length === 0 || /[\0\r\n]/u.test(entry),
      ) ||
      JSON.stringify(values) !== JSON.stringify(sortedUnique(values))
    ) {
      throw new Error(`${name} must be safe, sorted, and unique`);
    }
  }
  if (!["docs", "focused", "cross-platform", "full"].includes(value.riskClass)) {
    throw new Error("invalid CI risk class");
  }
  if (!["docs", "core", "workbench", "both", "full"].includes(value.testLane)) {
    throw new Error("invalid CI test lane");
  }
  const expectedTestLane = value.fullSuite
    ? "full"
    : value.riskClass === "docs"
      ? "docs"
      : scopedTestLane(value.changedPaths, value.selectedTests);
  if (value.testLane !== expectedTestLane)
    throw new Error("CI test lane does not match changed paths");
  if (!Array.isArray(value.operatingSystems)) throw new Error("invalid CI operating systems");
  if (
    typeof value.releasePreparation !== "boolean" ||
    value.releasePreparation !==
      value.changedPaths.some((path) => RELEASE_PREPARATION_SIGNAL_PATHS.has(path))
  ) {
    throw new Error("CI release preparation signal does not match changed paths");
  }
  const expectedOperatingSystems =
    value.riskClass === "full" || value.riskClass === "cross-platform"
      ? ALL_OPERATING_SYSTEMS
      : ["ubuntu-latest"];
  if (JSON.stringify(value.operatingSystems) !== JSON.stringify(expectedOperatingSystems)) {
    throw new Error("CI operating systems do not match the risk class");
  }

  if (value.fullSuite) {
    if (value.riskClass !== "full" || value.fallbackReasons.length === 0) {
      throw new Error("full-suite CI receipt must name its fallback");
    }
    if (JSON.stringify(value.operatingSystems) !== JSON.stringify(ALL_OPERATING_SYSTEMS)) {
      throw new Error("full-suite CI receipt must retain every operating system");
    }
  } else if (value.riskClass === "full" || value.fallbackReasons.length > 0) {
    throw new Error("scoped CI receipt cannot claim a full-suite fallback");
  }

  if (value.riskClass === "docs" && value.changedPaths.some((path) => !isDocumentation(path))) {
    throw new Error("documentation receipt contains a non-documentation path");
  }

  for (const path of value.changedPaths) {
    const domain = domainOf(path, "src");
    if (
      domain === undefined ||
      value.fullSuite ||
      path.startsWith("src/catalog-package/") ||
      path === "src/org-policy/catalog.ts"
    )
      continue;
    if (!value.selectedTests.some((test) => testsForDomain(domain, [test]).length > 0)) {
      throw new Error(`selected tests do not cover source domain ${domain}`);
    }
  }

  return value;
}
