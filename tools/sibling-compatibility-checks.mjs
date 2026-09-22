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
 * `summarize` merges the leg reports into `core-sibling-compatibility.json`, the
 * exact shape the sibling promotion gates read:
 * `{format:"core-sibling-compatibility", version:1, runId, runAttempt,
 *   legs:[{package, version, tarballSha256, tarballIntegrity, contractChecks:[{status}]}]}`.
 * Only packages resolved from the npm `next` tag become `legs`: those are the only
 * bytes a promotion from `next` to `latest` can be about. Branch-built and `latest`
 * results are recorded under `observations` and never as a promotable leg.
 *
 * A recorded hash answers what was tested. It never answers what a consumer may
 * install, and it is not authorization to promote anything.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
export const COMPATIBILITY_VERSION = 1;
export const PACKAGES = ["@aihq/core", "@aihq/scan", "@aihq/catalog"];

const HEX64 = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const CHECK_STATUS = new Set(["passed", "failed", "unavailable"]);

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

/** Validates one leg report before it can reach the artifact. */
export function validateLegReport(report) {
  if (report === null || typeof report !== "object") fail("leg report is not an object");
  if (!["branch", "registry-latest", "registry-next"].includes(report.leg))
    fail(`unknown leg ${report.leg}`);
  if (!["tested", "tag-absent"].includes(report.status)) fail(`unknown status ${report.status}`);
  if (!Array.isArray(report.packages)) fail("packages must be an array");
  for (const entry of report.packages) {
    if (!PACKAGES.includes(entry.package)) fail(`unknown package ${entry.package}`);
    if (entry.status === "tag-absent") continue;
    if (!VERSION.test(entry.version ?? "")) fail(`${entry.package}: version`);
    if (!HEX64.test(entry.tarballSha256 ?? "")) fail(`${entry.package}: tarballSha256`);
    if (!INTEGRITY.test(entry.tarballIntegrity ?? "")) fail(`${entry.package}: tarballIntegrity`);
  }
  if (report.status === "tested") {
    if (!HEX64.test(report.lockfileSha256 ?? "")) fail("lockfileSha256");
    if (!Array.isArray(report.contractChecks) || report.contractChecks.length === 0)
      fail("a tested leg must record its contract checks");
    for (const result of report.contractChecks)
      if (typeof result?.id !== "string" || !CHECK_STATUS.has(result.status))
        fail("malformed contract check");
  }
  return report;
}

/**
 * Builds the artifact. Only a `registry-next` leg that was tested contributes
 * promotable `legs`, one per package whose version came from `next`; a package
 * the leg filled from `latest` because it has no `next` is never promotable.
 */
export function buildCompatibilityArtifact({ runId, runAttempt, core, reports }) {
  if (!/^[1-9]\d{0,19}$/u.test(String(runId))) fail("runId");
  if (!/^[1-9]\d{0,3}$/u.test(String(runAttempt))) fail("runAttempt");
  const validated = reports.map(validateLegReport);
  const next = validated.filter((report) => report.leg === "registry-next");
  if (next.length > 1) fail("more than one registry-next report");
  const legs = [];
  if (next[0]?.status === "tested") {
    for (const entry of next[0].packages) {
      if (entry.distTag !== "next") continue;
      legs.push({
        package: entry.package,
        version: entry.version,
        distTag: "next",
        tarballSha256: entry.tarballSha256,
        tarballIntegrity: entry.tarballIntegrity,
        lockfileSha256: next[0].lockfileSha256,
        contractChecks: next[0].contractChecks.map(({ id, status }) => ({ id, status })),
      });
    }
  }
  return {
    format: COMPATIBILITY_FORMAT,
    version: COMPATIBILITY_VERSION,
    runId: String(runId),
    runAttempt: String(runAttempt),
    core,
    legs,
    observations: validated,
    limitation:
      "Evidence of what was tested, not authorization and not a dependency pin. A leg is promotable only for the exact bytes it names.",
  };
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

/**
 * One leg: obtain the three tarballs, install them into a fresh consumer with an
 * empty userconfig and scripts disabled, run the checks there, and record the
 * exact bytes. `branch` packs already-built checkouts; `registry` resolves a tag.
 */
export function runLeg({ kind, tag, checkouts, out, os, node }) {
  const work = mkdtempSync(join(tmpdir(), "aih-sibling-leg-"));
  try {
    const userconfig = join(work, "empty-npmrc");
    writeFileSync(userconfig, "");
    const npm = npmRunner(userconfig);
    const tarballs = join(work, "tarballs");
    mkdirSync(tarballs);
    const leg = kind === "branch" ? "branch" : `registry-${tag}`;
    const packages = [];
    if (kind === "branch") {
      for (const name of PACKAGES) {
        const directory = resolve(checkouts[name] ?? fail(`no checkout for ${name}`));
        packages.push({
          ...packed(npm, [], directory, tarballs, name),
          source: { kind: "git", commit: gitCommit(directory) },
        });
      }
    } else {
      if (!["latest", "next"].includes(tag)) fail(`unknown tag ${tag}`);
      const resolved = PACKAGES.map((name) => {
        const tags = JSON.parse(npm(["view", name, "dist-tags", "--json"], work));
        return { name, version: tags?.[tag], latest: tags?.latest };
      });
      const absent = resolved.filter((entry) => entry.version === undefined);
      // A tag no package carries is recorded as absent, never as a failure.
      if (absent.length === resolved.length || (tag === "latest" && absent.length > 0)) {
        const report = validateLegReport({
          leg,
          status: "tag-absent",
          os,
          node,
          packages: resolved.map((entry) => ({
            package: entry.name,
            ...(entry.version === undefined ? { status: "tag-absent" } : { version: entry.version }),
            distTag: tag,
          })),
        });
        writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        return report;
      }
      for (const entry of resolved) {
        // A package without the tag is tested at `latest` so the trio exists. It is
        // recorded as `latest` and can never become a promotable `next` leg.
        const distTag = entry.version === undefined ? "latest" : tag;
        const version = entry.version ?? entry.latest ?? fail(`${entry.name} has no latest`);
        const result = packed(npm, [`${entry.name}@${version}`], work, tarballs, entry.name);
        const registryIntegrity = JSON.parse(
          npm(["view", `${entry.name}@${version}`, "dist.integrity", "--json"], work),
        );
        if (registryIntegrity !== result.tarballIntegrity)
          fail(`${entry.name}@${version}: packed bytes differ from the registry integrity`);
        packages.push({ ...result, distTag, source: { kind: "registry", tag: distTag } });
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
      leg,
      status: "tested",
      os,
      node,
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
  if (mode === "leg") {
    const kind = option("--kind");
    const report = runLeg({
      kind,
      tag: kind === "registry" ? option("--tag") : undefined,
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
    const failed = (report.contractChecks ?? []).filter((result) => result.status !== "passed");
    process.stdout.write(`${report.leg}: ${report.status}; ${failed.length} check(s) not passed\n`);
    // Every check is recorded in the report either way; a failed one still turns the job red.
    if (failed.length > 0) process.exitCode = 1;
    return;
  }
  if (mode === "summarize") {
    const legsDir = option("--legs");
    const reports = readdirSync(legsDir, { recursive: true })
      .filter((name) => String(name).endsWith(".leg.json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(legsDir, String(name)), "utf8")));
    const artifact = buildCompatibilityArtifact({
      runId: option("--run-id"),
      runAttempt: option("--run-attempt"),
      core: { repository: option("--core-repository"), commit: option("--core-commit") },
      reports,
    });
    writeFileSync(option("--out"), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(
      `${artifact.legs.length} promotable leg(s); ${artifact.observations.length} observation(s)\n`,
    );
    return;
  }
  fail("usage: sibling-compatibility-checks.mjs checks | leg | summarize (see the workflow)");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`refused: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
