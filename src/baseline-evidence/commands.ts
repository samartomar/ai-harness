import { resolve } from "node:path";
import { AihError } from "../errors.js";
import { writeArtifact } from "../internals/execute.js";
import {
  type Action,
  type CommandSpec,
  dynamicDigest,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import type { TrustScanResult } from "../trust/scan.js";
import { requiredBaselineVetOptions } from "./analyzer-profile.js";
import { type BaselineCatalog, defineBaselineCatalog } from "./catalog.js";
import { baselineCatalogById } from "./catalogs.js";
import { groupEccResidualReviewDecisions } from "./ecc-review-decisions.js";
import { writeVerifiedOutputManifest } from "./output-manifest.js";
import {
  type ComponentQualificationEvidence,
  ECC_LEAN_PROFILE_ID,
  ECC_UPSTREAM_FULL_PROFILE_ID,
  qualificationProfile,
  qualifyActiveProfile,
  SUPERPOWERS_STANDARD_PROFILE_ID,
} from "./profiles.js";
import {
  BASELINE_REPORTS_DIR,
  type BaselineSourceEvidence,
  parseBaselineEvidenceLock,
} from "./schema.js";
import { readVendorBaselineLock } from "./vendor.js";
import { vetBaselineCatalog } from "./vet.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

export interface BaselineVetPlanOptions {
  vetCatalog?: typeof vetBaselineCatalog;
  cleanupQuarantine?: boolean;
  profileId?: string;
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function reportPath(catalog: BaselineCatalog): string {
  return `${BASELINE_REPORTS_DIR}/${catalog.id}-${catalog.pinnedSha.slice(0, 12)}.json`;
}

function occurrenceReportPath(catalog: BaselineCatalog, profile: string): string {
  return `${BASELINE_REPORTS_DIR}/${catalog.id}-${catalog.pinnedSha.slice(0, 12)}-${profile}-occurrences.json`;
}

function outputManifestPath(catalog: BaselineCatalog, profile: string): string {
  return `${BASELINE_REPORTS_DIR}/${catalog.id}-${catalog.pinnedSha.slice(0, 12)}-${profile}-outputs.sha256`;
}

function uniqueFingerprintEntries<T extends { fingerprint: string }>(
  entries: readonly T[],
  label: string,
): T[] {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    const existing = unique.get(entry.fingerprint);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`conflicting ${label} rows share fingerprint ${entry.fingerprint}`);
    }
    unique.set(entry.fingerprint, entry);
  }
  return [...unique.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

function defaultProfileId(catalog: BaselineCatalog): string | undefined {
  if (catalog.id === "ecc") return ECC_LEAN_PROFILE_ID;
  if (catalog.id === "superpowers") return SUPERPOWERS_STANDARD_PROFILE_ID;
  return undefined;
}

async function exactSourceRoot(
  ctx: PlanContext,
  source: TrustSource,
  catalog: BaselineCatalog,
): Promise<string> {
  if (source.kind === "github") {
    const metadata = readTrustFetchMetadata(source);
    if (
      metadata.owner.toLowerCase() !== catalog.owner.toLowerCase() ||
      metadata.repo.toLowerCase() !== catalog.repo.toLowerCase() ||
      metadata.pinnedSha !== catalog.pinnedSha ||
      resolve(metadata.treePath) !== resolve(source.treePath)
    ) {
      throw new AihError(
        `fetched source does not match ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
        "AIH_TRUST",
      );
    }
    return assertTrustTreeSafe(source.treePath);
  }
  const head = await ctx.run(["git", "-C", source.root, "rev-parse", "HEAD"]);
  const actual = head.stdout.trim().toLowerCase();
  if (head.code !== 0 || actual !== catalog.pinnedSha) {
    throw new AihError(
      `local checkout is ${actual || "unreadable"}, expected pinned ${catalog.pinnedSha}`,
      "AIH_TRUST",
    );
  }
  const status = await ctx.run(["git", "-C", source.root, "status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim().length > 0) {
    throw new AihError(
      "local baseline checkout must be clean before exact-pin qualification",
      "AIH_TRUST",
    );
  }
  return assertTrustTreeSafe(source.root);
}

export async function baselineVetPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
  catalog: BaselineCatalog,
  options: BaselineVetPlanOptions = {},
): Promise<Plan> {
  const actions: Action[] = [];
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(
    dynamicDigest("baseline vet result", async (digestCtx) => {
      try {
        if (!digestCtx.apply) {
          return {
            text: `Would vet ${catalog.components.length} component(s) from ${source.display} at exact pin ${catalog.pinnedSha}; pass --apply to fetch/scan and write the report.`,
            data: {
              catalog: catalog.id,
              pinnedSha: catalog.pinnedSha,
              components: catalog.components.map((component) => component.id),
            },
          };
        }
        const sourceRoot = await exactSourceRoot(digestCtx, source, catalog);
        const vet = options.vetCatalog ?? vetBaselineCatalog;
        const scans = new Map<string, TrustScanResult>();
        const vetOptions = requiredBaselineVetOptions({
          run: digestCtx.run,
          platform: digestCtx.host.platform,
          env: digestCtx.env,
          progress: (message) => process.stderr.write(`${message}\n`),
        });
        vetOptions.onComponentScan = (component, scan) => scans.set(component.id, scan);
        let sourceWideScan: TrustScanResult | undefined;
        vetOptions.onSourceWideScan = (scan) => {
          sourceWideScan = scan;
        };
        const evidence: BaselineSourceEvidence = await vet(sourceRoot, catalog, vetOptions);
        const lock = parseBaselineEvidenceLock({ schemaVersion: 1, sources: [evidence] });
        const rel = reportPath(catalog);
        writeArtifact(digestCtx, rel, `${JSON.stringify(lock, null, 2)}\n`);
        const profileId = options.profileId ?? defaultProfileId(catalog);
        if (
          profileId !== undefined &&
          scans.size === catalog.components.length &&
          catalog.components.every((component) => scans.has(component.id))
        ) {
          const profile = qualificationProfile(catalog, profileId);
          const componentEvidence: ComponentQualificationEvidence[] = catalog.components.map(
            (component) => {
              const scan = scans.get(component.id);
              if (scan === undefined) throw new Error(`missing captured scan for ${component.id}`);
              return {
                id: component.id,
                findings: scan.normalizedFindings ?? [],
                dispositions: scan.policyDispositions ?? [],
              };
            },
          );
          const qualification = qualifyActiveProfile(catalog, profile, componentEvidence);
          const occurrenceRel = occurrenceReportPath(catalog, profile.id);
          const previousSource = readVendorBaselineLock().sources.find(
            (candidate) => candidate.id === catalog.id,
          );
          if (sourceWideScan === undefined) {
            throw new Error("baseline qualification did not retain a complete source-wide scan");
          }
          const rawOccurrenceLedger = uniqueFingerprintEntries(
            sourceWideScan.rawOccurrences ?? [],
            "raw occurrence",
          );
          const normalizedFindingLedger = uniqueFingerprintEntries(
            sourceWideScan.normalizedFindings ?? [],
            "normalized finding",
          );
          const dispositionsByFingerprint = new Map<
            string,
            NonNullable<TrustScanResult["policyDispositions"]>[number]
          >();
          for (const disposition of sourceWideScan.policyDispositions ?? []) {
            const existing = dispositionsByFingerprint.get(disposition.findingFingerprint);
            if (
              existing !== undefined &&
              JSON.stringify(existing) !== JSON.stringify(disposition)
            ) {
              throw new Error(
                `conflicting policy dispositions share fingerprint ${disposition.findingFingerprint}`,
              );
            }
            dispositionsByFingerprint.set(disposition.findingFingerprint, disposition);
          }
          const allDispositions = [...dispositionsByFingerprint.values()].sort((left, right) =>
            left.findingFingerprint.localeCompare(right.findingFingerprint),
          );
          const fullSourceDisclosure = {
            scope: "COMPLETE EXACT-PIN SOURCE",
            rawOccurrences: rawOccurrenceLedger.length,
            normalizedFindings: normalizedFindingLedger.length,
            block: allDispositions.filter((disposition) => disposition.level === "BLOCK").length,
            review: allDispositions.filter((disposition) => disposition.level === "REVIEW").length,
            warn: allDispositions.filter((disposition) => disposition.level === "WARN").length,
            informational: allDispositions.filter(
              (disposition) => disposition.level === "INFORMATIONAL",
            ).length,
            suppressed: allDispositions.filter((disposition) => disposition.level === "SUPPRESSED")
              .length,
          };
          const selectedReviewOccurrences = uniqueFingerprintEntries(
            qualification.genuineReasons
              .filter(
                (reason) =>
                  reason.level === "REVIEW" &&
                  reason.path !== undefined &&
                  reason.line !== undefined &&
                  reason.value !== undefined,
              )
              .map((reason) => ({
                fingerprint: reason.fingerprint,
                findingFingerprint: reason.fingerprint,
                path: reason.path as string,
                line: reason.line as number,
                sourceValue: reason.value as string,
              })),
            "selected review occurrence",
          ).map(({ fingerprint: _fingerprint, ...occurrence }) => occurrence);
          const groupedResidualReviewDecisions =
            catalog.id === "ecc" ? groupEccResidualReviewDecisions(selectedReviewOccurrences) : [];
          writeArtifact(
            digestCtx,
            occurrenceRel,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                source: {
                  id: catalog.id,
                  owner: catalog.owner,
                  repo: catalog.repo,
                  pinnedSha: catalog.pinnedSha,
                  integrity: "EXACT PIN VERIFIED",
                },
                activeProfile: qualification,
                fullSourceDisclosure,
                sourceOccurrenceLedger: {
                  rawOccurrences: rawOccurrenceLedger,
                  normalizedFindings: normalizedFindingLedger,
                  policyDispositions: allDispositions,
                },
                groupedResidualReviewDecisions,
                generatedArtifactConsistency: {
                  manifest: outputManifestPath(catalog, profile.id),
                  outputs: [rel, occurrenceRel],
                  verification: "recomputed after all outputs; mismatch fails the command",
                },
                detectorBugsFixedRatherThanAccepted: [
                  "prompt-injection: lexical HTTP methods, endpoint declarations, headings, code samples, and negated security guidance require actual override/exfiltration intent",
                  "auto-exec-hook: leading boolean negation expressions are not shell auto-run directives",
                  "hidden-unicode: prose typography, mathematical symbols, Chinese punctuation, emoji, and prose/comment variation selectors are not hidden-control blockers",
                ],
                acceptanceRecordsStillRequired: qualification.genuineReasons
                  .filter((reason) => reason.level === "REVIEW")
                  .map((reason) => ({
                    componentId: reason.componentId,
                    fingerprint: reason.fingerprint,
                    code: reason.code,
                    path: reason.path,
                    line: reason.line,
                    value: reason.value,
                  })),
                components: catalog.components.map((component) => {
                  const scan = scans.get(component.id);
                  const dispositions = scan?.policyDispositions ?? [];
                  const correctedVerdict = dispositions.some(
                    (disposition) => disposition.level === "BLOCK",
                  )
                    ? "BLOCK"
                    : dispositions.some((disposition) => disposition.level === "REVIEW")
                      ? "REVIEW"
                      : "PASS";
                  return {
                    id: component.id,
                    selected: profile.selectedComponentIds.includes(component.id),
                    inventoryStatus: profile.selectedComponentIds.includes(component.id)
                      ? "DISCOVERED / SELECTED / NOT INSTALLED"
                      : "DISCOVERED / NOT SELECTED / NOT AUTHORIZED / NOT INSTALLED",
                    oldVerdict:
                      previousSource?.components.find((entry) => entry.id === component.id)
                        ?.verdict ?? "not previously reported",
                    correctedVerdict,
                    analyzers:
                      evidence.components.find((entry) => entry.id === component.id)?.analyzers ??
                      [],
                    rawOccurrences: scan?.rawOccurrences ?? [],
                    normalizedFindings: scan?.normalizedFindings ?? [],
                    policyDispositions: dispositions,
                  };
                }),
              },
              null,
              2,
            )}\n`,
          );
          const manifestRel = outputManifestPath(catalog, profile.id);
          const manifestVerification = writeVerifiedOutputManifest({
            root: digestCtx.root,
            manifestPath: resolve(digestCtx.root, manifestRel),
            outputPaths: [rel, occurrenceRel],
          });
          const reasons = qualification.genuineReasons
            .filter((reason) => reason.level === "BLOCK" || reason.level === "REVIEW")
            .slice(0, 8)
            .map(
              (reason) =>
                `${reason.level} ${reason.componentId} ${reason.path ?? "(no path)"}:${reason.line ?? 1} = ${JSON.stringify(reason.value ?? reason.detail)}`,
            );
          return {
            text: [
              `source integrity: EXACT PIN VERIFIED — ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
              `active profile: ${qualification.profile}`,
              `selected components: ${qualification.selectedComponents.length}/${catalog.components.length}`,
              `component counts: pass ${qualification.componentCounts.pass}, review ${qualification.componentCounts.review}, block ${qualification.componentCounts.block}`,
              `finding counts: warn ${qualification.findingCounts.warn}, review ${qualification.findingCounts.review}, block ${qualification.findingCounts.block}`,
              `genuine reasons: ${reasons.length === 0 ? "none" : reasons.join(" | ")}`,
              `policy decision: ${qualification.policyDecision}`,
              `runtime restrictions: ${qualification.runtimeRestrictions.join("; ")}`,
              `full occurrence evidence: ${occurrenceRel}`,
              `component lock: ${rel}`,
              `output manifest: ${manifestRel} (${manifestVerification.entries.length} entries verified)`,
              "This command installed nothing.",
            ].join("\n"),
            data: {
              qualification,
              occurrenceReport: occurrenceRel,
              componentLock: rel,
              outputManifest: manifestRel,
              manifestVerified: manifestVerification.ok,
            },
          };
        }
        return {
          text: `Vetted ${catalog.components.length} component(s) from ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}; wrote ${rel}. This command installed nothing.`,
          data: lock,
        };
      } finally {
        if (options.cleanupQuarantine === true) cleanupQuarantine(source);
      }
    }),
  );
  return plan("evidence vet-baseline", ...actions);
}

function selectedCatalog(ctx: PlanContext, id: string, pin: string): BaselineCatalog {
  const base = baselineCatalogById(id, pin);
  const raw = optionString(ctx, "components");
  if (raw === undefined) return base;
  const requested = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) {
    throw new AihError("--components must name at least one component", "AIH_CONFIG");
  }
  const selected = base.components.filter((component) => requested.includes(component.id));
  const missing = requested.filter((id) => !selected.some((component) => component.id === id));
  if (missing.length > 0) {
    throw new AihError(
      `unknown ${base.id} baseline component(s): ${missing.join(", ")}`,
      "AIH_CONFIG",
    );
  }
  return defineBaselineCatalog({ ...base, components: selected });
}

async function vetBaselinePlan(ctx: PlanContext): Promise<Plan> {
  const sourceText = optionString(ctx, "source");
  const pin = optionString(ctx, "pin");
  const catalogId = optionString(ctx, "catalog");
  if (sourceText === undefined) {
    throw new AihError("evidence vet-baseline requires <source>", "AIH_CONFIG");
  }
  if (pin === undefined || !FULL_SHA.test(pin)) {
    throw new AihError("--pin must be a lowercase 40-character commit SHA", "AIH_CONFIG");
  }
  if (catalogId === undefined) {
    throw new AihError("--catalog is required (ecc|superpowers)", "AIH_CONFIG");
  }
  const catalog = selectedCatalog(ctx, catalogId, pin);
  const requestedProfile = optionString(ctx, "profile");
  const profileId =
    requestedProfile ??
    (catalog.id === "ecc" ? ECC_UPSTREAM_FULL_PROFILE_ID : SUPERPOWERS_STANDARD_PROFILE_ID);
  qualificationProfile(catalog, profileId);
  const source = resolveTrustSource(sourceText, { root: ctx.root, pin });
  if (
    source.kind === "github" &&
    (source.owner.toLowerCase() !== catalog.owner.toLowerCase() ||
      source.repo.toLowerCase() !== catalog.repo.toLowerCase())
  ) {
    cleanupQuarantine(source);
    throw new AihError(
      `--catalog ${catalog.id} requires source ${catalog.owner}/${catalog.repo}`,
      "AIH_CONFIG",
    );
  }
  return baselineVetPlanForSource(ctx, source, catalog, {
    cleanupQuarantine: true,
    profileId,
  });
}

export const vetBaselineCommand: CommandSpec = {
  name: "vet-baseline",
  summary: "Vet exact-pinned baseline components into a signable local evidence report",
  positional: {
    name: "source",
    description: "local checkout or GitHub owner/repo",
    required: true,
    optionName: "source",
  },
  options: [
    { flags: "--pin <sha>", description: "exact lowercase 40-character source commit" },
    { flags: "--catalog <id>", description: "baseline catalog: ecc|superpowers" },
    {
      flags: "--components <csv>",
      description: "optional comma-separated component IDs (default: entire catalog)",
    },
    {
      flags: "--profile <id>",
      description:
        "qualification profile (default: ecc-upstream-full-v2.1.0 or superpowers-standard-v1)",
    },
  ],
  plan: vetBaselinePlan,
};
