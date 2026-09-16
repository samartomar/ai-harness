import { evidenceExpiryV1 } from "../../../evidence-freshness.js";
import type { CatalogBrowseFilters, CatalogBrowseOption } from "../catalog-browse.js";
import { catalogSourceDisplayName } from "../catalog-browse.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  EvidenceSummaryV1,
  WorkbenchStateV1,
} from "../contracts.js";
import type { WorkbenchReferenceReportV1 } from "../reference-reports.js";
import { resolveWorkbenchSelection } from "../selection-engine.js";
import {
  type EvidenceDisplayState,
  evidenceDisplayFor,
  qualificationDisplayFor,
} from "./evidence-display.js";

type CatalogRelationV1 = AuthoringCatalogBundleV1["relations"][number];
type SelectionTemplateV1 = AuthoringCatalogBundleV1["templates"][string];

export interface CatalogDetailFact {
  label: string;
  value: string;
}

export interface CatalogDetailPresentation {
  title: string;
  summary: string;
  facts: readonly CatalogDetailFact[];
  advancedJson: string;
}

export type CatalogAssetState =
  | "available"
  | "dependency"
  | "excluded"
  | "requested"
  | "selected"
  | "structural";

export interface CatalogRowPresentationInput {
  asset: AuthoringAssetV1;
  state: CatalogAssetState;
  nextAction?: string;
  explicitAdministratorExclusion: boolean;
  hasNonAdministratorExclusion: boolean;
}

export interface CatalogRowPresentation {
  status: string;
  explanation: string;
  primaryAction: string;
  exclusionAction: string;
  exclusionHelp: string;
}

function textRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_PURPOSE_LENGTH = 2_000;

function readablePurpose(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/[ \t\r\n]+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PURPOSE_LENGTH ||
    /\p{C}/u.test(normalized)
  )
    return undefined;
  return normalized;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = textRecord(current);
    if (record === undefined) return undefined;
    current = record[key];
  }
  return readablePurpose(current);
}

function preparedPurpose(value: unknown): string | undefined {
  for (const path of [
    ["decision", "purpose"],
    ["description"],
    ["summary"],
    ["declaration", "description"],
    ["asset", "description"],
    ["asset", "metadata", "description"],
    ["asset", "metadata", "summary"],
    ["skill", "description"],
    ["component", "description"],
    ["profile", "description"],
  ]) {
    const found = nestedString(value, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

function humanizedIdentifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9:/._-]*$/iu.test(value)) return value;
  const terminal = value.split("/").at(-1) ?? value;
  const words = terminal.split(/[:._-]+/u).filter(Boolean);
  return words
    .map((word) =>
      /^(?:mcp|api|json|ai|ui|ux|id)$/iu.test(word)
        ? word.toUpperCase()
        : word.slice(0, 1).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** Turns a technical catalog label into a readable title without reading a detail chunk. */
export function humanizedAssetLabel(asset: Pick<AuthoringAssetV1, "id" | "label">): string {
  return humanizedIdentifier(asset.label);
}

function matchingEvidence(
  asset: AuthoringAssetV1,
  evidence: readonly EvidenceSummaryV1[],
): EvidenceSummaryV1 | undefined {
  return evidence.find((summary) =>
    summary.subjects.some(
      (subject) =>
        subject.assetId === asset.id &&
        subject.sourceId === asset.sourceId &&
        subject.sourceRevisionId === asset.sourceRevisionId &&
        subject.contentDigest === asset.contentDigest,
    ),
  );
}

function effectFor(asset: AuthoringAssetV1): string {
  switch (asset.authoring.action) {
    case "select-control":
      return `Adds this control to your policy draft. Supported hosts: ${asset.authoring.supportedTargets.join(", ")}. Deployment setup chooses which of those hosts this policy targets. Core checks it against your project before it can take effect.`;
    case "record-selection":
      return "Keeps this version in your draft for later adoption. Adding it here does not install it or grant it access.";
    case "record-request":
      return "Saves this item as a pending request for follow-up. It remains unavailable as a managed policy control.";
    case "inspect-evidence":
      return "Viewing this item opens prepared evidence only. It does not change policy or grant approval.";
    case "prepare-approval":
      return "Preparing this item creates a local review draft only. It does not approve, activate, or execute anything.";
  }
}

function preparedDetail(asset: AuthoringAssetV1, bundle: AuthoringCatalogBundleV1): unknown {
  const chunk = bundle.detailChunks[asset.detailChunkId];
  if (chunk === undefined) return undefined;
  try {
    return JSON.parse(chunk.bytes);
  } catch {
    return undefined;
  }
}

function stringList(value: unknown, path: readonly string[]): string[] {
  let current = value;
  for (const key of path) current = textRecord(current)?.[key];
  if (!Array.isArray(current)) return [];
  return current.slice(0, 32).flatMap((entry) => {
    const text = readablePurpose(entry);
    return text === undefined ? [] : [text];
  });
}

function declaredAccess(parsed: unknown): string | undefined {
  const prepared = nestedString(parsed, ["decision", "access"]);
  if (prepared !== undefined) return prepared;
  const tools = stringList(parsed, ["asset", "metadata", "allowedTools"]);
  if (tools.length > 0)
    return `Tools named by the source: ${tools.join(", ")}. Actual access depends on the host's permissions.`;
  const records = nestedString(parsed, ["declaration", "behaviour", "records"]);
  const artifact = nestedString(parsed, ["declaration", "behaviour", "artifact"]);
  if (records !== undefined && artifact !== undefined) return `Records ${records} in ${artifact}.`;
  const event = nestedString(parsed, ["component", "metadata", "event"]);
  if (event !== undefined)
    return `The source declares a command that runs on ${event}. Its filesystem and network permissions are not described in this catalog.`;
  const transport = nestedString(parsed, ["component", "metadata", "transport"]);
  if (transport === "stdio")
    return "Runs a local process. The source has not supplied a filesystem, network, or credential access summary.";
  return undefined;
}

export interface AssetDecisionPresentation {
  purpose: string;
  access: string;
  consequence: string;
  evidenceLabel: string;
  evidenceHelp: string;
  needsInformation: boolean;
}

export interface AssetEvidencePresentation {
  component?: { label: "Included with Core"; package: string; path: string };
  state: EvidenceDisplayState;
  tone: "neutral" | "warning" | "positive";
  statusLabel: string;
  reportedResult: string | undefined;
  analyzers: readonly { name: string; version: string }[];
  binding: string;
  coverage: string;
  qualification: string;
  showQualification: boolean;
  qualificationState: "qualified" | "unqualified" | "unknown";
  freshness: string;
  findings: readonly string[];
  findingsLabel: string;
  scopePaths: readonly string[];
  nextStep: string;
  limitation: string;
  reportGap?: {
    owner: string;
    missing: string;
  };
  sourceItemReports?: {
    total: number;
    attachedExactVersionReports: number;
    completeCoverageReports: number;
    partialCoverageReports: number;
    noCoverageReports: number;
    reportsWithFindings: number;
    findingCount: number;
    summary: string;
    reportItems: readonly {
      assetId: string;
      label: string;
      statusLabel: string;
      coverage: "complete" | "partial" | "none";
      findingCount: number;
    }[];
  };
}

/** Reading-only context for a report from an earlier catalog source snapshot. */
export interface PreviousCatalogReportPresentation {
  summary: string;
  reportedOutcome: string;
  sourceSnapshot: string;
  dates: string;
  scope: string;
  mcpScope: string | undefined;
  analyzers: readonly { name: string; version: string }[];
  findings: readonly string[];
  publicationUrl: string;
}

/** Source totals are independent of pagination and do not parse any detail chunks. */
export function sourceEvidenceSummary(
  bundle: AuthoringCatalogBundleV1,
  sourceId: string,
  state: WorkbenchStateV1,
  now = Date.now(),
): {
  totalAssets: number;
  includedReports: number;
  reportsWithConcerns: number;
  currentReports: number;
  needsReview: number;
  choicesInDraft: number;
} {
  const summaries = Object.values(bundle.evidence);
  const byAsset = new Map<string, EvidenceSummaryV1>();
  for (const summary of summaries)
    for (const subject of summary.subjects) {
      const asset = bundle.assets[subject.assetId];
      if (
        asset?.sourceId === sourceId &&
        subject.sourceId === asset.sourceId &&
        subject.sourceRevisionId === asset.sourceRevisionId &&
        subject.contentDigest === asset.contentDigest &&
        !byAsset.has(asset.id)
      )
        byAsset.set(asset.id, summary);
    }
  const selected = new Set(resolveWorkbenchSelection(bundle, state).assetIds);
  const requests = new Set(
    state.requests
      .filter((request) => {
        const asset = bundle.assets[request.assetId];
        return (
          asset !== undefined &&
          request.sourceId === asset.sourceId &&
          request.sourceRevisionId === asset.sourceRevisionId &&
          request.contentDigest === asset.contentDigest
        );
      })
      .map((request) => request.assetId),
  );
  const result = {
    totalAssets: 0,
    includedReports: 0,
    reportsWithConcerns: 0,
    currentReports: 0,
    needsReview: 0,
    choicesInDraft: 0,
  };
  for (const asset of Object.values(bundle.assets)) {
    if (asset.sourceId !== sourceId) continue;
    result.totalAssets++;
    const evidence = byAsset.get(asset.id);
    if (evidence !== undefined && evidence.verification.state !== "missing")
      result.includedReports++;
    const displayState = evidenceDisplayFor(
      asset,
      evidence === undefined ? [] : [evidence],
      now,
    ).state;
    const current = displayState === "verified";
    if (
      (current || displayState === "unverified" || displayState === "stale") &&
      evidence !== undefined &&
      (evidence.scan.outcome === "failed" || evidence.findings.length > 0)
    )
      result.reportsWithConcerns++;
    if (current) result.currentReports++;
    if (
      !current ||
      qualificationDisplayFor(asset, bundle, now).state !== "current" ||
      evidence?.scan.outcome !== "pass" ||
      evidence.scan.coverage !== "complete" ||
      evidence.findings.length > 0
    )
      result.needsReview++;
    if (selected.has(asset.id) || requests.has(asset.id)) result.choicesInDraft++;
  }
  return result;
}

/** Plain-language context for a known rule; the original finding remains the evidence. */
export function findingExplanation(finding: string): string | undefined {
  if (/(?:^|[^a-zA-Z0-9_.-])trust\.external-egress(?:$|[^a-zA-Z0-9_.-])/u.test(finding))
    return "External connection: the report flags material that may contact another service. Check the destination and what would be sent. For a remote font or stylesheet, opening the generated page may make that request.";
  return undefined;
}

function isGeneratedMethodologyProfile(asset: AuthoringAssetV1): boolean {
  return asset.derivation === "core-derived" && asset.exclusiveSlot === "methodology";
}

function isAihBundledAsset(asset: AuthoringAssetV1, bundle: AuthoringCatalogBundleV1): boolean {
  const source = bundle.sources[asset.sourceId];
  return (
    source?.id === "source:aih-core" &&
    source.inputFormat === "built-in/v1" &&
    source.upstreamOrigin.kind === "aih"
  );
}

/** Distribution identity only; it supplies no scan or qualification authority. */
function bundledCoreComponent(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
): AssetEvidencePresentation["component"] {
  const source = bundle.sources[asset.sourceId];
  const pack =
    (asset.kind === "skill" || asset.kind === "agent") &&
    /^aih\/package:skill-pack\/[a-z][a-z0-9-]*$/.test(asset.id) &&
    asset.originalPath.startsWith(`packs/${asset.id.split("/").at(-1)}/`);
  const hook =
    asset.kind === "hook" &&
    asset.id === "aih/usage-metering" &&
    asset.originalPath === "core-control/usage-metering" &&
    asset.authoring.projectorId === "usage-hook";
  if (
    !isAihBundledAsset(asset, bundle) ||
    source?.upstreamOrigin.locator !== "@aihq/core" ||
    source.distributor.kind !== "aih" ||
    source.distributor.locator !== "@aihq/core" ||
    source.compiler.id !== "built-in" ||
    asset.derivation !== "built-in" ||
    source.revision.id !== asset.sourceRevisionId ||
    !asset.sourceRevisionId.startsWith("package:@aihq/core@") ||
    !(pack || hook)
  )
    return undefined;
  return {
    label: "Included with Core",
    package: asset.sourceRevisionId.slice("package:".length),
    path: asset.originalPath,
  };
}

function hasAttachedExactVersionReport(state: EvidenceDisplayState): boolean {
  return state === "verified" || state === "unverified" || state === "stale";
}

function sourceItemReportsPresentation(
  profile: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  now: number,
): NonNullable<AssetEvidencePresentation["sourceItemReports"]> {
  const sourceItems = Object.values(bundle.assets)
    .filter(
      (candidate) =>
        candidate.id !== profile.id &&
        candidate.sourceId === profile.sourceId &&
        candidate.derivation === "upstream",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const summaries = Object.values(bundle.evidence);
  const reportItems = sourceItems.flatMap((candidate) => {
    const display = assetEvidencePresentation(candidate, bundle, now);
    if (!hasAttachedExactVersionReport(display.state)) return [];
    const evidence = matchingEvidence(candidate, summaries);
    if (evidence === undefined) return [];
    return [
      {
        assetId: candidate.id,
        label: humanizedAssetLabel(candidate),
        statusLabel: display.statusLabel,
        coverage: evidence.scan.coverage,
        findingCount: evidence.findings.length,
      },
    ];
  });
  const completeCoverageReports = reportItems.filter((item) => item.coverage === "complete").length;
  const partialCoverageReports = reportItems.filter((item) => item.coverage === "partial").length;
  const noCoverageReports = reportItems.filter((item) => item.coverage === "none").length;
  const reportsWithFindings = reportItems.filter((item) => item.findingCount > 0).length;
  const findingCount = reportItems.reduce((total, item) => total + item.findingCount, 0);
  return {
    total: sourceItems.length,
    attachedExactVersionReports: reportItems.length,
    completeCoverageReports,
    partialCoverageReports,
    noCoverageReports,
    reportsWithFindings,
    findingCount,
    summary:
      `Attached exact-version reports: ${reportItems.length} of ${sourceItems.length} source items. ` +
      `Reported coverage: ${completeCoverageReports} complete, ${partialCoverageReports} partial, ${noCoverageReports} none. ` +
      `Findings: ${reportsWithFindings} reports list ${findingCount} findings. ` +
      "These are separate source items and do not establish coverage of this generated profile.",
    reportItems,
  };
}

/**
 * Presents a prior report only when both its exact subject and the current
 * source snapshot match the visible asset. It never changes current evidence.
 */
export function previousCatalogReportPresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  report: WorkbenchReferenceReportV1 | undefined,
): PreviousCatalogReportPresentation | undefined {
  const source = bundle.sources[asset.sourceId];
  if (
    report === undefined ||
    matchingEvidence(
      asset,
      Object.values(bundle.evidence).filter(
        (evidence) => evidence.verification.state !== "missing",
      ),
    ) !== undefined ||
    report.kind !== "previous-catalog-report" ||
    report.authority !== "none" ||
    report.assetId !== asset.id ||
    report.subject.assetId !== asset.id ||
    report.subject.sourceId !== asset.sourceId ||
    report.subject.sourceRevisionId !== asset.sourceRevisionId ||
    report.subject.contentDigest !== asset.contentDigest ||
    source === undefined ||
    source.id !== asset.sourceId ||
    source.revision.id !== asset.sourceRevisionId ||
    source.revision.contentDigest !== report.currentSourceContentDigest ||
    report.previousSourceContentDigest === report.currentSourceContentDigest
  )
    return undefined;
  return {
    summary:
      "This previous report names the same exact item, but its source snapshot is older. Current catalog evidence remains pending.",
    reportedOutcome:
      report.outcome === "failed"
        ? "Previous reported result: failed. Review the findings below. This is not current evidence."
        : "Previous reported result: pass. This is not current evidence.",
    sourceSnapshot:
      `Previous source snapshot: ${report.previousSourceContentDigest}. ` +
      `Current source snapshot: ${report.currentSourceContentDigest}.`,
    dates:
      `Signed ${report.reportSignedAt}; published ${report.publishedAt}; ` +
      `original report expiry ${report.validUntil}.`,
    scope: "Previous report scope: " + report.coveredPaths.join(", ") + ".",
    mcpScope:
      asset.kind === "mcp"
        ? "For this MCP entry, the historical report covers AIH configuration declarations and the listed paths; it is not a security audit of the full upstream MCP runtime."
        : undefined,
    analyzers: report.analyzers,
    findings: report.findings,
    publicationUrl: report.publicationUrl,
  };
}

/** Presents Core's bounded summary, without inventing scan dates, severities or approval. */
export function assetEvidencePresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  now = Date.now(),
): AssetEvidencePresentation {
  const summaries = Object.values(bundle.evidence);
  const { state } = evidenceDisplayFor(asset, summaries, now);
  const evidence = matchingEvidence(asset, summaries);
  const readable = evidence !== undefined && state !== "none" && state !== "missing";
  const sharedReport = evidence?.scan.scope === "published-component-containment";
  const qualification = qualificationDisplayFor(asset, bundle, now);
  const component = bundledCoreComponent(asset, bundle);
  if (isGeneratedMethodologyProfile(asset)) {
    const sourceItemReports = sourceItemReportsPresentation(asset, bundle, now);
    return {
      state: "none",
      tone: "neutral",
      statusLabel: "Review source reports",
      reportedResult: undefined,
      analyzers: [],
      binding:
        "Generated profile; no standalone scan. Review source item reports below. These items are not automatically selected.",
      coverage: sourceItemReports.summary,
      qualification: qualification.text,
      showQualification: true,
      qualificationState: qualification.state === "current" ? "qualified" : "unknown",
      freshness: "No standalone profile report has a Core verification interval.",
      findings: [],
      findingsLabel: "Source item report findings",
      scopePaths: [],
      nextStep:
        "Review source item reports and their findings. These counts do not establish coverage of the generated profile.",
      limitation:
        "Source item reports describe separate material. They do not establish coverage of this generated profile or organization approval.",
      sourceItemReports,
    };
  }
  let reportExpiry = "unavailable";
  if (evidence?.scan.reportSignedAt !== undefined) {
    try {
      reportExpiry = evidenceExpiryV1(
        evidence.scan.reportSignedAt,
        evidence.verification.validUntil,
      );
    } catch {
      reportExpiry = "unavailable: invalid report dates";
    }
  }
  const statusLabels = {
    none: "Report not attached",
    missing: "Scan report missing",
    stale: "Scan report needs refreshing",
    unverified:
      evidence?.scan.outcome === "failed"
        ? "Concerns reported · review incomplete"
        : evidence !== undefined && evidence.findings.length > 0
          ? "Findings reported · review incomplete"
          : evidence?.scan.outcome !== "pass"
            ? "Inconclusive scan · review incomplete"
            : evidence.scan.coverage !== "complete"
              ? "Limited scan coverage · review incomplete"
              : "Security review incomplete",
    verified:
      evidence?.scan.outcome === "pass"
        ? evidence.findings.length > 0
          ? "Findings to review"
          : `${sharedReport ? "Source scan" : "Scan"} passed · ${evidence.scan.coverage} coverage`
        : evidence?.scan.outcome === "failed"
          ? `${sharedReport ? "Source scan" : "Scan"} found concerns`
          : "Scan result inconclusive",
  };
  const nextSteps = {
    none: "AIH should attach a published report for bundled items. New or changed items need a report matching their content.",
    missing:
      "The report must be attached to this exact version. Reuse an existing matching report before requesting a new scan.",
    stale:
      "Ask the catalog preparer to refresh the evidence for this version. The old result cannot support the current review.",
    unverified:
      "Review the preliminary findings below. AIH has not verified this report, so it cannot yet support a security decision. An existing report may be verified without running another scan.",
    verified:
      "Core verified the attached evidence for this version. Review its findings and scope; this is not your organization's approval.",
  };
  const reportGap =
    isAihBundledAsset(asset, bundle) && (state === "none" || state === "missing")
      ? { owner: "AIH", missing: "an exact-version report for this bundled item" }
      : undefined;
  return {
    ...(component === undefined ? {} : { component }),
    state,
    tone:
      !readable || state === "stale"
        ? "neutral"
        : evidence.scan.outcome !== "pass" ||
            evidence.findings.length > 0 ||
            evidence.scan.coverage !== "complete"
          ? "warning"
          : state === "verified"
            ? "positive"
            : "neutral",
    statusLabel:
      reportGap === undefined
        ? statusLabels[state]
        : component === undefined
          ? "AIH evidence pending"
          : "Current scan report not attached",
    reportedResult: readable
      ? evidence.scan.outcome === "pass"
        ? "Pass"
        : evidence.scan.outcome === "failed"
          ? "Concerns found"
          : "Inconclusive"
      : undefined,
    analyzers: readable ? (evidence.scan.analyzers ?? []) : [],
    binding:
      reportGap !== undefined
        ? `Owner: ${reportGap.owner}. Missing: ${reportGap.missing}.`
        : state === "verified"
          ? "Core verified evidence bound to this item's source, revision and content digest."
          : state === "unverified" || state === "stale"
            ? "The attached report names this item's exact source, version, and content."
            : "This Workbench has no current report covering this exact version.",
    coverage:
      readable && sharedReport
        ? `${state === "stale" ? "Historical coverage: " : ""}This item's files are covered by a broader source report. The result and findings describe that report, including shared files; they do not establish runtime behavior or organization approval.`
        : state === "verified" && evidence !== undefined
          ? `${evidence.scan.coverage === "complete" ? "Complete" : evidence.scan.coverage === "partial" ? "Partial" : "No"} scan coverage reported. Review the covered paths below; shared configuration may contain other items.`
          : (state === "unverified" || state === "stale") && evidence !== undefined
            ? `${state === "stale" ? "Historical reported coverage" : "Reported coverage"}: ${evidence.scan.coverage}.`
            : "Coverage cannot be established for this version.",
    freshness:
      readable && evidence.scan.reportSignedAt !== undefined
        ? `${state === "unverified" ? "Report claims signing date" : "Report signed"} ${evidence.scan.reportSignedAt}${evidence.scan.publishedAt === undefined ? "" : `; published ${evidence.scan.publishedAt}`}. ${state === "stale" ? "Expired or outside its valid interval. " : ""}Report freshness ends ${reportExpiry}. Repackaging does not renew this date.`
        : state === "verified" && evidence !== undefined
          ? `Core verified this evidence at ${evidence.verification.verifiedAt}; valid until ${evidence.verification.validUntil}. The scanner run date is not supplied.`
          : state === "stale"
            ? "The evidence is stale or outside its verified validity interval."
            : "No current Core verification interval is available.",
    qualification: qualification.text,
    showQualification: true,
    qualificationState: qualification.state === "current" ? "qualified" : "unknown",
    findings: readable ? evidence.findings : [],
    findingsLabel:
      state === "stale" ? "Historical report findings: refresh required" : "Report findings",
    scopePaths: readable ? evidence.coveredPaths : [],
    nextStep:
      reportGap === undefined
        ? nextSteps[state]
        : "Find or reuse an existing matching report, then publish one if it is missing.",
    limitation:
      "A scan describes the covered material. Adding this item saves a draft choice; it does not approve, install, or grant access.",
    reportGap,
  };
}

/** Reads only a visible item's prepared chunk. Source declarations are not verified permissions. */
export function assetDecisionPresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
): AssetDecisionPresentation {
  const parsed = preparedDetail(asset, bundle);
  const purpose =
    preparedPurpose(parsed) ??
    (asset.exclusiveSlot === "methodology"
      ? "Sets the workflow approach for this policy draft. Choose up to one methodology, or leave it empty. Additional skills and tools are chosen separately."
      : undefined);
  const access = declaredAccess(parsed);
  const report = assetEvidencePresentation(asset, bundle);
  const evidence = matchingEvidence(asset, Object.values(bundle.evidence));
  return {
    purpose:
      purpose ??
      "The source has not supplied a description. Review its documentation before choosing this item.",
    access:
      access ??
      "Access is not described in this catalog. Review the source's tools, commands, and data handling before adoption.",
    consequence: effectFor(asset),
    evidenceLabel:
      report.component !== undefined && (report.state === "none" || report.state === "missing")
        ? report.component.label
        : report.statusLabel,
    evidenceHelp:
      report.component === undefined
        ? report.nextStep
        : `${report.component.package} · Bundled path: ${report.component.path}. Scan status: ${report.statusLabel}.`,
    needsInformation:
      purpose === undefined ||
      access === undefined ||
      report.state !== "verified" ||
      evidence?.scan.outcome !== "pass" ||
      evidence?.scan.coverage !== "complete" ||
      (evidence?.findings.length ?? 0) > 0 ||
      report.qualificationState !== "qualified",
  };
}

function relationText(
  relation: CatalogRelationV1,
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
): string | undefined {
  const otherId = relation.fromAssetId === asset.id ? relation.toAssetId : relation.fromAssetId;
  const other = bundle.assets[otherId];
  if (other === undefined) return undefined;
  const label = humanizedAssetLabel(other);
  const outgoing = relation.fromAssetId === asset.id;
  if (relation.kind === "requires")
    return outgoing ? `Requires ${label}.` : `Required by ${label}.`;
  if (relation.kind === "conflicts") return `Conflicts with ${label}.`;
  if (outgoing)
    return relation.membership === "required"
      ? `Includes required member ${label}.`
      : `Includes optional member ${label}.`;
  return relation.membership === "required"
    ? `Is a required member of ${label}.`
    : `Is an optional member of ${label}.`;
}

function evidenceFact(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
): CatalogDetailFact[] {
  if (isGeneratedMethodologyProfile(asset)) {
    const sourceItemReports = sourceItemReportsPresentation(asset, bundle, Date.now());
    return [{ label: "Source item reports", value: sourceItemReports.summary }];
  }
  const presentation = assetEvidencePresentation(asset, bundle);
  if (presentation.reportGap !== undefined)
    return [
      { label: "Evidence owner", value: presentation.reportGap.owner },
      { label: "Evidence missing", value: presentation.reportGap.missing },
    ];
  const display = evidenceDisplayFor(asset, Object.values(bundle.evidence));
  const evidence = matchingEvidence(asset, Object.values(bundle.evidence));
  if (display.state === "none" || display.state === "missing" || evidence === undefined) return [];
  const scope = {
    label: "Scope of this report",
    value:
      evidence.coveredPaths.length === 0
        ? "No covered paths are declared. Coverage of this item cannot be established."
        : `${evidence.coveredPaths.join(", ")}. A finding in shared configuration does not establish that every item in it has the same behavior.`,
  };
  if (display.state === "unverified" || display.state === "stale")
    return [
      { label: "Reported result", value: evidence.scan.outcome },
      { label: "Reported coverage", value: evidence.scan.coverage },
      scope,
      ...(evidence.scan.analyzers?.length
        ? [
            {
              label: "Analyzers named in the report",
              value: evidence.scan.analyzers
                .map((analyzer) => analyzer.name + " · " + analyzer.version)
                .join("\n"),
            },
          ]
        : []),
      { label: "Report validity", value: assetEvidencePresentation(asset, bundle).freshness },
      { label: "Catalog qualification", value: qualificationDisplayFor(asset, bundle).text },
      {
        label: display.state === "stale" ? "Historical report findings" : "Report findings",
        value:
          evidence.findings.length === 0
            ? "No finding details were included in this report."
            : evidence.findings.join("\n\n"),
      },
    ];
  const verifiedAt = evidence.verification.verifiedAt;
  const validUntil = evidence.verification.validUntil;
  return [
    {
      label: "Evidence verification",
      value:
        "Prepared evidence is verified" +
        (verifiedAt === undefined || validUntil === undefined
          ? ". This is evidence status only, not organization approval."
          : " from " +
            verifiedAt +
            " until " +
            validUntil +
            ". This is evidence status only, not organization approval."),
    },
    { label: "Scan result", value: evidence.scan.outcome },
    { label: "Coverage", value: evidence.scan.coverage },
    ...(evidence.scan.analyzers?.length
      ? [
          {
            label: "Analyzers named in the report",
            value: evidence.scan.analyzers
              .map((analyzer) => analyzer.name + " · " + analyzer.version)
              .join("\n"),
          },
        ]
      : []),
    { label: "Catalog qualification", value: qualificationDisplayFor(asset, bundle).text },
    scope,
    ...(evidence.findings.length === 0
      ? [
          {
            label: "Report findings",
            value:
              "No findings are listed in this report. Check coverage before drawing a conclusion.",
          },
        ]
      : [{ label: "Report findings", value: evidence.findings.join("\n\n") }]),
  ];
}

/**
 * Keeps a source-scoped type filter honest. The browse result already counts
 * types without applying the active type, so it is the complete source scope.
 */
export function visibleCatalogKindOptions(
  filters: CatalogBrowseFilters,
  options: readonly CatalogBrowseOption[],
): readonly CatalogBrowseOption[] {
  return filters.sourceId === undefined ? options : options.filter((option) => option.count > 0);
}

export function normalizedCatalogBrowseFilters(
  filters: CatalogBrowseFilters,
  options: readonly CatalogBrowseOption[],
): CatalogBrowseFilters {
  if (
    filters.sourceId === undefined ||
    filters.kind === undefined ||
    options.some((option) => option.id === filters.kind && option.count > 0)
  )
    return filters;
  return { ...filters, kind: undefined, page: 0 };
}

export interface CatalogAssetStateInput {
  excluded: boolean;
  requested: boolean;
  structuralDirect: boolean;
  directSelect: boolean;
  selected: boolean;
}

/** Structural roots take precedence; every direct select root is direct, regardless of origin. */
export function catalogAssetState({
  excluded,
  requested,
  structuralDirect,
  directSelect,
  selected,
}: CatalogAssetStateInput): CatalogAssetState {
  if (requested) return "requested";
  if (structuralDirect) return "structural";
  if (directSelect) return "selected";
  if (selected) return "dependency";
  return excluded ? "excluded" : "available";
}

/** Presents authoring state without implying execution, target fulfillment, or approval. */
export function catalogRowPresentation({
  asset,
  state,
  nextAction,
  explicitAdministratorExclusion,
  hasNonAdministratorExclusion,
}: CatalogRowPresentationInput): CatalogRowPresentation {
  const selectionExplanation =
    asset.authoring.action === "select-control"
      ? "In your draft as a policy control. Repository behavior has not been evaluated."
      : asset.authoring.action === "record-selection"
        ? "This version is saved in your draft for adoption."
        : "This item requires follow-up before it can become a managed control.";
  const byState: Record<
    CatalogAssetState,
    Pick<CatalogRowPresentation, "status" | "explanation">
  > = {
    available: {
      status: "Not in draft",
      explanation:
        asset.authoring.action === "record-request"
          ? "Request review to keep this item on your follow-up list."
          : "Add this item to your policy draft when you have reviewed its purpose and access.",
    },
    dependency: {
      status: "Included as a dependency",
      explanation:
        "A selected item requires this item. Change the selecting root to alter this dependency.",
    },
    excluded: explicitAdministratorExclusion
      ? {
          status: "Explicitly excluded",
          explanation:
            "An administrator exclusion prevents optional inclusion. It cannot override a required dependency.",
        }
      : {
          status: "Excluded by a saved origin",
          explanation: hasNonAdministratorExclusion
            ? "A template or legacy exclusion prevents optional inclusion."
            : "An exclusion prevents optional inclusion.",
        },
    requested: {
      status: "Pending request",
      explanation: "Saved for follow-up. This request has not enabled the item.",
    },
    selected: { status: "In your draft", explanation: selectionExplanation },
    structural: {
      status: "Included as a group",
      explanation: "This group organizes your selections; review its included items below.",
    },
  };
  const primaryAction =
    nextAction === "remove-request"
      ? "Remove request"
      : nextAction === "remove-root"
        ? "Remove my choice"
        : nextAction === "record-request"
          ? "Request review"
          : nextAction === "select-root"
            ? state === "selected" || state === "dependency"
              ? "Keep as my choice"
              : "Add to draft"
            : asset.authoring.action === "inspect-evidence"
              ? "View evidence"
              : "Prepare review";
  return {
    ...byState[state],
    primaryAction,
    exclusionAction: explicitAdministratorExclusion
      ? "Undo my exclusion"
      : "Exclude from optional groups",
    exclusionHelp:
      "Administrator exclusions only prevent optional inclusion; required dependencies remain governed by their relations.",
  };
}

export function assetDetailsPresentation(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
): CatalogDetailPresentation {
  const chunk = bundle.detailChunks[asset.detailChunkId];
  let parsed: unknown;
  let advancedJson = "No prepared metadata chunk is available.";
  let malformed = chunk === undefined;
  if (chunk !== undefined) {
    advancedJson = chunk.bytes;
    try {
      parsed = JSON.parse(chunk.bytes);
    } catch {
      malformed = true;
    }
  }
  const relations = bundle.relations
    .filter((relation) => relation.fromAssetId === asset.id || relation.toAssetId === asset.id)
    .map((relation) => relationText(relation, asset, bundle))
    .filter((value): value is string => value !== undefined);
  const decision = assetDecisionPresentation(asset, bundle);
  const report = assetEvidencePresentation(asset, bundle);
  const reason = nestedString(parsed, ["declaration", "reason"]);
  const usage = nestedString(parsed, ["asset", "metadata", "usageContext"]);
  const trigger = nestedString(parsed, ["declaration", "behaviour", "trigger"]);
  const failureMode = nestedString(parsed, ["declaration", "behaviour", "failureMode"]);
  return {
    title: humanizedAssetLabel(asset),
    summary: malformed
      ? "Prepared metadata is unavailable or malformed, so no additional purpose can be shown."
      : decision.purpose,
    facts: [
      ...(report.component === undefined
        ? []
        : [
            {
              label: "Component origin",
              value: `${report.component.label} · ${report.component.package}`,
            },
            { label: "Bundled path or control", value: report.component.path },
          ]),
      ...(usage === undefined ? [] : [{ label: "When to use it", value: usage }]),
      { label: "Access declared by the source", value: decision.access },
      ...(trigger === undefined ? [] : [{ label: "When it runs", value: trigger }]),
      ...(failureMode === undefined ? [] : [{ label: "If it fails", value: failureMode }]),
      { label: "If you add this", value: decision.consequence },
      ...(asset.kind === "skill"
        ? [
            {
              label: "Practice effect",
              value:
                "This practice is instruction guidance. Verify that a fresh session loads the delivered content. Installing or discovering a skill does not enforce the practice; an enforced restriction needs a supported control and a separate refusal check.",
            },
          ]
        : []),
      ...(reason === undefined ? [] : [{ label: "Why this needs follow-up", value: reason }]),
      {
        label: "Policy support",
        value:
          asset.authoring.supportedTargets.length === 0
            ? "No managed policy target is declared for this item. Host compatibility must be reviewed separately."
            : asset.authoring.projectorId === "mcp-managed-settings"
              ? `Governed MCP configuration for ${asset.authoring.supportedTargets.join(", ")}. Configuration readiness does not verify that the host loaded the server or connected to it.`
              : `Managed control for ${asset.authoring.supportedTargets.join(", ")}. This does not describe every host the upstream tool may support.`,
      },
      { label: "Security review", value: `${report.statusLabel}. ${report.nextStep}` },
      ...evidenceFact(asset, bundle),
      ...(relations.length === 0
        ? [
            {
              label: "Related items",
              value: "No relationships are declared in this catalog.",
            },
          ]
        : [{ label: "Related items", value: relations.join(" ") }]),
      {
        label: "Provided by",
        value: catalogSourceDisplayName(bundle, asset.sourceId),
      },
    ],
    advancedJson: JSON.stringify(
      {
        identity: {
          assetId: asset.id,
          revision: asset.sourceRevisionId,
          digest: asset.contentDigest,
          type: asset.kind,
        },
        metadata: parsed ?? advancedJson,
        scannerEvidence: evidenceDisplayFor(asset, Object.values(bundle.evidence)),
        scannerReports: Object.values(bundle.evidence).filter((summary) =>
          summary.subjects.some(
            (subject) =>
              subject.assetId === asset.id &&
              subject.contentDigest === asset.contentDigest &&
              subject.sourceRevisionId === asset.sourceRevisionId,
          ),
        ),
        catalogQualification: qualificationDisplayFor(asset, bundle),
      },
      null,
      2,
    ),
  };
}

export function templateDetailsPresentation(
  template: SelectionTemplateV1,
  bundle: AuthoringCatalogBundleV1,
): CatalogDetailPresentation {
  const labelFor = (assetId: string): string =>
    bundle.assets[assetId] === undefined ? assetId : humanizedAssetLabel(bundle.assets[assetId]);
  const roots = template.roots.map((root) => {
    const optional = root.includeOptionalMembers ? " including optional members" : "";
    return `${labelFor(root.assetId)}${root.mode === "structural" ? " (group)" : ""}${optional}`;
  });
  const exclusions = template.exclusions.map(labelFor);
  return {
    title: template.label ?? template.id,
    summary:
      "Review this starting point before adding it to your draft. Required dependencies may add more items; your existing choices are kept unless there is a conflict.",
    facts: [
      {
        label: "What this changes",
        value:
          "Adds the listed choices and exclusions to your draft. Review their purpose, access, and security reports before adoption.",
      },
      { label: "Starting choices", value: roots.join("; ") },
      {
        label: "Explicit exclusions",
        value: exclusions.length === 0 ? "None." : exclusions.join("; "),
      },
    ],
    advancedJson: JSON.stringify(template, null, 2),
  };
}
