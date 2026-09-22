#!/usr/bin/env node
/**
 * Contract checks for `.github/workflows/sibling-compatibility.yml`.
 *
 * `checks` runs INSIDE a disposable consumer that has `@aihq/core`, `@aihq/scan`
 * and `@aihq/catalog` installed from tarballs. The workflow copies this file into
 * that consumer first, so every import below resolves the INSTALLED packages by
 * their published names and subpaths: no checkout path, no `dist/` deep import,
 * and no `aih` command against any repository. Each check is reported by id with
 * `passed`, `failed` or `unavailable` and a reason; nothing is ever inferred as
 * passing because an export was absent.
 *
 * `resolve` reads the npm dist-tags ONCE per run and writes `baseline.json`: the
 * `latest` and `next` version and registry integrity of each package, and the
 * combinations those tags make runnable. "Current Core" is whatever `@aihq/core`
 * `latest` names at that moment: a test snapshot, never a dependency pin.
 *
 * `leg --kind registry --combination <id>` installs exactly the trio that
 * `baseline.json` names for that combination; it never re-resolves a tag:
 *
 *   baseline           core@latest + scan@latest + catalog@latest
 *   scan-candidate     core@latest + scan@next   + catalog@latest  (promotable for scan)
 *   catalog-candidate  core@latest + scan@latest + catalog@next    (promotable for catalog)
 *   core-candidate     core@next   + scan@latest + catalog@latest  (recorded for core)
 *   all-next           each at next, or latest without next; integration evidence only
 *   branch             packed checkouts (`leg --kind branch`); never promotable
 *
 * `summarize` merges the leg reports into `core-sibling-compatibility.json`
 * version 2. Only a `<package>-candidate` report becomes a `candidates` entry, and it
 * names the one package at `next` and the other two at `latest`. Check results are
 * recorded, not gating: the Scan and Catalog promotion readers gate on them.
 *
 * A recorded hash answers what was tested. It never answers what a consumer may
 * install, and it is not authorization to promote anything.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMPATIBILITY_FORMAT = "core-sibling-compatibility";
export const COMPATIBILITY_VERSION = 2;
export const BASELINE_FORMAT = "core-sibling-compatibility-baseline";
export const BASELINE_VERSION = 1;
export const PACKAGES = ["@aihq/core", "@aihq/scan", "@aihq/catalog"];

/** Every combination id, in the order the artifact and the run summary list them. */
export const COMBINATIONS = [
  "baseline",
  "scan-candidate",
  "catalog-candidate",
  "core-candidate",
  "all-next",
  "branch",
];
/** The candidate combinations and the one package each may promote. */
const CANDIDATE_PACKAGE = {
  "scan-candidate": "@aihq/scan",
  "catalog-candidate": "@aihq/catalog",
  "core-candidate": "@aihq/core",
};

/** Every check `runContractChecks` emits, in the order it emits them. */
export const CONTRACT_CHECK_IDS = [
  "catalog-readers",
  "catalog-subject-digests",
  "scan-organization-evidence-schema-lock",
  "scan-decision-schema-lock",
  "catalog-decision-schema-lock",
  "catalog-qualification-receipt-schema-lock",
  "supported-clis-shape",
  "refusal-input-unknown-version",
  "refusal-evidence-unknown-version",
  "refusal-scan-core-contract-unknown",
  "refusal-catalog-index-unknown-version",
  "scan-custody-negative",
];

/**
 * The checks each sibling's promotion reader requires, all `passed`, in its own
 * candidate combination: its own package's checks plus Core's. Recorded here so the
 * run summary and CONTRACTS.md name the same lists; the readers own the gate.
 */
export const READER_REQUIRED_CHECKS = {
  "@aihq/scan": [
    "scan-organization-evidence-schema-lock",
    "scan-decision-schema-lock",
    "scan-custody-negative",
    "supported-clis-shape",
    "refusal-input-unknown-version",
    "refusal-evidence-unknown-version",
    "refusal-scan-core-contract-unknown",
  ],
  "@aihq/catalog": [
    "catalog-readers",
    "catalog-subject-digests",
    "catalog-decision-schema-lock",
    "catalog-qualification-receipt-schema-lock",
    "supported-clis-shape",
    "refusal-input-unknown-version",
    "refusal-catalog-index-unknown-version",
  ],
};

const HEX64 = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const CHECK_STATUS = new Set(["passed", "failed", "unavailable"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Runs one check; a throw is a failure with its message, never a pass. */
async function check(id, body) {
  try {
    const outcome = await body();
    if (outcome === true) return { id, status: "passed" };
    if (typeof outcome === "string") return { id, status: "unavailable", detail: outcome };
    return { id, status: "failed", detail: "the check returned a negative result" };
  } catch (error) {
    return { id, status: "failed", detail: String(error?.message ?? error).slice(0, 300) };
  }
}

function fail(message) {
  throw new Error(message);
}

/**
 * The contract checks, over already-imported package namespaces. `readSubpath`
 * returns the bytes behind a published subpath such as
 * `@aihq/core/schemas/aih-governance-decision-v2.schema.json`, or throws.
 */
export async function runContractChecks({ core, scan, catalog, readSubpath }) {
  const results = [];
  const schemaDigest = (name) => sha256(readSubpath(`@aihq/core/schemas/${name}`));
  const accepted = Array.isArray(core.ACCEPTED_DECISION_SCHEMA_DIGESTS_V2)
    ? core.ACCEPTED_DECISION_SCHEMA_DIGESTS_V2
    : undefined;
  const decisionDigestAccepted = (digest) =>
    accepted === undefined
      ? digest === schemaDigest("aih-governance-decision-v2.schema.json")
      : accepted.includes(digest);

  // 1. Catalog readers, through the installed readers and published subpaths.
  results.push(
    await check("catalog-readers", () => {
      for (const name of [
        "readCatalogContentV1",
        "readCatalogCollectionsV1",
        "readCatalogPresentationV1",
      ])
        if (typeof catalog[name] !== "function") return `@aihq/catalog does not export ${name}`;
      const index = catalog.readCatalogContentV1({
        bytes: readSubpath("@aihq/catalog/catalog-index.json"),
      });
      if (index?.format !== catalog.CATALOG_CONTENT_FORMAT_V1) fail("catalog index refused");
      if (index.version !== catalog.CATALOG_CONTENT_VERSION_V1) fail("catalog index version");
      const collections = catalog.readCatalogCollectionsV1({
        bytes: readSubpath("@aihq/catalog/catalog-collections.json"),
        index,
      });
      if (collections?.format !== catalog.CATALOG_COLLECTIONS_FORMAT_V1)
        fail("catalog collections refused");
      const presentation = catalog.readCatalogPresentationV1({
        bytes: readSubpath("@aihq/catalog/catalog-presentation.json"),
        index,
      });
      if (presentation?.format !== catalog.CATALOG_PRESENTATION_FORMAT_V1)
        fail("catalog presentation refused");
      return true;
    }),
  );

  // 2. Every catalog subject digest recomputes under the installed Core.
  results.push(
    await check("catalog-subject-digests", () => {
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          readSubpath("@aihq/catalog/catalog-index.json"),
        );
      } catch (error) {
        return `the catalog index subpath is unavailable: ${error?.code ?? "unreadable"}`;
      }
      const index = JSON.parse(text);
      if (!Array.isArray(index?.entries) || index.entries.length === 0) fail("no entries");
      for (const entry of index.entries) {
        const subject = entry.subject;
        const sourceDigest = core.governanceDecisionSourceDigestV2(subject.source);
        if (sourceDigest !== subject.sourceDigest) fail(`${entry.entryId}: source digest`);
        const subjectDigest = core.governanceDecisionSubjectDigestV2({
          kind: subject.kind,
          id: subject.id,
          sourceDigest,
        });
        if (subjectDigest !== subject.subjectDigest) fail(`${entry.entryId}: subject digest`);
      }
      return true;
    }),
  );

  // 3. Both schema locks, asserted against the installed Core's shipped schemas.
  results.push(
    await check("scan-organization-evidence-schema-lock", () => {
      const pinned = scan.AI_HARNESS_ORGANIZATION_EVIDENCE_ENVELOPE_V1_SCHEMA_SHA256;
      if (typeof pinned !== "string") return "@aihq/scan exports no envelope schema pin";
      return pinned === schemaDigest("aih-organization-evidence-envelope-v1.schema.json");
    }),
    await check("scan-decision-schema-lock", () => {
      const emitted = scan.AI_HARNESS_DECISION_V2_SCHEMA_SHA256;
      if (typeof emitted !== "string") return "@aihq/scan exports no decision schema pin";
      return HEX64.test(emitted) && decisionDigestAccepted(emitted);
    }),
    await check("catalog-decision-schema-lock", () => {
      const lock = catalog.STRICT_V2_CORE_LOCK;
      if (typeof lock?.schemaSha256 !== "string") return "@aihq/catalog exports no Core lock";
      return decisionDigestAccepted(lock.schemaSha256);
    }),
    await check("catalog-qualification-receipt-schema-lock", () => {
      const lock = catalog.STRICT_V2_CORE_LOCK;
      if (typeof lock?.receiptSchemaSha256 !== "string")
        return "@aihq/catalog exports no Core lock";
      return (
        lock.receiptSchemaSha256 === schemaDigest("aih-supported-qualification-receipt-v2.schema.json")
      );
    }),
  );

  // 4. SUPPORTED_CLIS keeps the shape consumers validate.
  results.push(
    await check("supported-clis-shape", () => {
      const clis = core.SUPPORTED_CLIS;
      if (clis === undefined) return "@aihq/core exports no SUPPORTED_CLIS";
      return (
        Array.isArray(clis) &&
        clis.length > 0 &&
        new Set(clis).size === clis.length &&
        clis.every((id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(id))
      );
    }),
  );

  // 5. The refusal matrix, asserted by code and never by message text.
  results.push(...(await refusalMatrix(core, catalog, readSubpath)));

  // 6. Scan's projection refuses anything it did not mint.
  results.push(
    await check("scan-custody-negative", () => {
      if (typeof scan.coreOrganizationEvidenceEnvelopeDigestV1 !== "function")
        return "@aihq/scan exports no coreOrganizationEvidenceEnvelopeDigestV1";
      try {
        scan.coreOrganizationEvidenceEnvelopeDigestV1({});
      } catch (error) {
        return /custody/u.test(String(error?.message));
      }
      return false;
    }),
  );
  return results;
}

async function refusalMatrix(core, catalog, readSubpath) {
  const now = "2026-01-01T00:30:00.000Z";
  const source = {
    type: "github",
    repository: "example-org/compatibility-probe",
    commit: "0".repeat(40),
    path: "SKILL.md",
  };
  const subjectOf = () => {
    const sourceDigest = core.governanceDecisionSourceDigestV2(source);
    return core.governanceDecisionSubjectDigestV2({
      kind: "agent",
      id: "compatibility-probe",
      sourceDigest,
    });
  };
  const envelope = (kind) => ({
    format: "aih-organization-evidence",
    version: 1,
    subjectDigest: subjectOf(),
    evidence: {
      kind,
      id: kind === "scan-attestation-v2" ? "scanner-evidence-v2" : "compatibility-probe",
      summary: "Fictional compatibility probe; not evidence about any real subject.",
      payloadDigest: `sha256:${"b".repeat(64)}`,
      artifactDigests: [`sha256:${"c".repeat(64)}`],
    },
    attestor: "compatibility-probe",
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
  });
  /** Prepares, saves the evidence (optionally replaced) and consumes in a throwaway root. */
  const consumeWith = async (kind, options = {}) => {
    const evidenceBytes = new TextEncoder().encode(
      core.canonicalOrganizationEvidenceEnvelopeV1(envelope(kind)),
    );
    const prepared = core.prepareGovernanceInputV1({
      route: "organization",
      subject: { kind: "agent", id: "compatibility-probe", source },
      request: { target: core.SUPPORTED_CLIS[0], effect: "observe" },
      decisionReference: {
        id: "decision-compatibility-probe",
        digest: `sha256:${"1".repeat(64)}`,
      },
      evidenceBytes,
    });
    const artifacts = prepared.artifacts ?? fail(`prepare refused: ${prepared.status?.reason}`);
    const root = mkdtempSync(join(tmpdir(), "aih-compatibility-"));
    try {
      const target = join(root, artifacts.evidence.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, options.evidence?.(artifacts.evidence.bytes) ?? artifacts.evidence.bytes);
      return await core.consumeGovernanceInputV1({
        bytes: artifacts.input.bytes,
        root,
        env: {},
        now,
        ...(options.scan === undefined ? {} : { scan: options.scan }),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const reasonIs = (result, code) =>
    result?.status?.reason === code || fail(`refused as ${result?.status?.reason}, not ${code}`);

  return [
    await check("refusal-input-unknown-version", async () => {
      const root = mkdtempSync(join(tmpdir(), "aih-compatibility-"));
      try {
        const result = await core.consumeGovernanceInputV1({
          bytes: new TextEncoder().encode('{"format":"aih-governance-input","version":2}'),
          root,
          env: {},
          now,
        });
        return reasonIs(result, "unknown-contract-version");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
    await check("refusal-evidence-unknown-version", async () =>
      reasonIs(
        await consumeWith("compatibility-probe", {
          evidence: (bytes) =>
            new TextEncoder().encode(
              new TextDecoder().decode(bytes).replace('"version":1', '"version":2'),
            ),
        }),
        "unknown-contract-version",
      ),
    ),
    await check("refusal-scan-core-contract-unknown", async () =>
      reasonIs(
        await consumeWith("scan-attestation-v2", {
          scan: {
            // A stub that "verifies" and declares a Core contract no Core ships.
            adapter: {
              verifyScanAttestationV2: () => ({
                facts: {
                  coreContract: { commit: "0".repeat(40), decisionSchemaSha256: "f".repeat(64) },
                },
              }),
              projectVerifiedScanAttestationToCoreEvidenceEnvelopeV1: () => fail("not reached"),
              canonicalCoreOrganizationEvidenceEnvelopeV1Bytes: () => fail("not reached"),
            },
            request: { envelope: {}, candidate: {}, roots: [], expected: {}, annexArtifacts: [] },
          },
        }),
        "scan-core-contract-unknown",
      ),
    ),
    await check("refusal-catalog-index-unknown-version", () => {
      if (typeof catalog.readCatalogContentV1 !== "function")
        return "@aihq/catalog does not export readCatalogContentV1";
      const index = JSON.parse(
        new TextDecoder().decode(readSubpath("@aihq/catalog/catalog-index.json")),
      );
      const mutated = new TextEncoder().encode(JSON.stringify({ ...index, version: 2 }));
      return catalog.readCatalogContentV1({ bytes: mutated }) === undefined;
    }),
  ];
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;

/** One `latest` / `next` entry of `baseline.json`: absent is `null`, never a guess. */
function validateTagEntry(entry, where) {
  if (entry === null) return;
  if (!isObject(entry)) fail(`${where}: not an object`);
  if (!VERSION.test(entry.version ?? "")) fail(`${where}: version`);
  if (!INTEGRITY.test(entry.tarballIntegrity ?? "")) fail(`${where}: tarballIntegrity`);
}

/**
 * The combinations a set of dist-tags makes runnable. A candidate needs its package
 * at `next` and the other two at `latest`; `all-next` needs at least two packages at
 * `next` and a `latest` for any package without one. `branch` is never registry-run.
 */
export function planCombinations(packages) {
  const has = (name, tag) => isObject(packages?.[name]?.[tag]);
  const withNext = PACKAGES.filter((name) => has(name, "next"));
  const ids = [];
  if (PACKAGES.every((name) => has(name, "latest"))) ids.push("baseline");
  for (const [id, candidate] of Object.entries(CANDIDATE_PACKAGE))
    if (
      has(candidate, "next") &&
      PACKAGES.every((name) => name === candidate || has(name, "latest"))
    )
      ids.push(id);
  if (withNext.length >= 2 && PACKAGES.every((name) => has(name, "next") || has(name, "latest")))
    ids.push("all-next");
  return ids;
}

/** Validates `baseline.json` as `resolve` writes it; its combinations must follow from its tags. */
export function validateBaseline(baseline) {
  if (!isObject(baseline)) fail("baseline.json is not an object");
  if (baseline.format !== BASELINE_FORMAT || baseline.version !== BASELINE_VERSION)
    fail("baseline.json declares an unknown format or version");
  if (!ISO_INSTANT.test(baseline.resolvedAt ?? "")) fail("baseline.json: resolvedAt");
  if (!isObject(baseline.packages)) fail("baseline.json: packages");
  if (Object.keys(baseline.packages).sort().join() !== [...PACKAGES].sort().join())
    fail("baseline.json must name exactly @aihq/core, @aihq/scan and @aihq/catalog");
  for (const name of PACKAGES) {
    const tags = baseline.packages[name];
    if (!isObject(tags) || Object.keys(tags).sort().join() !== "latest,next")
      fail(`baseline.json: ${name} must record latest and next`);
    validateTagEntry(tags.latest, `${name}@latest`);
    validateTagEntry(tags.next, `${name}@next`);
  }
  if (
    !Array.isArray(baseline.combinations) ||
    baseline.combinations.join() !== planCombinations(baseline.packages).join()
  )
    fail("baseline.json: combinations do not follow from its dist-tags");
  return baseline;
}

/**
 * The trio one registry combination installs, in package order, from `baseline.json`
 * alone: `{package, version, distTag, role, tarballIntegrity}`.
 */
export function selectTrio(baseline, combination) {
  validateBaseline(baseline);
  if (combination === "branch" || !COMBINATIONS.includes(combination))
    fail(`${combination} is not a registry combination`);
  if (!baseline.combinations.includes(combination))
    fail(`${combination} is not runnable in this baseline`);
  const candidate = CANDIDATE_PACKAGE[combination];
  return PACKAGES.map((name) => {
    const tags = baseline.packages[name];
    let distTag = "latest";
    let role = "baseline";
    if (combination === "all-next") {
      distTag = tags.next === null ? "latest" : "next";
      role = "all-next";
    } else if (name === candidate) {
      distTag = "next";
      role = "candidate";
    }
    const { version, tarballIntegrity } = tags[distTag];
    return { package: name, version, distTag, role, tarballIntegrity };
  });
}

/** The role and dist-tag each package must carry in a report of this combination. */
function validateRoles(report) {
  const { combination, packages } = report;
  if (combination === "branch") {
    for (const entry of packages)
      if (entry.role !== "branch" || entry.distTag !== undefined)
        fail(`${entry.package}: a branch report carries role branch and no dist-tag`);
    return;
  }
  if (combination === "all-next") {
    for (const entry of packages)
      if (entry.role !== "all-next" || !["latest", "next"].includes(entry.distTag))
        fail(`${entry.package}: an all-next report carries role all-next`);
    if (packages.filter((entry) => entry.distTag === "next").length < 2)
      fail("an all-next report needs at least two packages at next");
    return;
  }
  const candidate = CANDIDATE_PACKAGE[combination];
  for (const entry of packages) {
    if (entry.package === candidate) {
      if (entry.role !== "candidate" || entry.distTag !== "next")
        fail(`${entry.package}: the candidate of ${combination} must be at next`);
    } else if (entry.role !== "baseline" || entry.distTag !== "latest")
      fail(`${entry.package}: every baseline package of ${combination} must be at latest`);
  }
}

/** Validates one leg report before it can reach the artifact. */
export function validateLegReport(report) {
  if (!isObject(report)) fail("leg report is not an object");
  if (!["branch", "registry"].includes(report.leg)) fail(`unknown leg ${report.leg}`);
  if (!COMBINATIONS.includes(report.combination)) fail(`unknown combination ${report.combination}`);
  if ((report.leg === "branch") !== (report.combination === "branch"))
    fail(`a ${report.leg} leg cannot report combination ${report.combination}`);
  if (report.status !== "tested") fail(`unknown status ${report.status}`);
  if (!nonEmpty(report.os) || !nonEmpty(report.node)) fail("a leg must record its os and node");
  if (report.npm !== undefined && !VERSION.test(report.npm)) fail("npm version");
  if (!Array.isArray(report.packages) || report.packages.length !== PACKAGES.length)
    fail("a leg must record exactly three packages");
  for (const entry of report.packages) {
    if (!isObject(entry) || !PACKAGES.includes(entry.package))
      fail(`unknown package ${entry?.package}`);
    if (!VERSION.test(entry.version ?? "")) fail(`${entry.package}: version`);
    if (!HEX64.test(entry.tarballSha256 ?? "")) fail(`${entry.package}: tarballSha256`);
    if (!INTEGRITY.test(entry.tarballIntegrity ?? "")) fail(`${entry.package}: tarballIntegrity`);
  }
  if (new Set(report.packages.map((entry) => entry.package)).size !== PACKAGES.length)
    fail("a leg must name each package once");
  validateRoles(report);
  if (!HEX64.test(report.lockfileSha256 ?? "")) fail("lockfileSha256");
  if (
    !Array.isArray(report.contractChecks) ||
    report.contractChecks.map((result) => result?.id).join() !== CONTRACT_CHECK_IDS.join()
  )
    fail("a tested leg must record every contract check, in the producer's order");
  for (const result of report.contractChecks)
    if (!CHECK_STATUS.has(result.status)) fail(`malformed contract check ${result.id}`);
  return report;
}

const bytesOf = ({ version, tarballSha256, tarballIntegrity }) => ({
  version,
  tarballSha256,
  tarballIntegrity,
});

/**
 * Builds the version-2 artifact. Only a tested `<package>-candidate` report becomes a
 * `candidates` entry; `baseline`, `all-next` and `branch` reports are observations
 * only. Every registry report must have installed exactly the bytes `baseline.json`
 * names, and each combination is reported at most once (branch: once per OS and Node).
 */
export function buildCompatibilityArtifact({ runId, runAttempt, core, baseline, reports }) {
  if (!/^[1-9]\d{0,19}$/u.test(String(runId))) fail("runId");
  if (!/^[1-9]\d{0,3}$/u.test(String(runAttempt))) fail("runAttempt");
  validateBaseline(baseline);
  const validated = reports.map(validateLegReport);
  const seen = new Set();
  const packedBytes = new Map();
  for (const report of validated) {
    const key =
      report.combination === "branch"
        ? `branch (${report.os}, node ${report.node})`
        : report.combination;
    if (seen.has(key)) fail(`more than one report for ${key}`);
    seen.add(key);
    if (report.leg !== "registry") continue;
    const expected = selectTrio(baseline, report.combination);
    for (const [index, entry] of report.packages.entries()) {
      const want = expected[index];
      if (
        entry.package !== want.package ||
        entry.version !== want.version ||
        entry.distTag !== want.distTag ||
        entry.tarballIntegrity !== want.tarballIntegrity
      )
        fail(`${report.combination}: ${entry.package} is not the bytes baseline.json names`);
      const tagged = `${entry.package}@${entry.distTag}`;
      if (packedBytes.has(tagged) && packedBytes.get(tagged) !== entry.tarballSha256)
        fail(`${tagged}: two combinations packed different bytes`);
      packedBytes.set(tagged, entry.tarballSha256);
    }
  }
  const candidates = [];
  for (const [combination, name] of Object.entries(CANDIDATE_PACKAGE)) {
    const report = validated.find((item) => item.combination === combination);
    if (report === undefined) continue;
    const candidate = report.packages.find((entry) => entry.package === name);
    candidates.push({
      combination,
      candidate: {
        package: name,
        version: candidate.version,
        distTag: "next",
        tarballSha256: candidate.tarballSha256,
        tarballIntegrity: candidate.tarballIntegrity,
      },
      baseline: report.packages
        .filter((entry) => entry.package !== name)
        .map((entry) => ({ package: entry.package, distTag: "latest", ...bytesOf(entry) })),
      environment: {
        os: report.os,
        node: report.node,
        ...(report.npm === undefined ? {} : { npm: report.npm }),
      },
      lockfileSha256: report.lockfileSha256,
      contractChecks: report.contractChecks.map(({ id, status }) => ({ id, status })),
    });
  }
  const resolved = Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      Object.fromEntries(
        ["latest", "next"].map((tag) => {
          const entry = baseline.packages[name][tag];
          return [
            tag,
            entry === null
              ? null
              : {
                  version: entry.version,
                  // null only when no combination in this run packed these bytes.
                  tarballSha256: packedBytes.get(`${name}@${tag}`) ?? null,
                  tarballIntegrity: entry.tarballIntegrity,
                },
          ];
        }),
      ),
    ]),
  );
  return {
    format: COMPATIBILITY_FORMAT,
    version: COMPATIBILITY_VERSION,
    runId: String(runId),
    runAttempt: String(runAttempt),
    core,
    resolvedAt: baseline.resolvedAt,
    baseline: resolved,
    candidates,
    observations: validated,
    limitation:
      "Evidence of what was tested, not authorization and not a dependency pin. A candidate is promotable only for the exact bytes it names, against the exact baseline it names.",
  };
}

/** The markdown the summary job appends to `$GITHUB_STEP_SUMMARY`. */
export function renderStepSummary(artifact, baseline) {
  const cell = (entry) => {
    if (entry === undefined) return "-";
    const where = entry.distTag ?? `git ${String(entry.source?.commit ?? "").slice(0, 12)}`;
    return `${entry.version} (${where})`;
  };
  const notPassed = (report) => {
    const list = report.contractChecks.filter((check) => check.status !== "passed");
    return list.length === 0
      ? "none"
      : list.map((check) => `\`${check.id}\` (${check.status})`).join(", ");
  };
  const row = (label, report) => {
    const byName = (name) => report.packages.find((entry) => entry.package === name);
    const trio = PACKAGES.map((name) => cell(byName(name))).join(" | ");
    return `| ${label} | tested | ${trio} | ${notPassed(report)} |`;
  };
  const currentCore = baseline.packages["@aihq/core"].latest;
  const promotable = artifact.candidates.map(
    (entry) => `\`${entry.candidate.package}@${entry.candidate.version}\``,
  );
  const lines = [
    `## Core sibling compatibility, run ${artifact.runId} attempt ${artifact.runAttempt}`,
    "",
    `Resolved ${artifact.resolvedAt}; current Core: ${
      currentCore === null
        ? "none (`@aihq/core` has no `latest`)"
        : `\`@aihq/core@${currentCore.version}\``
    }.`,
    "Check results are recorded here, not gating: the Scan and Catalog promotion readers gate on their own candidate combination.",
    "",
  ];
  if (baseline.combinations.length === 0)
    lines.push("No registry combination was runnable from the resolved dist-tags.", "");
  lines.push(
    "| Combination | Result | @aihq/core | @aihq/scan | @aihq/catalog | Checks not passed |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const combination of baseline.combinations) {
    const report = artifact.observations.find((item) => item.combination === combination);
    lines.push(
      report === undefined
        ? `| ${combination} | no report: its job could not obtain, install or run the trio | - | - | - | - |`
        : row(combination, report),
    );
  }
  for (const report of artifact.observations.filter((item) => item.combination === "branch"))
    lines.push(row(`branch (${report.os}, node ${report.node})`, report));
  lines.push(
    "",
    `Candidate combinations recorded in this artifact: ${promotable.length === 0 ? "none" : promotable.join(", ")}.`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

/** npm through its own CLI entry, with an EMPTY userconfig: no ambient .npmrc applies. */
function npmRunner(userconfig) {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate.endsWith(".js"));
  const cli = candidates.find((candidate) => existsSync(candidate)) ?? fail("npm-cli.js not found");
  return (args, cwd) => {
    const result = spawnSync(process.execPath, [cli, ...args, "--userconfig", userconfig], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0)
      fail(`npm ${args[0]} failed: ${(result.stderr || result.stdout || "").slice(-2000)}`);
    return result.stdout;
  };
}

function gitCommit(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commit = result.stdout?.trim() ?? "";
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) fail(`${directory}: no git commit`);
  return commit;
}

function packed(npm, args, cwd, destination, expectedName) {
  const [result] = JSON.parse(
    npm(["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", destination], cwd),
  );
  if (result?.name !== expectedName) fail(`packed ${result?.name}, expected ${expectedName}`);
  if (!INTEGRITY.test(result.integrity ?? "")) fail(`${expectedName}: npm reported no integrity`);
  const tarball = join(destination, basename(result.filename));
  return {
    package: result.name,
    version: result.version,
    tarball,
    tarballSha256: sha256(readFileSync(tarball)),
    tarballIntegrity: result.integrity,
  };
}

/** A throwaway work directory with an empty userconfig, and npm bound to it. */
function workspace(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const userconfig = join(work, "empty-npmrc");
  writeFileSync(userconfig, "");
  return { work, npm: npmRunner(userconfig) };
}

const viewJson = (npm, work, args) => JSON.parse(npm(["view", ...args, "--json"], work));

/**
 * Reads each package's `latest` and `next` from the registry ONCE, with their
 * registry integrity, and writes `baseline.json`. Read-only: `npm view` only.
 */
export function resolveBaseline({ out }) {
  const { work, npm } = workspace("aih-sibling-resolve-");
  try {
    const resolvedAt = new Date().toISOString();
    const packages = {};
    for (const name of PACKAGES) {
      const tags = viewJson(npm, work, [name, "dist-tags"]);
      if (!isObject(tags)) fail(`${name}: the registry returned no dist-tags`);
      packages[name] = {};
      for (const tag of ["latest", "next"]) {
        const version = tags[tag];
        if (version === undefined) {
          packages[name][tag] = null;
          continue;
        }
        if (!VERSION.test(String(version))) fail(`${name}@${tag}: version ${version}`);
        const tarballIntegrity = viewJson(npm, work, [`${name}@${version}`, "dist.integrity"]);
        packages[name][tag] = { version, tarballIntegrity };
      }
    }
    const baseline = validateBaseline({
      format: BASELINE_FORMAT,
      version: BASELINE_VERSION,
      resolvedAt,
      packages,
      combinations: planCombinations(packages),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
    return baseline;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * One leg: obtain the three tarballs, install them into a fresh consumer with an
 * empty userconfig and scripts disabled, run the checks there, and record the
 * exact bytes. `branch` packs already-built checkouts; `registry` packs exactly the
 * trio `baseline.json` names for its combination and never re-resolves a tag.
 * It throws only when the trio could not be obtained or installed or the checks
 * did not run; check outcomes are recorded in the report, never thrown.
 */
export function runLeg({ kind, combination, baselinePath, checkouts, out, os, node }) {
  if (!["branch", "registry"].includes(kind)) fail(`unknown leg kind ${kind}`);
  const { work, npm } = workspace("aih-sibling-leg-");
  try {
    const tarballs = join(work, "tarballs");
    mkdirSync(tarballs);
    const packages = [];
    if (kind === "branch") {
      for (const name of PACKAGES) {
        const directory = resolve(checkouts[name] ?? fail(`no checkout for ${name}`));
        const {
          package: packageName,
          version,
          tarball,
          tarballSha256,
          tarballIntegrity,
        } = packed(npm, [], directory, tarballs, name);
        packages.push({
          package: packageName,
          version,
          role: "branch",
          tarballSha256,
          tarballIntegrity,
          source: { kind: "git", commit: gitCommit(directory) },
          tarball,
        });
      }
    } else {
      const baseline = validateBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
      for (const entry of selectTrio(baseline, combination)) {
        const spec = `${entry.package}@${entry.version}`;
        const result = packed(npm, [spec], work, tarballs, entry.package);
        if (result.version !== entry.version) fail(`${spec}: npm packed ${result.version}`);
        if (result.tarballIntegrity !== entry.tarballIntegrity)
          fail(`${spec}: packed bytes differ from the integrity baseline.json recorded`);
        if (viewJson(npm, work, [spec, "dist.integrity"]) !== result.tarballIntegrity)
          fail(`${spec}: packed bytes differ from the registry integrity`);
        packages.push({
          package: entry.package,
          version: entry.version,
          distTag: entry.distTag,
          role: entry.role,
          tarballSha256: result.tarballSha256,
          tarballIntegrity: result.tarballIntegrity,
          source: { kind: "registry", tag: entry.distTag },
          tarball: result.tarball,
        });
      }
    }
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "sibling-compatibility-consumer", private: true, type: "module" })}\n`,
    );
    npm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        ...packages.map((entry) => entry.tarball),
      ],
      consumer,
    );
    const self = join(consumer, "sibling-compatibility-checks.mjs");
    copyFileSync(fileURLToPath(import.meta.url), self);
    const checksFile = join(work, "checks.json");
    const run = spawnSync(process.execPath, [self, "checks", "--out", checksFile], {
      cwd: consumer,
      encoding: "utf8",
    });
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0 || !existsSync(checksFile)) fail("the consumer checks did not run");
    const report = validateLegReport({
      leg: kind,
      combination: kind === "branch" ? "branch" : combination,
      status: "tested",
      os,
      node,
      npm: npm(["--version"], work).trim(),
      packages: packages.map(({ tarball, ...entry }) => entry),
      lockfileSha256: sha256(readFileSync(join(consumer, "package-lock.json"))),
      contractChecks: JSON.parse(readFileSync(checksFile, "utf8")),
    });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Reads a published subpath of an installed package; this file sits in the consumer. */
function readSubpath(specifier) {
  return readFileSync(fileURLToPath(import.meta.resolve(specifier)));
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const option = (name) => {
    const at = rest.indexOf(name);
    const value = at < 0 ? undefined : rest[at + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing ${name}`);
    return value;
  };
  if (mode === "checks") {
    const out = option("--out");
    const load = async (name) => {
      try {
        return await import(name);
      } catch (error) {
        return fail(`${name} is not installed in this consumer: ${error?.code ?? error}`);
      }
    };
    const results = await runContractChecks({
      core: await load("@aihq/core"),
      scan: await load("@aihq/scan"),
      catalog: await load("@aihq/catalog"),
      readSubpath,
    });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`, { flag: "wx" });
    for (const result of results)
      process.stdout.write(`${result.status}: ${result.id}${result.detail ? ` - ${result.detail}` : ""}\n`);
    return;
  }
  if (mode === "resolve") {
    const baseline = resolveBaseline({ out: resolve(option("--out")) });
    // stdout carries exactly the matrix: one line of JSON, the runnable combination ids.
    process.stdout.write(`${JSON.stringify(baseline.combinations)}\n`);
    return;
  }
  if (mode === "leg") {
    const kind = option("--kind");
    const report = runLeg({
      kind,
      combination: kind === "registry" ? option("--combination") : "branch",
      baselinePath: kind === "registry" ? resolve(option("--baseline")) : undefined,
      checkouts:
        kind === "branch"
          ? {
              "@aihq/core": option("--core"),
              "@aihq/scan": option("--scan"),
              "@aihq/catalog": option("--catalog"),
            }
          : {},
      out: resolve(option("--out")),
      os: option("--os"),
      node: option("--node"),
    });
    const notPassed = report.contractChecks.filter((result) => result.status !== "passed");
    // Recorded, not gating: the readers gate. This leg exits 0 because the checks ran.
    process.stdout.write(
      `${report.combination}: ${report.status}; ${notPassed.length} check(s) not passed (recorded)\n`,
    );
    return;
  }
  if (mode === "summarize") {
    const legsDir = option("--legs");
    const baseline = validateBaseline(JSON.parse(readFileSync(option("--baseline"), "utf8")));
    // No leg directory means no job uploaded a report; the summary still says so.
    const reports = existsSync(legsDir)
      ? readdirSync(legsDir, { recursive: true })
          .filter((name) => String(name).endsWith(".leg.json"))
          .sort()
          .map((name) => JSON.parse(readFileSync(join(legsDir, String(name)), "utf8")))
      : [];
    const artifact = buildCompatibilityArtifact({
      runId: option("--run-id"),
      runAttempt: option("--run-attempt"),
      core: { repository: option("--core-repository"), commit: option("--core-commit") },
      baseline,
      reports,
    });
    const summary = renderStepSummary(artifact, baseline);
    writeFileSync(option("--out"), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    if (rest.includes("--step-summary")) appendFileSync(option("--step-summary"), summary);
    process.stdout.write(summary);
    return;
  }
  fail(
    "usage: sibling-compatibility-checks.mjs checks | resolve | leg | summarize (see the workflow)",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`refused: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
