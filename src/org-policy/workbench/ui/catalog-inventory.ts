import {
  type CatalogBrowseFilters,
  type CatalogBrowseInventory,
  catalogBrowse,
  catalogKindLabel,
  catalogSourceDisplayName,
  CATALOG_BROWSE_PAGE_SIZE as PAGE_SIZE,
} from "../catalog-browse.js";
import type { WorkbenchPolicyBindingsV1 } from "../compile-policy.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  WorkbenchOriginV1,
  WorkbenchStateV1,
} from "../contracts.js";
import { planWorkbenchAdoptionV1 } from "../core/adoption-plan-v1.js";
import { workbenchBrowseBundleV1 } from "../engine/scan-presentation.js";
import type { WorkbenchReferenceReportsV1 } from "../reference-reports.js";
import {
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
  type WorkbenchActionV1,
  type WorkbenchReductionV1,
  workbenchSelectionCounts,
  workbenchStatesEqualV1,
} from "../selection-engine.js";
import {
  assetDecisionPresentation,
  assetDetailsPresentation,
  assetEvidencePresentation,
  catalogAssetState,
  catalogRowPresentation,
  findingExplanation,
  humanizedAssetLabel,
  previousCatalogReportPresentation,
  sourceEvidenceSummary,
  templateDetailsPresentation,
} from "./catalog-presentation.js";
import { isDeveloperToolCatalogAssetId } from "./developer-tool-catalog.js";
import { workbenchIcon } from "./icons.js";
import { catalogKindIcon, mountKindLedger } from "./kind-ledger.js";
import {
  mcpRuntimeOverlapPresentation,
  selectionComparisonPresentation,
} from "./selection-comparison.js";
import { icon as glyph } from "./shell/dom.js";

/*
 * S3 (NEW-SHELL-PLAN.md): the sources screen follows
 * prototype/policy-workbench/screens/admin-sources.html. Every behavioural
 * hook (class names, data-workbench-* attributes, ARIA names) stays on the
 * same element the tests pin.
 */
const BTN =
  "inline-flex items-center justify-center gap-1 h-7 px-2.5 rounded text-[11px] font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY = `${BTN} border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface`;
/** The full record's facts: the prototype's mono key / value box, stacked. */
const WB_FACTS =
  "m-0 p-2 rounded bg-surface-container-lowest border border-solid border-hairline text-[11px] flex flex-col gap-0.5 min-w-0 [&>dt]:font-mono [&>dt]:text-[10px] [&>dt]:uppercase [&>dt]:tracking-wider [&>dt]:text-outline [&>dt]:font-semibold [&>dt:not(:first-child)]:pt-1.5 [&>dd]:m-0 [&>dd]:text-on-surface [&>dd]:leading-snug";
/** The prototype's text field: the search box's border, surface and mono type. */
const WB_TEXTAREA =
  "w-full min-w-0 px-2 py-1.5 rounded border border-solid border-hairline bg-wb-card text-on-surface text-[11.5px] font-body leading-snug placeholder:text-outline focus:border-primary focus:outline-none resize-y";
/** admin-sources.html inspector footer "Apply". */
const INSPECTOR_PRIMARY =
  "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border-0 bg-primary hover:bg-primary-bright text-on-primary text-[12px] font-medium cursor-pointer transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed";
const REPAIR_ROW =
  "m-0 flex flex-wrap items-center gap-2 px-3 py-2 rounded border border-solid border-outline-variant bg-surface-container-low";

export interface WorkbenchMountOptions {
  bundle: AuthoringCatalogBundleV1;
  referenceReports?: WorkbenchReferenceReportsV1;
  adoptionBindings?: WorkbenchPolicyBindingsV1;
  initialState: WorkbenchStateV1;
  initialDiagnostics?: readonly string[];
  dispatch(action: WorkbenchActionV1, expectedState?: WorkbenchStateV1): WorkbenchReductionV1;
  inspectEvidence?(asset: AuthoringAssetV1): void;
  prepareApproval?(asset: AuthoringAssetV1): void;
  /**
   * S4 (NEW-SHELL-PLAN.md): the new shell's inspector rail panel. The item,
   * draft and exposure inspector mounts there instead of beside the catalog.
   */
  inspectorHost?: HTMLElement;
  /** Show the inspector rail when the user closed it and an inspector view opens. */
  revealInspector?(): void;
  /** Place the source list (the nav rail's "Catalog scopes" section in the new shell). */
  mountSourceRail?(rail: HTMLElement): void;
  /** Report the draft's entry count (the header's Review Changes badge). */
  onDraftCount?(count: number): void;
  /**
   * The new shell's inspector tabs and collapse chevron, placed in the
   * inspector's own head (admin-item.html) under the item's name.
   */
  inspectorChrome?: { tabs: HTMLElement; close: HTMLElement };
}

export interface MountedWorkbench {
  state(): WorkbenchStateV1;
  restore(state: WorkbenchStateV1, diagnostics?: readonly string[]): void;
  dispatch(action: WorkbenchActionV1, expectedState?: WorkbenchStateV1): WorkbenchReductionV1;
  inspectAssetDetails(assetId: string, trigger: HTMLButtonElement): void;
  /** S5: open the draft review or exposure view, as its panel-view button does. */
  showInspectorView(view: "draft" | "exposure"): void;
  destroy(): void;
}

interface SourceGroup {
  id: string;
  label: string;
  assetIds: readonly string[];
}

function sourceGroups(bundle: AuthoringCatalogBundleV1): SourceGroup[] {
  const assetIdsBySource = new Map<string, string[]>();
  const related = new Set(
    bundle.relations.flatMap((relation) => [relation.fromAssetId, relation.toAssetId]),
  );
  for (const asset of Object.values(bundle.assets)) {
    const ids = assetIdsBySource.get(asset.sourceId) ?? [];
    ids.push(asset.id);
    assetIdsBySource.set(asset.sourceId, ids);
  }
  return [...assetIdsBySource.entries()]
    .map(([id, assetIds]) => ({
      id,
      label: catalogSourceDisplayName(bundle, id),
      assetIds: assetIds.sort(
        (left, right) =>
          Number(related.has(right)) - Number(related.has(left)) ||
          compareText(assetLabel(bundle.assets[left]!), assetLabel(bundle.assets[right]!)),
      ),
    }))
    .sort((left, right) => compareText(left.label, right.label));
}

/** The prototype's status dot. */
function dot(color: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = `w-1.5 h-1.5 rounded-full shrink-0 ${color}`;
  node.setAttribute("aria-hidden", "true");
  return node;
}

function assetLabel(asset: AuthoringAssetV1): string {
  return `${asset.label}\u0000${asset.id}`;
}

const administratorOrigin: WorkbenchOriginV1 = { kind: "administrator" };
const EXPOSURE_PAGE_SIZE = 8;

function originKey(origin: WorkbenchOriginV1): string {
  if (origin.kind === "template") return `template:${origin.id}\u0000${origin.digest}`;
  return origin.kind;
}

function originLabel(origin: WorkbenchOriginV1): string {
  if (origin.kind === "template") return `Template ${origin.id}`;
  return origin.kind === "administrator" ? "Administrator" : "Legacy unattributed";
}
function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sourceItemReportsElement(
  reports: NonNullable<ReturnType<typeof assetEvidencePresentation>["sourceItemReports"]>,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("p");
  const summary = document.createElement("p");
  section.dataset.workbenchSourceItemReports = "true";
  heading.textContent = "Source item reports";
  summary.textContent = reports.summary;
  section.append(heading, summary);
  if (reports.reportItems.length === 0) return section;
  const details = document.createElement("details");
  const detailsSummary = document.createElement("summary");
  const list = document.createElement("ul");
  detailsSummary.textContent = `Open ${reports.reportItems.length} source item report${reports.reportItems.length === 1 ? "" : "s"}`;
  for (const report of reports.reportItems) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn sm secondary";
    button.dataset.workbenchDetailId = report.assetId;
    button.setAttribute("aria-label", "Details for " + report.label);
    button.textContent =
      `Details: ${report.label} · ${report.statusLabel}; ${report.coverage} coverage; ` +
      `${report.findingCount} finding${report.findingCount === 1 ? "" : "s"}`;
    item.append(button);
    list.append(item);
  }
  details.append(detailsSummary, list);
  section.append(details);
  return section;
}

function previousCatalogReportElement(
  report: NonNullable<ReturnType<typeof previousCatalogReportPresentation>>,
  { compact = false }: { compact?: boolean } = {},
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  const summary = document.createElement("p");
  const outcome = document.createElement("p");
  const sourceSnapshot = document.createElement("p");
  const dates = document.createElement("p");
  const scope = document.createElement("p");
  const metadata = document.createElement("details");
  const metadataSummary = document.createElement("summary");
  section.className = "workbench-evidence-sheet";
  section.dataset.workbenchPreviousReport = "true";
  heading.textContent = "Previous report: current catalog evidence pending";
  summary.textContent = report.summary;
  outcome.textContent = report.reportedOutcome;
  sourceSnapshot.textContent = report.sourceSnapshot;
  dates.textContent = report.dates;
  scope.textContent = report.scope;
  section.append(heading, ...(compact ? [outcome] : [summary, outcome, scope]));
  if (!compact && report.mcpScope !== undefined) {
    const mcpScope = document.createElement("p");
    mcpScope.textContent = report.mcpScope;
    section.append(mcpScope);
  }
  const findingsHeading = document.createElement("p");
  findingsHeading.textContent = `Previous report findings (${report.findings.length} listed)`;
  section.append(findingsHeading);
  if (report.findings.length === 0) {
    const noFindings = document.createElement("p");
    noFindings.textContent = "No findings are listed in this previous report.";
    section.append(noFindings);
  } else {
    const findings = document.createElement("ul");
    for (const finding of report.findings) {
      const item = document.createElement("li");
      const explanation = findingExplanation(finding);
      if (explanation !== undefined) {
        const explanationText = document.createElement("p");
        const original = document.createElement("details");
        const originalSummary = document.createElement("summary");
        const originalText = document.createElement("p");
        explanationText.textContent = explanation;
        originalSummary.textContent = "Original finding";
        originalText.textContent = finding;
        original.append(originalSummary, originalText);
        item.append(explanationText, original);
      } else item.textContent = finding;
      findings.append(item);
    }
    section.append(findings);
  }
  if (compact) return section;
  const publication = document.createElement("a");
  publication.href = report.publicationUrl;
  publication.target = "_blank";
  publication.rel = "noopener noreferrer";
  publication.dataset.workbenchPreviousReportPublication = "true";
  publication.textContent = "Open previous report publication";
  section.append(publication);
  metadataSummary.textContent = "Report dates and identifiers";
  metadata.append(metadataSummary, sourceSnapshot, dates);
  if (report.analyzers.length > 0) {
    const analyzers = document.createElement("p");
    analyzers.textContent =
      "Analyzers named in the previous report: " +
      report.analyzers.map((analyzer) => analyzer.name + " · " + analyzer.version).join(", ");
    metadata.append(analyzers);
  }
  section.append(metadata);
  return section;
}

function actionFor(
  asset: AuthoringAssetV1,
  state: WorkbenchStateV1,
): WorkbenchActionV1 | undefined {
  const request =
    state.requests.find(
      (candidate) => candidate.assetId === asset.id && candidate.origin.kind === "administrator",
    ) ??
    state.requests.find(
      (candidate) =>
        candidate.assetId === asset.id && candidate.origin.kind === "legacy-unattributed",
    );
  if (request !== undefined)
    return {
      type: "remove-request",
      assetId: asset.id,
      origin: request.origin,
    };
  const root =
    state.roots.find(
      (candidate) => candidate.assetId === asset.id && candidate.origin.kind === "administrator",
    ) ??
    state.roots.find(
      (candidate) =>
        candidate.assetId === asset.id && candidate.origin.kind === "legacy-unattributed",
    );
  if (root !== undefined) return { type: "remove-root", assetId: asset.id, origin: root.origin };
  if (asset.authoring.action === "record-request")
    return {
      type: "record-request",
      assetId: asset.id,
      origin: administratorOrigin,
    };
  if (asset.authoring.action === "select-control" || asset.authoring.action === "record-selection")
    return {
      type: "select-root",
      assetId: asset.id,
      origin: administratorOrigin,
    };
  return undefined;
}
function pageItems<T>(items: readonly T[], page: number): readonly T[] {
  return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

/**
 * The catalog the admin browses: the complete bundle minus what the catalog
 * UI no longer offers. Ponytail is no longer offered, and GitHub is not part
 * of the Core baseline. This browse projection carries no authority; saved
 * policies still round-trip through the complete bundle.
 */
export function workbenchBrowseBundle(bundle: AuthoringCatalogBundleV1): AuthoringCatalogBundleV1 {
  return workbenchBrowseBundleV1(bundle);
}

/**
 * Generic, source-neutral Workbench inventory. Detail chunks are intentionally
 * absent: callers mount them only after their Core-prepared chunk is opened.
 */
export function mountWorkbench(
  root: HTMLElement,
  options: WorkbenchMountOptions,
): MountedWorkbench {
  let state = options.initialState;
  /** Add the prototype's utility classes. */
  const tw = (node: Element, classes: string): void => {
    node.classList.add(...classes.split(" ").filter((token) => token !== ""));
  };
  const browseBundle = workbenchBrowseBundle(options.bundle);
  const browseInventory: CatalogBrowseInventory = {
    sources: browseBundle.sources,
    assets: browseBundle.assets,
  };
  const groups = sourceGroups(browseBundle);
  const teardown = new AbortController();
  const draftSummary = document.createElement("section");
  const draftSummaryHeading = document.createElement("h2");
  const draftSummaryIntro = document.createElement("p");
  const counts = document.createElement("p");
  const exposureButton = document.createElement("button");
  const draftReview = document.createElement("div");
  const draftReviewSummary = document.createElement("button");
  const draftReviewList = document.createElement("div");
  const inspectorNavigation = document.createElement("nav");
  const catalogLayout = document.createElement("div");
  const sourceRail = document.createElement("aside");
  const sourceRailHeading = document.createElement("h2");
  const catalogRegister = document.createElement("section");
  const sourceTabs = document.createElement("nav");
  const filters = document.createElement("div");
  const sourceReview = document.createElement("section");
  const browseTools = document.createElement("div");
  const typeTabs = document.createElement("div");
  const sourceFilter = document.createElement("select");
  const search = document.createElement("input");
  const inventory = document.createElement("section");
  const browseResults = document.createElement("section");
  const diagnostics = document.createElement("p");
  const templates = document.createElement("details");
  const templateSummary = document.createElement("summary");
  const templateList = document.createElement("div");
  const repairs = document.createElement("div");
  const drafts = document.createElement("details");
  const draftSummaryControl = document.createElement("summary");
  const draftList = document.createElement("div");
  const details = document.createElement("aside");
  const inspectorScrim = document.createElement("div");
  details.className = "workbench-detail";
  details.id = "workbench-detail-panel";
  details.dataset.workbenchDetail = "true";
  details.dataset.workbenchInspectorOpen = "false";
  // S4: the item inspector lives in the new shell's inspector rail.
  tw(details, "wb-item-inspector flex flex-col min-h-full min-w-0");
  let filtersState: CatalogBrowseFilters = { sourceId: groups[0]?.id };
  let openDetailKey: string | undefined;
  let openCatalogDetail: { assetId: string; mode: "catalog" | "developer-tool-setup" } | undefined;
  let detailTrigger: HTMLButtonElement | undefined;
  let inspectorOpen = false;
  let evidenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let draftReviewPage = 0;
  let exposureSelectedPage = 0;
  let exposureRequestPage = 0;
  let expandedAssetId: string | undefined;
  let comparisonPreview: { assetId: string; expectedState: WorkbenchStateV1 } | undefined;
  let inspectorMode: "item" | "draft" | "exposure" = "item";
  let lastInspectedAssetId: string | undefined;
  let lastFullDetail:
    | {
        key: string;
        presentation: ReturnType<typeof assetDetailsPresentation>;
        catalogDetail?: {
          asset: AuthoringAssetV1;
          mode: "catalog" | "developer-tool-setup";
        };
      }
    | undefined;
  let draftEntryCount = 0;

  /*
   * The item inspector (admin-item.html, and admin-sources.html's
   * #inspector-rail Details pane): a head with the item's name, its kind /
   * source / status line and the rail's Details / Security / Policy JSON tabs;
   * a scrolling body of mono-labelled sections; a footer with the close and
   * the primary action. In the new shell the rail's tabs and collapse chevron
   * are adopted into this head (`inspectorChrome`).
   */
  const INSPECTOR_LABEL =
    "m-0 block text-[10px] font-mono uppercase tracking-wider text-outline font-semibold";
  const TONE_DOT = { warning: "bg-tertiary", positive: "bg-secondary", neutral: "bg-outline" };
  const inspectorNode = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    classes: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    tw(node, classes);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const inspectorHead = (identity?: {
    heading: HTMLHeadingElement;
    tone: keyof typeof TONE_DOT;
    version?: string;
    kind?: string;
    meta: readonly string[];
    flags?: string;
  }): HTMLElement => {
    const head = inspectorNode(
      "div",
      "sticky top-0 z-10 p-2.5 bg-surface-container-lowest border-0 border-b border-solid border-hairline flex flex-col gap-2 shrink-0 min-w-0",
    );
    head.dataset.wbInspectorHead = "";
    const chrome = options.inspectorChrome;
    if (identity === undefined) {
      const row = inspectorNode("div", "flex items-center gap-2 min-w-0");
      if (chrome !== undefined) row.append(chrome.tabs, chrome.close);
      head.append(row);
      return head;
    }
    const titleRow = inspectorNode("div", "flex items-center justify-between gap-2 min-w-0");
    const name = inspectorNode("div", "flex items-center gap-1.5 min-w-0");
    tw(
      identity.heading,
      "m-0 font-semibold text-on-surface text-[13px] truncate font-mono min-w-0",
    );
    const status = inspectorNode(
      "span",
      `w-2 h-2 rounded-full shrink-0 ${TONE_DOT[identity.tone]}`,
    );
    status.setAttribute("aria-hidden", "true");
    name.append(status, identity.heading);
    if (identity.version !== undefined)
      name.append(
        inspectorNode(
          "span",
          "text-[10px] font-mono px-1 rounded bg-surface-container-highest text-secondary shrink-0 max-w-[40%] truncate",
          identity.version,
        ),
      );
    titleRow.append(name);
    if (chrome !== undefined) titleRow.append(chrome.close);
    const subtitle = inspectorNode(
      "div",
      "flex items-center justify-between gap-2 text-[11px] min-w-0",
    );
    const where = inspectorNode("span", "text-outline inline-flex items-center gap-1 min-w-0");
    if (identity.kind !== undefined) {
      const kindIcon = catalogKindIcon(identity.kind);
      where.append(
        glyph(kindIcon.name, `w-[13px] h-[13px] ${kindIcon.colorClass ?? ""}`),
        inspectorNode(
          "span",
          "font-medium text-on-surface shrink-0",
          catalogKindLabel(identity.kind as AuthoringAssetV1["kind"]),
        ),
      );
    }
    where.append(
      inspectorNode(
        "span",
        "truncate min-w-0",
        (identity.kind === undefined ? "" : " · ") + identity.meta.join(" · "),
      ),
    );
    subtitle.append(where);
    if (identity.flags !== undefined)
      subtitle.append(
        inspectorNode("span", "font-mono text-tertiary font-semibold shrink-0", identity.flags),
      );
    head.append(titleRow, subtitle);
    if (chrome !== undefined) head.append(chrome.tabs);
    return head;
  };
  const inspectorBody = (...children: Node[]): HTMLElement => {
    const body = inspectorNode(
      "div",
      "flex-1 flex flex-col gap-3 p-3 text-[12px] text-on-surface-variant min-w-0",
    );
    body.dataset.wbInspectorBody = "";
    body.append(...children);
    return body;
  };
  /** The item's sections, which the rail's Security / JSON tabs narrow. */
  const sectionsOf = (...children: Node[]): HTMLElement => {
    const sections = inspectorNode("div", "flex flex-col gap-3 min-w-0");
    sections.dataset.wbInspectorSections = "";
    sections.append(...children);
    return sections;
  };
  const inspectorFooter = (...children: Node[]): HTMLElement => {
    const footer = inspectorNode(
      "div",
      "sticky bottom-0 z-10 p-2 bg-surface-container-lowest border-0 border-t border-solid border-hairline flex items-center gap-2 shrink-0",
    );
    footer.dataset.wbInspectorFooter = "";
    footer.append(...children);
    return footer;
  };
  /** The footer's quiet text button (the prototype's "Reset Item"). */
  const FOOTER_BUTTON =
    "px-2.5 py-1.5 rounded border-0 bg-transparent hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] cursor-pointer transition-colors shrink-0";
  /** "Back to catalog" shows only where the inspector is a drawer. */
  const BACK_BUTTON = `${FOOTER_BUTTON} min-[1101px]:hidden`;
  const inspectorSection = (label: string, ...children: Node[]): HTMLElement => {
    const section = inspectorNode("div", "flex flex-col gap-1.5 min-w-0");
    section.append(inspectorNode("span", INSPECTOR_LABEL, label), ...children);
    return section;
  };
  /** The prototype's "Upstream Provenance" key / value box. */
  const keyValueBox = (rows: readonly (readonly [string, string | Node])[]): HTMLElement => {
    const box = inspectorNode(
      "div",
      "p-2 rounded bg-surface-container-low border border-solid border-hairline font-mono text-[10px] flex flex-col gap-1 text-on-surface-variant min-w-0",
    );
    for (const [label, value] of rows) {
      const row = inspectorNode("div", "flex justify-between gap-3 min-w-0");
      const valueNode = inspectorNode("span", "text-on-surface text-right break-all min-w-0");
      valueNode.append(value);
      row.append(inspectorNode("span", "shrink-0", label), valueNode);
      box.append(row);
    }
    return box;
  };
  /** A "Declared Capabilities" row: icon and label, then the declared value. */
  const capabilityRow = (
    name: string,
    iconClass: string,
    label: string,
    value: string,
    valueClass = "text-on-surface-variant",
  ): HTMLElement => {
    const row = inspectorNode(
      "div",
      "p-2 rounded bg-surface-container-low border border-solid border-hairline flex flex-col gap-1 min-w-0",
    );
    const top = inspectorNode("div", "flex items-center gap-1.5 text-on-surface");
    top.append(glyph(name, `w-[14px] h-[14px] ${iconClass}`), inspectorNode("span", "", label));
    row.append(top, inspectorNode("p", `m-0 text-[11px] leading-snug ${valueClass}`, value));
    return row;
  };
  /** The tone of the prototype's security callout. */
  const CALLOUT_TONE = {
    warning: "bg-wb-review-bg border-wb-badge-border",
    positive: "bg-wb-pass-bg border-hairline",
    neutral: "bg-surface-container-low border-hairline",
  };
  const CALLOUT_TEXT = {
    warning: "text-tertiary",
    positive: "text-wb-pass",
    neutral: "text-on-surface",
  };
  /** The item's version as the head's chip: the source revision it was pinned at. */
  const assetVersion = (asset: AuthoringAssetV1): string =>
    options.bundle.sources[asset.sourceId]?.revision.id ?? asset.sourceRevisionId;
  /** The Security tab's scanner grid, from the analyzers the report names. */
  const analyzerGrid = (analyzers: readonly { name: string; version: string }[]): HTMLElement => {
    const grid = inspectorNode("div", "grid grid-cols-2 gap-1.5 text-[11px]");
    for (const analyzer of analyzers) {
      const cell = inspectorNode(
        "div",
        "p-2 rounded bg-surface-container-low border border-solid border-hairline flex items-center justify-between gap-2 min-w-0",
      );
      cell.append(
        inspectorNode("span", "text-on-surface font-medium truncate min-w-0", analyzer.name),
        inspectorNode(
          "span",
          "font-mono text-secondary text-[10px] font-semibold shrink-0",
          analyzer.version,
        ),
      );
      grid.append(cell);
    }
    return grid;
  };

  root.replaceChildren();
  root.classList.add("workbench-inventory");
  tw(root, "flex flex-col flex-1 min-w-0");
  /*
   * The draft summary has no prototype home. Its heading and intro name the
   * region for assistive technology; the counts and the draft / exposure
   * controls sit at the right of the filter bar, styled as the prototype's
   * "need review" and "send data out" pills.
   */
  draftSummary.className = "workbench-draft-summary";
  draftSummary.dataset.workbenchDraftSummary = "true";
  tw(draftSummary, "flex flex-wrap items-center gap-2 font-mono text-[10.5px] shrink-0 min-w-0");
  draftSummaryHeading.textContent = "Build your policy";
  draftSummaryIntro.textContent = "Choose items. Review their declarations and evidence.";
  tw(draftSummaryHeading, "sr-only");
  tw(draftSummaryIntro, "sr-only");
  counts.className = "workbench-draft-counts";
  // Where the prototype masthead has its "Source policy" segmented control.
  tw(
    counts,
    "m-0 flex items-center p-0.5 rounded border border-solid border-hairline bg-surface-container-lowest font-mono text-[11px] text-on-surface-variant whitespace-nowrap [&>span]:px-2.5 [&>span]:py-1 [&>span]:rounded",
  );
  counts.setAttribute("aria-live", "polite");
  exposureButton.type = "button";
  exposureButton.className = "workbench-exposure-open";
  tw(
    exposureButton,
    "px-2.5 py-1 rounded bg-surface-container border border-solid border-hairline text-on-surface-variant hover:text-on-surface flex items-center gap-1.5 shrink-0 transition-colors aria-expanded:text-primary",
  );
  exposureButton.dataset.workbenchExposureOpen = "true";
  exposureButton.setAttribute("aria-controls", details.id);
  exposureButton.setAttribute("aria-expanded", "false");
  exposureButton.textContent = "Policy exposure";
  exposureButton.prepend(glyph("arrow_outward", "w-3 h-3 text-tertiary"));
  draftReview.className = "workbench-draft-review";
  tw(draftReview, "flex shrink-0");
  draftReviewSummary.type = "button";
  draftReviewSummary.className = "workbench-draft-open";
  tw(
    draftReviewSummary,
    "px-2.5 py-1 rounded bg-wb-review-bg border border-solid border-wb-badge-border text-tertiary flex items-center gap-1.5 shrink-0 hover:border-tertiary transition-colors",
  );
  draftReviewSummary.dataset.workbenchDraftOpen = "true";
  draftReviewSummary.setAttribute("aria-controls", details.id);
  draftReviewSummary.textContent = "Review draft";
  draftReviewList.className = "workbench-draft-review-list";
  draftReview.append(draftReviewSummary);
  inspectorNavigation.className = "workbench-inspector-navigation";
  inspectorNavigation.setAttribute("aria-label", "Workbench panel views");
  for (const [view, label] of [
    ["item", "Item"],
    ["draft", "Draft"],
    ["exposure", "Exposure"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.workbenchPanelView = view;
    button.textContent = label;
    button.setAttribute("aria-controls", details.id);
    tw(
      button,
      "px-1.5 py-0.5 rounded border-0 bg-transparent text-outline hover:text-on-surface cursor-pointer transition-colors aria-pressed:bg-surface-container aria-pressed:text-primary aria-pressed:font-semibold",
    );
    inspectorNavigation.append(button);
  }
  // The inspector's view switch: a quiet mono row under the rail's tabs.
  tw(inspectorNavigation, "flex items-center gap-1 text-[10.5px] font-mono min-w-0");
  const inspectorNavigationLabel = document.createElement("span");
  tw(inspectorNavigationLabel, "text-outline uppercase tracking-wider text-[10px] mr-1");
  inspectorNavigationLabel.textContent = "View";
  inspectorNavigationLabel.setAttribute("aria-hidden", "true");
  inspectorNavigation.prepend(inspectorNavigationLabel);
  draftSummary.append(draftSummaryHeading, draftSummaryIntro, draftReview, exposureButton);
  catalogLayout.className = "workbench-catalog-layout";
  catalogLayout.dataset.workbenchCatalogLayout = "true";
  tw(catalogLayout, "flex flex-1 min-w-0");
  /*
   * The source list is the nav rail's "Catalog scopes" section
   * (admin-sources.html): each source is a scope card. Without a host (no
   * shell) it stays beside the register.
   */
  sourceRail.className = "workbench-source-rail";
  sourceRail.dataset.workbenchSourceRail = "true";
  tw(sourceRail, "flex flex-col gap-0.5 min-w-0");
  sourceRail.setAttribute("aria-labelledby", "workbench-source-rail-title");
  sourceRailHeading.id = "workbench-source-rail-title";
  sourceRailHeading.textContent = "Sources";
  tw(sourceRailHeading, "sr-only");
  catalogRegister.className = "workbench-catalog-register";
  catalogRegister.dataset.workbenchCatalogRegister = "true";
  tw(catalogRegister, "flex-1 flex flex-col gap-3 p-4 bg-wb-cards min-w-0");
  catalogRegister.setAttribute("aria-label", "Catalog register");
  inspectorScrim.className = "workbench-inspector-scrim";
  inspectorScrim.dataset.workbenchInspectorScrim = "true";
  inspectorScrim.setAttribute("aria-hidden", "true");
  inspectorScrim.hidden = true;
  templateSummary.textContent = "Starting points";
  templateList.className = "workbench-template-list";
  templates.className = "workbench-starting-points";
  tw(
    templateSummary,
    "cursor-pointer text-[10px] font-mono uppercase tracking-wider font-semibold text-outline",
  );
  tw(templateList, "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 pt-2");
  tw(
    templates,
    "rounded border border-solid border-hairline bg-wb-card px-3 py-2 text-[11px] text-on-surface-variant",
  );
  templates.append(templateSummary, templateList);
  draftSummaryControl.textContent = "Prepared local drafts";
  draftList.className = "workbench-draft-list";
  drafts.className = "workbench-drafts";
  tw(
    draftSummaryControl,
    "cursor-pointer text-[10px] font-mono uppercase tracking-wider font-semibold text-outline",
  );
  tw(drafts, "rounded border border-solid border-hairline bg-wb-card px-3 py-2 text-[11px]");
  drafts.append(draftSummaryControl, draftList);
  sourceTabs.className = "workbench-source-tabs";
  tw(sourceTabs, "flex flex-col gap-0.5 max-md:hidden");
  sourceTabs.setAttribute("aria-label", "Catalog sources");
  filters.className = "workbench-catalog-filters";
  const sourceLabel = document.createElement("label");
  sourceLabel.className = "workbench-source-picker";
  tw(filters, "md:hidden pt-2");
  tw(
    sourceLabel,
    "flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider font-semibold text-outline",
  );
  sourceLabel.textContent = "Choose source";
  sourceLabel.htmlFor = "workbench-source-filter";
  sourceLabel.append(sourceFilter);
  filters.append(sourceLabel);
  sourceFilter.setAttribute("aria-label", "Choose catalog source");
  sourceReview.className = "workbench-source-review";
  browseTools.className = "workbench-browse-tools";
  typeTabs.className = "workbench-type-tabs";
  tw(
    sourceFilter,
    "h-8 px-2 rounded border border-solid border-hairline bg-wb-card text-on-surface text-[12px] font-body normal-case tracking-normal font-normal",
  );
  tw(sourceReview, "flex flex-col gap-2 min-w-0");
  tw(
    browseTools,
    "px-5 py-2 border-0 border-b border-solid border-hairline bg-wb-subhead flex flex-wrap items-center justify-between gap-2 shrink-0 text-[11.5px]",
  );
  tw(typeTabs, "flex items-center gap-2 overflow-x-auto min-w-0");
  typeTabs.setAttribute("aria-label", "Catalog item types");
  // The prototype's search button, as the product's working search field.
  const searchBox = document.createElement("label");
  tw(searchBox, "relative flex items-center shrink-0 max-sm:w-full");
  searchBox.append(
    glyph("search", "absolute left-2.5 w-[15px] h-[15px] text-outline pointer-events-none"),
    search,
  );
  const browseStart = document.createElement("div");
  tw(browseStart, "flex items-center gap-2 flex-1 min-w-0 max-sm:flex-wrap");
  browseStart.append(searchBox, typeTabs);
  browseTools.append(browseStart, draftSummary);
  sourceFilter.id = "workbench-source-filter";
  sourceFilter.name = "workbench-source-filter";
  search.type = "search";
  search.id = "workbench-catalog-search";
  search.name = "workbench-catalog-search";
  search.placeholder = "Search catalog";
  search.setAttribute("aria-label", "Search catalog");
  tw(
    search,
    "h-8 max-sm:w-full sm:w-8 sm:focus:w-56 sm:[&:not(:placeholder-shown)]:w-56 pl-8 pr-1 rounded border border-solid border-hairline bg-wb-card hover:bg-surface-container text-on-surface text-[11.5px] font-mono placeholder:text-outline transition-all",
  );
  inventory.setAttribute("aria-label", "Catalog inventory");
  tw(inventory, "flex flex-col gap-3 min-w-0");
  browseResults.setAttribute("aria-label", "Catalog browse results");
  tw(browseResults, "flex flex-col gap-3 min-w-0");
  templates.setAttribute("aria-label", "Selection templates");
  repairs.setAttribute("aria-label", "Saved selections needing review");
  tw(repairs, "flex flex-col gap-1.5 text-[12px] text-on-surface-variant");
  drafts.setAttribute("aria-label", "Prepared local drafts");
  diagnostics.className = "help error";
  tw(diagnostics, "m-0 px-5 py-1.5 text-[11.5px] text-error empty:hidden");
  // The prototype masthead: kicker (the screen title), the source's name and
  // its meta line.
  const masthead = document.createElement("header");
  masthead.dataset.wbSourcesMasthead = "";
  tw(
    masthead,
    "px-5 pb-3 border-0 border-b border-solid border-hairline bg-wb-subhead flex flex-col gap-2 shrink-0 min-w-0",
  );
  const draftCounts = document.createElement("div");
  tw(draftCounts, "flex items-center gap-2 shrink-0");
  const draftLabel = document.createElement("span");
  tw(
    draftLabel,
    "text-[10.5px] font-mono text-outline uppercase tracking-wider hidden sm:inline-block",
  );
  draftLabel.textContent = "Draft:";
  draftLabel.setAttribute("aria-hidden", "true");
  draftCounts.append(draftLabel, counts);
  // renderSourceSummary places the counts on the source's title line.
  sourceReview.append(draftCounts);
  masthead.append(sourceReview, filters);
  sourceRail.append(sourceRailHeading, sourceTabs);
  catalogRegister.append(inventory, templates, repairs, drafts);
  catalogLayout.append(catalogRegister);
  if (options.inspectorHost !== undefined)
    options.inspectorHost.replaceChildren(details, inspectorScrim);
  else catalogLayout.append(details, inspectorScrim);
  if (options.mountSourceRail !== undefined) options.mountSourceRail(sourceRail);
  else catalogLayout.prepend(sourceRail);
  root.append(masthead, browseTools, diagnostics, catalogLayout);

  /*
   * S4: in the new shell the inspector lives in the inspector rail, outside
   * `root`; lookups and the delegated click handler cover both.
   */
  const scopes: readonly HTMLElement[] =
    options.inspectorHost !== undefined ? [root, details] : [root];
  const scopeAll = <T extends Element>(selector: string): T[] =>
    scopes.flatMap((scope) => [...scope.querySelectorAll<T>(selector)]);
  const scopeOne = <T extends Element>(selector: string): T | null =>
    scopeAll<T>(selector)[0] ?? null;
  const compactInspector = window.matchMedia("(max-width: 1100px)");
  const modalInertElements = new Set<HTMLElement>();
  const clearModalInert = (): void => {
    for (const element of modalInertElements) element.removeAttribute("inert");
    modalInertElements.clear();
  };
  const setOutsideInspectorInert = (): void => {
    clearModalInert();
    let branch: HTMLElement = details;
    while (true) {
      const parent = branch.parentElement;
      if (parent === null) break;
      for (const sibling of parent.children) {
        if (
          sibling === branch ||
          sibling === inspectorScrim ||
          !(sibling instanceof HTMLElement) ||
          sibling.hasAttribute("inert")
        )
          continue;
        sibling.setAttribute("inert", "");
        modalInertElements.add(sibling);
      }
      branch = parent;
    }
  };
  const syncInspectorPresentation = (): void => {
    const head = details.querySelector<HTMLElement>(":scope > [data-wb-inspector-head]");
    if (head !== null) head.append(inspectorNavigation);
    else details.prepend(inspectorNavigation);
    for (const button of inspectorNavigation.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.workbenchPanelView === inspectorMode),
      );
      if (button.dataset.workbenchPanelView === "draft")
        button.textContent = `Draft (${draftEntryCount})`;
    }
    draftReviewSummary.setAttribute(
      "aria-expanded",
      String(inspectorMode === "draft" && inspectorOpen),
    );
    const modal = compactInspector.matches && inspectorOpen;
    details.dataset.workbenchInspectorOpen = String(inspectorOpen);
    if (inspectorOpen) options.revealInspector?.();
    if (modal) {
      details.setAttribute("role", "dialog");
      details.setAttribute("aria-modal", "true");
    } else {
      details.removeAttribute("role");
      details.removeAttribute("aria-modal");
    }
    inspectorScrim.hidden = !modal;
    if (modal) setOutsideInspectorInert();
    else clearModalInert();
    exposureButton.setAttribute(
      "aria-expanded",
      String(
        details.dataset.workbenchInspectorView === "exposure" &&
          (!compactInspector.matches || inspectorOpen),
      ),
    );
    for (const button of scopeAll<HTMLButtonElement>("[data-workbench-expand-id]"))
      button.setAttribute(
        "aria-expanded",
        String(
          button.dataset.workbenchExpandId === expandedAssetId &&
            (!compactInspector.matches || inspectorOpen),
        ),
      );
  };
  compactInspector.addEventListener("change", syncInspectorPresentation, {
    signal: teardown.signal,
  });
  syncInspectorPresentation();

  const renderItemPlaceholder = (): void => {
    const heading = document.createElement("h3");
    const hint = document.createElement("p");
    heading.id = "workbench-detail-title";
    heading.tabIndex = -1;
    heading.textContent = "Item details";
    hint.textContent = "Select an item name to review its purpose, declared access and checks.";
    details.dataset.workbenchInspectorView = "item";
    details.removeAttribute("data-workbench-inspector-asset-id");
    details.setAttribute("aria-labelledby", heading.id);
    // Empty state: what to do, what the draft holds, what each tab shows.
    const empty = inspectorNode(
      "div",
      "p-3 rounded border border-dashed border-hairline bg-surface-container-low flex items-start gap-2.5",
    );
    tw(hint, "m-0 text-[11.5px] leading-relaxed text-on-surface");
    empty.append(glyph("info", "w-4 h-4 text-primary mt-0.5"), hint);
    const counts = workbenchSelectionCounts(options.bundle, state);
    const draft = inspectorSection(
      "In this draft",
      keyValueBox([
        ["Controls", String(counts.selectedControlCount)],
        ["Selections", String(counts.rootCount)],
        ["Requests", String(counts.requestCount)],
        ["Catalog items", String(Object.keys(options.bundle.assets).length)],
      ]),
    );
    const guide = inspectorNode("div", "flex flex-col gap-1 text-[11px]");
    for (const [name, iconName, text] of [
      ["Details", "info", "The publisher's purpose, declared access and provenance."],
      ["Security", "radar", "The attached scan report, its analyzers and findings."],
      ["Policy JSON", "code", "The prepared record behind the item, as JSON."],
    ] as const) {
      const row = inspectorNode(
        "div",
        "p-2 rounded bg-surface-container-low border border-solid border-hairline flex items-start gap-1.5 min-w-0",
      );
      const copy = inspectorNode("span", "min-w-0");
      copy.append(
        inspectorNode("span", "font-medium text-on-surface", name),
        inspectorNode("span", "text-outline", " · " + text),
      );
      row.append(glyph(iconName, "w-[14px] h-[14px] text-primary mt-px"), copy);
      guide.append(row);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "workbench-exposure-back";
    tw(back, BACK_BUTTON);
    back.dataset.workbenchDetailsClose = "true";
    back.textContent = "Back to catalog";
    details.replaceChildren(
      inspectorHead({ heading, tone: "neutral", meta: ["No item selected"] }),
      inspectorBody(empty, draft, inspectorSection("What each tab shows", guide)),
      ...(inspectorOpen ? [inspectorFooter(back)] : []),
    );
    syncInspectorPresentation();
  };
  const renderIdleInspector = (): void => {
    if (inspectorMode === "draft") renderDraftReview();
    else if (inspectorMode === "exposure") renderExposureOverview();
    else renderItemPlaceholder();
  };

  const refreshCounts = (): void => {
    const value = workbenchSelectionCounts(options.bundle, state);
    const controls = document.createElement("span");
    const selections = document.createElement("span");
    const requests = document.createElement("span");
    // Mono label + figure, like the prototype's "SORT: NAME (A-Z)" line.
    const count = (node: HTMLElement, label: string, figure: number, help: string): void => {
      const strong = document.createElement("strong");
      tw(strong, "text-on-surface font-semibold");
      strong.textContent = String(figure);
      node.append(label + " ", strong);
      node.title = help;
    };
    count(
      controls,
      "Controls",
      value.selectedControlCount,
      "Controls selected directly in this portable draft.",
    );
    count(
      selections,
      "Selections",
      value.rootCount,
      "Choices saved in this portable draft, including grouping context.",
    );
    count(
      requests,
      "Requests",
      value.requestCount,
      "Items awaiting later Core review, not active controls.",
    );
    counts.replaceChildren(controls, selections, requests);
    renderSourceSummary();
  };

  const showDiagnostics = (result: WorkbenchReductionV1): void => {
    diagnostics.textContent =
      result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ?? "";
  };
  const renderPageControls = (
    host: HTMLElement,
    page: number,
    total: number,
    onPage: (next: number) => void,
    focusFallback?: HTMLElement,
    placement: "before" | "after" = "after",
  ): void => {
    if (total <= PAGE_SIZE && placement === "after") return;
    const controls = document.createElement("div");
    controls.className = "workbench-page-controls";
    tw(controls, "flex flex-wrap items-center gap-2 text-[11px] font-mono text-outline pb-1");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Result pages");
    const previous = document.createElement("button");
    const next = document.createElement("button");
    const changePage = (direction: "previous" | "next", nextPage: number): void => {
      onPage(nextPage);
      const replacement = host.querySelector<HTMLButtonElement>(
        '[data-workbench-page-control="' + direction + '"]',
      );
      if (replacement !== null && replacement.isConnected && !replacement.disabled)
        replacement.focus();
      else {
        const available = host.querySelector<HTMLButtonElement>(
          "[data-workbench-page-control]:not(:disabled)",
        );
        if (available !== null) available.focus();
        else focusFallback?.focus();
      }
    };
    previous.type = "button";
    previous.dataset.workbenchPageControl = "previous";
    next.type = "button";
    next.dataset.workbenchPageControl = "next";
    previous.textContent = "Previous 50";
    next.textContent = "Next 50";
    previous.className = next.className = "workbench-page-control";
    const PAGE_BUTTON =
      "px-2 py-0.5 rounded font-mono text-[10.5px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface border border-solid border-hairline transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
    tw(previous, PAGE_BUTTON);
    tw(next, PAGE_BUTTON);
    previous.disabled = page === 0;
    next.disabled = (page + 1) * PAGE_SIZE >= total;
    previous.addEventListener("click", () => changePage("previous", page - 1), {
      signal: teardown.signal,
    });
    next.addEventListener("click", () => changePage("next", page + 1), {
      signal: teardown.signal,
    });
    const range = document.createElement("span");
    range.setAttribute("role", "status");
    // admin-sources.html results line: "<strong>21</strong> of 278 skills".
    const shown = document.createElement("strong");
    tw(shown, "text-wb-heading font-bold");
    shown.textContent = `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)}`;
    range.append("Showing ", shown, ` of ${total} items`);
    controls.append(range);
    if (total > PAGE_SIZE) {
      const pageLabel = document.createElement("span");
      pageLabel.textContent = `Page ${page + 1} of ${Math.ceil(total / PAGE_SIZE)}`;
      controls.append(previous, pageLabel, next);
    }
    if (placement === "before") host.prepend(controls);
    else host.append(controls);
  };

  const updateDetailButtons = (): void => {
    for (const button of scopeAll<HTMLButtonElement>("[data-workbench-detail-id]"))
      button.setAttribute(
        "aria-expanded",
        String(openDetailKey === "asset:" + button.dataset.workbenchDetailId),
      );
    for (const button of scopeAll<HTMLButtonElement>("[data-workbench-template-detail-id]"))
      button.setAttribute(
        "aria-expanded",
        String(openDetailKey === "template:" + button.dataset.workbenchTemplateDetailId),
      );
  };
  const renderExposureOverview = ({ focusHeading = false } = {}): void => {
    const resolved = resolveWorkbenchSelection(options.bundle, state);
    const selectedAssets = resolved.assetIds
      .map((assetId) => options.bundle.assets[assetId])
      .filter((asset): asset is AuthoringAssetV1 => asset !== undefined)
      .sort((left, right) => compareText(assetLabel(left), assetLabel(right)));
    const exactRequests: Array<{
      asset: AuthoringAssetV1;
      origin: WorkbenchOriginV1;
    }> = [];
    let missingRequests = 0;
    let staleRequests = 0;
    for (const request of state.requests) {
      const asset = options.bundle.assets[request.assetId];
      if (asset === undefined) {
        missingRequests++;
        continue;
      }
      if (
        asset.sourceId !== request.sourceId ||
        asset.sourceRevisionId !== request.sourceRevisionId ||
        asset.contentDigest !== request.contentDigest
      ) {
        staleRequests++;
        continue;
      }
      exactRequests.push({ asset, origin: request.origin });
    }
    exactRequests.sort(
      (left, right) =>
        compareText(assetLabel(left.asset), assetLabel(right.asset)) ||
        compareText(originKey(left.origin), originKey(right.origin)),
    );
    const missingPins = resolved.missingAssetIds.length + missingRequests;
    const stalePins = resolved.staleAssetIds.length + staleRequests;
    const unresolvedPins = missingPins + stalePins;
    const verifiedReports = selectedAssets.filter(
      (asset) => assetEvidencePresentation(asset, options.bundle).state === "verified",
    ).length;
    exposureSelectedPage = Math.min(
      exposureSelectedPage,
      Math.max(0, Math.ceil(selectedAssets.length / EXPOSURE_PAGE_SIZE) - 1),
    );
    exposureRequestPage = Math.min(
      exposureRequestPage,
      Math.max(0, Math.ceil(exactRequests.length / EXPOSURE_PAGE_SIZE) - 1),
    );

    const overview = document.createElement("section");
    const header = document.createElement("header");
    const heading = document.createElement("h3");
    const close = document.createElement("button");
    const intro = document.createElement("p");
    const scope = document.createElement("p");
    const exposureCounts = document.createElement("div");
    const limits = document.createElement("p");
    const selectedGroup = document.createElement("section");
    const selectedHeading = document.createElement("h4");
    const selectedList = document.createElement("div");
    const requestGroup = document.createElement("section");
    const requestHeading = document.createElement("h4");
    const requestIntro = document.createElement("p");
    const requestList = document.createElement("div");
    // The inspector's exposure view, in admin-item.html's language: a titled
    // head, mono-labelled sections, tiles and bordered declaration cards.
    overview.className = "workbench-exposure-overview";
    tw(overview, "flex flex-col gap-3 min-w-0");
    overview.dataset.workbenchExposureOverview = "true";
    header.className = "workbench-exposure-header";
    tw(header, "flex flex-col gap-1 min-w-0");
    heading.id = "workbench-detail-title";
    heading.tabIndex = -1;
    heading.textContent = "A policy is a shape of exposure";
    tw(heading, "m-0 font-semibold text-on-surface text-[13px] font-mono");
    close.type = "button";
    close.className = "workbench-inspector-close";
    tw(close, FOOTER_BUTTON);
    close.dataset.workbenchDetailsClose = "true";
    close.textContent = "Close details";
    header.append(inspectorNode("span", INSPECTOR_LABEL, "Policy exposure"), heading);
    intro.className = "workbench-exposure-intro";
    tw(intro, "m-0 text-[11px] text-on-surface-variant leading-snug");
    intro.textContent =
      "Access declared by your catalog choices. Setup and host permissions determine actual access.";
    scope.className = "workbench-exposure-scope";
    tw(scope, "m-0 text-[11px] text-outline leading-snug");
    scope.textContent = "Developer tools: see Deployment setup.";
    exposureCounts.className = "workbench-exposure-counts";
    tw(exposureCounts, "grid grid-cols-2 gap-1.5 min-w-0");
    exposureCounts.setAttribute("aria-label", "Catalog exposure counts");
    const appendCount = (
      kind: "selected" | "requests" | "unresolved" | "verified",
      label: string,
      value: number,
      title: string,
    ): void => {
      const count = document.createElement("p");
      const number = document.createElement("strong");
      const caption = document.createElement("span");
      count.className = "workbench-exposure-count";
      tw(
        count,
        "m-0 p-2.5 rounded bg-surface-container-low border border-solid border-hairline flex flex-col gap-1 min-w-0",
      );
      count.dataset.workbenchExposureCount = kind;
      count.title = title;
      number.textContent = String(value);
      tw(
        number,
        "text-[22px] leading-none font-semibold font-mono tabular-nums tracking-tight text-wb-heading",
      );
      caption.textContent = label;
      tw(caption, "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold");
      count.append(number, caption);
      exposureCounts.append(count);
    };
    appendCount(
      "selected",
      "Selected items",
      selectedAssets.length,
      "Catalog items currently resolved from saved choices and dependency relations.",
    );
    appendCount(
      "requests",
      "Current pending requests",
      exactRequests.length,
      "Saved requests that exactly match the current catalog. Requests do not select or activate items.",
    );
    appendCount(
      "unresolved",
      "Unresolved pins",
      unresolvedPins,
      `${missingPins} missing and ${stalePins} changed catalog pins.`,
    );
    appendCount(
      "verified",
      "Items with verified reports",
      verifiedReports,
      "Selected items with Core-verified evidence for the current version. This is not organization approval.",
    );
    limits.className = "workbench-exposure-limits";
    tw(
      limits,
      "m-0 p-2.5 rounded border border-solid border-wb-badge-border bg-wb-review-bg text-[11px] text-on-surface-variant leading-snug",
    );
    limits.textContent =
      "Destinations, file access and credential scope may be unspecified. Review each item’s declaration and checks.";
    selectedGroup.className = "workbench-exposure-group";
    tw(selectedGroup, "flex flex-col gap-1.5 min-w-0");
    selectedHeading.textContent = "Selected item declarations";
    tw(selectedHeading, INSPECTOR_LABEL);
    selectedList.className = "workbench-exposure-list";
    tw(selectedList, "flex flex-col gap-1.5 min-w-0");
    selectedList.dataset.workbenchExposureList = "true";
    requestGroup.className = "workbench-exposure-group";
    tw(requestGroup, "flex flex-col gap-1.5 min-w-0");
    requestHeading.textContent = "Pending requests";
    tw(requestHeading, INSPECTOR_LABEL);
    requestIntro.textContent = "Saved for follow-up. Requests do not select or activate items.";
    tw(requestIntro, "m-0 text-[11px] text-outline leading-snug");
    requestList.className = "workbench-exposure-list";
    tw(requestList, "flex flex-col gap-1.5 min-w-0");
    requestList.dataset.workbenchExposureRequests = "true";

    const appendAsset = (
      host: HTMLElement,
      asset: AuthoringAssetV1,
      requestOrigin?: WorkbenchOriginV1,
    ): void => {
      const item = document.createElement("article");
      const inspect = document.createElement("button");
      const meta = document.createElement("p");
      const access = document.createElement("p");
      const evidence = document.createElement("p");
      const label = humanizedAssetLabel(asset);
      const declaration = assetDecisionPresentation(asset, options.bundle);
      const checks = assetEvidencePresentation(asset, options.bundle);
      item.className = "workbench-exposure-item";
      tw(
        item,
        "p-2.5 rounded bg-surface-container-low border border-solid border-hairline flex flex-col gap-1 min-w-0",
      );
      if (requestOrigin === undefined) item.dataset.workbenchExposureItemId = asset.id;
      else item.dataset.workbenchExposureRequestId = asset.id;
      inspect.type = "button";
      inspect.className = "workbench-exposure-inspect";
      tw(
        inspect,
        "self-start p-0 border-0 bg-transparent text-left font-mono font-bold text-[12px] text-primary hover:underline cursor-pointer",
      );
      inspect.dataset.workbenchExposureInspectId = asset.id;
      inspect.setAttribute("aria-controls", details.id);
      inspect.setAttribute("aria-label", "Inspect declaration and checks for " + label);
      inspect.textContent = label;
      meta.className = "workbench-exposure-meta";
      tw(meta, "m-0 font-mono text-[10px] text-outline");
      meta.textContent =
        catalogSourceDisplayName(options.bundle, asset.sourceId) +
        (requestOrigin === undefined ? "" : " · " + originLabel(requestOrigin));
      access.className = "workbench-exposure-access";
      tw(access, "m-0 text-[11px] text-on-surface-variant leading-snug");
      access.dataset.workbenchExposureAccess = "true";
      access.textContent = "Declared access: " + declaration.access;
      evidence.className = "workbench-exposure-evidence";
      tw(
        evidence,
        "m-0 self-start px-1.5 py-0.5 rounded font-mono text-[10px] font-medium bg-surface-container text-on-surface-variant data-[workbench-evidence-tone=positive]:bg-wb-pass-bg data-[workbench-evidence-tone=positive]:text-wb-pass data-[workbench-evidence-tone=warning]:bg-wb-review-bg data-[workbench-evidence-tone=warning]:text-wb-review",
      );
      evidence.dataset.workbenchExposureEvidence = "true";
      evidence.dataset.workbenchEvidenceTone = checks.tone;
      evidence.textContent = "Checks: " + checks.statusLabel;
      item.append(inspect, meta, access, evidence);
      host.append(item);
    };
    const appendPager = (
      host: HTMLElement,
      kind: "selected" | "requests",
      page: number,
      total: number,
      onPage: (next: number) => void,
    ): void => {
      if (total <= EXPOSURE_PAGE_SIZE) return;
      const pages = document.createElement("div");
      const previous = document.createElement("button");
      const status = document.createElement("span");
      const next = document.createElement("button");
      pages.className = "workbench-exposure-pages";
      tw(pages, "flex items-center gap-2 text-[10.5px] font-mono text-outline");
      pages.setAttribute("role", "group");
      pages.setAttribute(
        "aria-label",
        `${kind === "selected" ? "Selected item" : "Pending request"} pages`,
      );
      const changePage = (nextPage: number, direction: "previous" | "next"): void => {
        onPage(nextPage);
        renderExposureOverview();
        const preferred = details.querySelector<HTMLButtonElement>(
          `[data-workbench-exposure-page="${kind}-${direction}"]`,
        );
        const available = details.querySelector<HTMLButtonElement>(
          `[data-workbench-exposure-page^="${kind}-"]:not(:disabled)`,
        );
        if (preferred !== null && !preferred.disabled) preferred.focus();
        else if (available !== null) available.focus();
        else details.querySelector<HTMLElement>("#workbench-detail-title")?.focus();
      };
      previous.type = "button";
      previous.className = "btn sm secondary";
      previous.dataset.workbenchExposurePage = `${kind}-previous`;
      previous.textContent = "Previous";
      previous.disabled = page === 0;
      previous.addEventListener("click", () => changePage(page - 1, "previous"), {
        signal: teardown.signal,
      });
      status.textContent = `${page * EXPOSURE_PAGE_SIZE + 1}–${Math.min((page + 1) * EXPOSURE_PAGE_SIZE, total)} of ${total}`;
      next.type = "button";
      next.className = "btn sm secondary";
      next.dataset.workbenchExposurePage = `${kind}-next`;
      next.textContent = "Next";
      next.disabled = (page + 1) * EXPOSURE_PAGE_SIZE >= total;
      next.addEventListener("click", () => changePage(page + 1, "next"), {
        signal: teardown.signal,
      });
      pages.append(previous, status, next);
      host.append(pages);
    };

    const selectedStart = exposureSelectedPage * EXPOSURE_PAGE_SIZE;
    for (const asset of selectedAssets.slice(selectedStart, selectedStart + EXPOSURE_PAGE_SIZE))
      appendAsset(selectedList, asset);
    if (selectedAssets.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No catalog items are selected.";
      selectedList.append(empty);
    }
    selectedGroup.append(selectedHeading, selectedList);
    appendPager(selectedGroup, "selected", exposureSelectedPage, selectedAssets.length, (next) => {
      exposureSelectedPage = next;
    });
    const requestStart = exposureRequestPage * EXPOSURE_PAGE_SIZE;
    for (const request of exactRequests.slice(requestStart, requestStart + EXPOSURE_PAGE_SIZE))
      appendAsset(requestList, request.asset, request.origin);
    if (exactRequests.length === 0) {
      const empty = document.createElement("p");
      empty.textContent =
        missingRequests + staleRequests > 0
          ? `No requests match the current catalog; ${missingRequests + staleRequests} saved request${missingRequests + staleRequests === 1 ? " needs" : "s need"} version review.`
          : "No current catalog requests are pending.";
      requestList.append(empty);
    }
    requestGroup.append(requestHeading, requestIntro, requestList);
    appendPager(requestGroup, "requests", exposureRequestPage, exactRequests.length, (next) => {
      exposureRequestPage = next;
    });
    overview.append(header, intro, scope, exposureCounts, limits, selectedGroup, requestGroup);
    details.removeAttribute("data-workbench-inspector-asset-id");
    details.dataset.workbenchInspectorView = "exposure";
    inspectorMode = "exposure";
    details.setAttribute("aria-labelledby", heading.id);
    details.replaceChildren(inspectorHead(), inspectorBody(overview), inspectorFooter(close));
    syncInspectorPresentation();
    if (focusHeading) heading.focus();
  };
  const closeDetails = (): void => {
    const trigger = detailTrigger;
    const triggerIdentity =
      trigger === undefined
        ? undefined
        : {
            assetId: trigger.dataset.workbenchAssetId,
            detailId: trigger.dataset.workbenchDetailId,
            expandId: trigger.dataset.workbenchExpandId,
            exposureInspectId: trigger.dataset.workbenchExposureInspectId,
            exposureOpen: trigger.dataset.workbenchExposureOpen,
            rowAction:
              trigger.dataset.workbenchRowAction ?? trigger.dataset.workbenchInspectorAction,
            inDraftReview: draftReviewList.contains(trigger),
          };
    openDetailKey = undefined;
    openCatalogDetail = undefined;
    detailTrigger = undefined;
    expandedAssetId = undefined;
    comparisonPreview = undefined;
    inspectorOpen = false;
    inspectorMode = "item";
    draftReviewList.replaceChildren();
    syncInspectorPresentation();
    updateDetailButtons();
    renderItemPlaceholder();
    const replacement =
      trigger?.isConnected === true
        ? trigger
        : [...scopeAll<HTMLButtonElement>("button")].find((button) => {
            if (triggerIdentity?.inDraftReview === true)
              return button.dataset.workbenchDetailId === triggerIdentity.detailId;
            if (triggerIdentity?.expandId !== undefined)
              return button.dataset.workbenchExpandId === triggerIdentity.expandId;
            if (triggerIdentity?.exposureInspectId !== undefined)
              return (
                button.dataset.workbenchExposureInspectId === triggerIdentity.exposureInspectId
              );
            if (triggerIdentity?.exposureOpen !== undefined)
              return button.dataset.workbenchExposureOpen !== undefined;
            if (triggerIdentity?.rowAction !== undefined)
              return (
                button.dataset.workbenchAssetId === triggerIdentity.assetId &&
                button.dataset.workbenchRowAction !== undefined
              );
            return (
              triggerIdentity?.detailId !== undefined &&
              button.dataset.workbenchExpandId === triggerIdentity.detailId
            );
          });
    const visibleReplacement =
      compactInspector.matches && replacement !== undefined && details.contains(replacement)
        ? exposureButton
        : replacement;
    if (visibleReplacement !== undefined) visibleReplacement.focus();
    else search.focus();
  };
  const renderDetails = (
    presentation: ReturnType<typeof assetDetailsPresentation>,
    {
      catalogAsset,
      referenceAsset,
      focusHeading = false,
      preserveFocus = false,
    }: {
      catalogAsset?: AuthoringAssetV1;
      referenceAsset?: AuthoringAssetV1;
      focusHeading?: boolean;
      preserveFocus?: boolean;
    },
  ): void => {
    const active = document.activeElement;
    const advancedWasOpen =
      preserveFocus &&
      details.querySelector<HTMLDetailsElement>(".workbench-detail-advanced")?.open === true;
    const focusTarget =
      preserveFocus && active instanceof HTMLElement
        ? active.matches("[data-workbench-details-close]")
          ? "close"
          : active.closest(".workbench-detail-advanced") !== null
            ? "advanced"
            : active.matches("#workbench-detail-title")
              ? "heading"
              : undefined
        : undefined;
    const heading = document.createElement("h3");
    const back = document.createElement("button");
    const close = document.createElement("button");
    const summary = document.createElement("p");
    const facts = document.createElement("dl");
    const advanced = document.createElement("details");
    const advancedSummary = document.createElement("summary");
    const raw = document.createElement("pre");
    heading.id = "workbench-detail-title";
    heading.tabIndex = -1;
    heading.textContent = presentation.title;
    details.setAttribute("aria-labelledby", heading.id);
    back.type = "button";
    back.className = "workbench-exposure-back";
    tw(back, BACK_BUTTON);
    back.dataset.workbenchDetailsClose = "true";
    back.textContent = "Back to catalog";
    close.type = "button";
    tw(close, FOOTER_BUTTON);
    close.dataset.workbenchDetailsClose = "true";
    close.textContent = "Close details";
    summary.className = "workbench-detail-summary";
    tw(summary, "m-0 text-on-surface leading-relaxed text-[11px]");
    summary.textContent = presentation.summary;
    facts.className = "workbench-detail-facts";
    tw(facts, WB_FACTS);
    for (const fact of presentation.facts) {
      const term = document.createElement("dt");
      const definition = document.createElement("dd");
      term.textContent = fact.label;
      definition.textContent = fact.value;
      facts.append(term, definition);
    }
    const previousReport =
      referenceAsset === undefined
        ? undefined
        : previousCatalogReportPresentation(
            referenceAsset,
            options.bundle,
            options.referenceReports?.[referenceAsset.id],
          );
    const previousReportSection =
      previousReport === undefined ? undefined : previousCatalogReportElement(previousReport);
    const catalogContext: HTMLElement[] = [];
    if (catalogAsset !== undefined) {
      const decision = assetDecisionPresentation(catalogAsset, options.bundle);
      const evidence = assetEvidencePresentation(catalogAsset, options.bundle);
      const declaration = document.createElement("section");
      const declarationHeading = document.createElement("h4");
      const purpose = document.createElement("p");
      const access = document.createElement("p");
      const checks = document.createElement("section");
      const checksHeading = document.createElement("h4");
      const checksStatus = document.createElement("p");
      const checksBinding = document.createElement("p");
      const checksNextStep = document.createElement("p");
      const checksLimitation = document.createElement("p");
      declaration.className = "workbench-expanded-why";
      tw(declaration, "flex flex-col gap-1.5 min-w-0");
      declaration.dataset.workbenchDeclaration = "true";
      declarationHeading.textContent = "Source declaration";
      tw(declarationHeading, INSPECTOR_LABEL);
      purpose.textContent = decision.purpose;
      tw(purpose, "sr-only");
      access.textContent = "Declared access: " + decision.access;
      tw(access, "sr-only");
      declaration.append(
        declarationHeading,
        purpose,
        access,
        capabilityRow("wifi", "text-primary", "What it can access", decision.access),
      );
      checks.className = "workbench-evidence-sheet";
      tw(checks, "flex flex-col gap-1.5 min-w-0 scroll-mt-32");
      checks.dataset.workbenchChecks = "true";
      checks.dataset.workbenchEvidenceState = evidence.state;
      checks.dataset.workbenchEvidenceTone = evidence.tone;
      checksHeading.textContent = "Checks";
      tw(checksHeading, INSPECTOR_LABEL);
      checksStatus.textContent = evidence.statusLabel;
      tw(checksStatus, `m-0 font-semibold text-[11px] ${CALLOUT_TEXT[evidence.tone]}`);
      checksBinding.textContent = evidence.binding;
      checksNextStep.textContent =
        (evidence.state === "unverified" ? "Verification: " : "Next step: ") + evidence.nextStep;
      checksLimitation.textContent = evidence.limitation;
      for (const line of [checksBinding, checksNextStep, checksLimitation])
        tw(line, "m-0 text-[11px] text-on-surface-variant leading-snug");
      const checksCallout = inspectorNode(
        "div",
        `p-2.5 rounded border border-solid flex flex-col gap-1 min-w-0 ${CALLOUT_TONE[evidence.tone]}`,
      );
      checksCallout.append(checksStatus, checksBinding, checksNextStep, checksLimitation);
      checks.append(checksHeading, checksCallout);
      if (evidence.sourceItemReports !== undefined)
        checks.append(sourceItemReportsElement(evidence.sourceItemReports));
      catalogContext.push(declaration, checks);
    }
    advanced.className = "workbench-detail-advanced";
    tw(
      advanced,
      "rounded border border-solid border-hairline bg-surface-container-low min-w-0 scroll-mt-32",
    );
    advanced.open = advancedWasOpen;
    advancedSummary.textContent = "More technical details";
    tw(advancedSummary, `${INSPECTOR_LABEL} px-2 py-1.5 cursor-pointer`);
    raw.textContent = presentation.advancedJson;
    advanced.append(advancedSummary, facts, raw);
    inspectorMode = "item";
    details.dataset.workbenchInspectorView = "details";
    const detailAsset = catalogAsset ?? referenceAsset;
    const detailEvidence =
      detailAsset === undefined
        ? undefined
        : assetEvidencePresentation(detailAsset, options.bundle);
    details.replaceChildren(
      inspectorHead({
        heading,
        tone: detailEvidence?.tone ?? "neutral",
        ...(detailAsset === undefined
          ? { meta: ["Full record"] }
          : {
              version: assetVersion(detailAsset),
              kind: detailAsset.kind,
              meta: [catalogSourceDisplayName(options.bundle, detailAsset.sourceId), "Full record"],
            }),
      }),
      inspectorBody(
        sectionsOf(
          inspectorSection("Publisher overview", summary),
          ...(previousReportSection === undefined ? [] : [previousReportSection]),
          ...catalogContext,
          advanced,
        ),
      ),
      inspectorFooter(back, close),
    );
    syncInspectorPresentation();
    if (focusHeading) heading.focus();
    else if (focusTarget === "close") close.focus();
    else if (focusTarget === "advanced") advancedSummary.focus();
    else if (focusTarget === "heading") heading.focus();
  };
  const invalidateTemplatePreview = (): void => {
    if (openDetailKey?.startsWith("template:")) closeDetails();
  };
  const developerToolDetailsPresentation = (
    asset: AuthoringAssetV1,
  ): ReturnType<typeof assetDetailsPresentation> => {
    const catalog = assetDetailsPresentation(asset, options.bundle);
    return {
      ...catalog,
      facts: catalog.facts.flatMap((fact) => {
        if (fact.label === "Why this needs follow-up") return [];
        if (fact.label === "If you add this")
          return [
            {
              label: "Setup selection",
              value:
                "Choose or exclude this tool in Developer tool setup. Viewing its catalog details does not add a catalog choice or request.",
            },
          ];
        if (fact.label === "Policy support") return [{ ...fact, label: "Catalog policy support" }];
        if (fact.label === "Security review")
          return [{ ...fact, label: "Catalog security review" }];
        return [fact];
      }),
    };
  };
  const acceptState = (nextState: WorkbenchStateV1): void => {
    invalidateTemplatePreview();
    comparisonPreview = undefined;
    state = nextState;
    draftReviewPage = 0;
    exposureSelectedPage = 0;
    exposureRequestPage = 0;
  };

  const showDetails = (
    key: string,
    presentation: ReturnType<typeof assetDetailsPresentation>,
    trigger: HTMLButtonElement,
    catalogDetail?: {
      asset: AuthoringAssetV1;
      mode: "catalog" | "developer-tool-setup";
    },
  ): void => {
    if (openDetailKey === key && inspectorOpen) {
      closeDetails();
      return;
    }
    openDetailKey = key;
    expandedAssetId = undefined;
    if (key.startsWith("asset:")) {
      lastInspectedAssetId = key.slice("asset:".length);
      lastFullDetail = {
        key,
        presentation,
        ...(catalogDetail === undefined ? {} : { catalogDetail }),
      };
    }
    openCatalogDetail =
      catalogDetail === undefined
        ? undefined
        : { assetId: catalogDetail.asset.id, mode: catalogDetail.mode };
    detailTrigger = trigger;
    inspectorOpen = true;
    if (key.startsWith("asset:")) details.dataset.workbenchInspectorAssetId = key.slice(6);
    else details.removeAttribute("data-workbench-inspector-asset-id");
    const referenceAsset = key.startsWith("asset:")
      ? options.bundle.assets[key.slice("asset:".length)]
      : undefined;
    renderDetails(presentation, {
      catalogAsset: catalogDetail?.asset,
      referenceAsset,
      focusHeading: true,
    });
    updateDetailButtons();
  };

  details.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && inspectorOpen) {
        event.preventDefault();
        closeDetails();
        return;
      }
      if (event.key !== "Tab" || !compactInspector.matches || !inspectorOpen) return;
      const focusable = [
        ...details.querySelectorAll<HTMLElement>(
          'button:not([disabled]),summary,[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (
        !details.contains(active) ||
        !(active instanceof HTMLElement) ||
        !focusable.includes(active)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    { signal: teardown.signal },
  );
  inspectorScrim.addEventListener("click", closeDetails, { signal: teardown.signal });

  const updateExclusionButton = (
    button: HTMLButtonElement,
    asset: AuthoringAssetV1,
    presentation: { exclusionAction: string; exclusionHelp: string },
  ): void => {
    button.textContent = presentation.exclusionAction;
    button.title = presentation.exclusionHelp;
    button.setAttribute(
      "aria-label",
      presentation.exclusionAction + " for " + humanizedAssetLabel(asset),
    );
  };

  const updateRow = (row: HTMLElement, asset: AuthoringAssetV1): void => {
    const detail = row.querySelector<HTMLElement>("[data-workbench-row-detail]");
    const evidence = row.querySelector<HTMLElement>("[data-workbench-row-evidence]");
    const action = row.querySelector<HTMLButtonElement>("[data-workbench-row-action]");
    const exclusion = row.querySelector<HTMLButtonElement>("[data-workbench-row-exclusion]");
    if (detail === null || action === null) return;
    const selected = new Set(resolveWorkbenchSelection(options.bundle, state).assetIds);
    const directRoots = state.roots.filter((root) => root.assetId === asset.id);
    const directRequests = state.requests.filter((request) => request.assetId === asset.id);
    const requested = directRequests.length > 0;
    const directOrigins = [...directRoots, ...directRequests].map((entry) => entry.origin);
    const structuralDirect = directRoots.some((root) => root.mode === "structural");
    const directSelect = directRoots.some((root) => root.mode === "select");
    const nextAction = actionFor(asset, state);
    const detailHandler =
      asset.authoring.action === "inspect-evidence"
        ? options.inspectEvidence
        : asset.authoring.action === "prepare-approval"
          ? options.prepareApproval
          : undefined;
    const exclusionEntries = state.exclusions.filter((item) => item.assetId === asset.id);
    const excluded = exclusionEntries.length > 0;
    const explicitAdministratorExclusion = exclusionEntries.some(
      (item) => item.origin.kind === "administrator",
    );
    const decision = assetDecisionPresentation(asset, options.bundle);
    if (evidence !== null) {
      evidence.textContent = decision.evidenceLabel;
      evidence.title = decision.evidenceHelp;
      evidence.dataset.workbenchNeedsInformation = String(decision.needsInformation);
      evidence.dataset.workbenchEvidenceTone = assetEvidencePresentation(
        asset,
        options.bundle,
      ).tone;
    }
    row.querySelector("[data-workbench-overlap]")?.remove();
    const overlap = mcpRuntimeOverlapPresentation(asset, options.bundle, state);
    if (overlap.kind === "potential-overlap") {
      const notice = document.createElement("aside");
      notice.dataset.workbenchOverlap = "true";
      notice.className = "workbench-overlap-notice";
      const message = document.createElement("p");
      message.textContent =
        "Possible MCP overlap: the same registered name is used by " +
        overlap.candidates
          .map((candidate) => candidate.label + " from " + candidate.sourceLabel)
          .join(", ") +
        ". Keep one source, or keep both and record why in Review draft. Nothing is removed automatically.";
      notice.append(message);
      for (const candidate of overlap.candidates) {
        const review = document.createElement("button");
        review.type = "button";
        review.className = "btn sm secondary";
        review.textContent = "Review " + candidate.sourceLabel + " choice";
        review.addEventListener("click", () => {
          const other = options.bundle.assets[candidate.assetId];
          if (other === undefined) return;
          if (browseInventory.assets[other.id] === undefined) {
            showDetails(
              "asset:" + other.id,
              assetDetailsPresentation(other, options.bundle),
              review,
              {
                asset: other,
                mode: "catalog",
              },
            );
            return;
          }
          templates.open = false;
          templateList.replaceChildren();
          updateFilters(
            {
              sourceId: other.sourceId,
              kind: other.kind,
              query: other.label,
              page: 0,
            },
            other.id,
          );
          renderTemplates();
        });
        notice.append(review);
      }
      row.append(notice);
    }
    const presentation = catalogRowPresentation({
      asset,
      state: catalogAssetState({
        excluded,
        requested,
        structuralDirect,
        directSelect,
        selected: selected.has(asset.id),
      }),
      nextAction: nextAction?.type,
      explicitAdministratorExclusion,
      hasNonAdministratorExclusion: exclusionEntries.some(
        (item) => item.origin.kind !== "administrator",
      ),
    });
    detail.textContent =
      "Source: " +
      catalogSourceDisplayName(options.bundle, asset.sourceId) +
      " · Type: " +
      catalogKindLabel(asset.kind) +
      " · Status: " +
      presentation.status;
    if (directOrigins.length > 0)
      detail.textContent +=
        " · Direct origin: " +
        Array.from(
          new Map(directOrigins.map((origin) => [originKey(origin), originLabel(origin)])).values(),
        )
          .sort(compareText)
          .join(", ");
    if (exclusionEntries.length > 0)
      detail.textContent +=
        " · Exclusion origin: " +
        Array.from(
          new Map(
            exclusionEntries.map((entry) => [originKey(entry.origin), originLabel(entry.origin)]),
          ).values(),
        )
          .sort(compareText)
          .join(", ") +
        ". Exclusions do not remove recorded requests or structural roots.";
    if (exclusion !== null) updateExclusionButton(exclusion, asset, presentation);
    action.textContent = presentation.primaryAction;
    action.dataset.workbenchRemoval = String(
      nextAction?.type === "remove-root" || nextAction?.type === "remove-request",
    );
    action.title = decision.consequence;
    action.setAttribute(
      "aria-label",
      presentation.primaryAction + " for " + humanizedAssetLabel(asset),
    );
    action.removeAttribute("aria-pressed");
    action.disabled = nextAction === undefined && detailHandler === undefined;
  };

  const changedAssetIds = (previous: WorkbenchStateV1, next: WorkbenchStateV1): Set<string> => {
    const affected = new Set<string>();
    const addChanged = <T extends { assetId: string }>(
      left: readonly T[],
      right: readonly T[],
      key: (value: T) => string,
    ): void => {
      const before = new Map(left.map((value) => [key(value), value]));
      const after = new Map(right.map((value) => [key(value), value]));
      for (const [keyValue, value] of before) if (!after.has(keyValue)) affected.add(value.assetId);
      for (const [keyValue, value] of after) if (!before.has(keyValue)) affected.add(value.assetId);
    };
    addChanged(
      previous.roots,
      next.roots,
      (value) => `${value.assetId}\u0000${originKey(value.origin)}`,
    );
    addChanged(
      previous.requests,
      next.requests,
      (value) => `${value.assetId}\u0000${originKey(value.origin)}`,
    );
    addChanged(
      previous.exclusions,
      next.exclusions,
      (value) => `${value.assetId}\u0000${originKey(value.origin)}`,
    );
    const beforeResolved = new Set(resolveWorkbenchSelection(options.bundle, previous).assetIds);
    const afterResolved = new Set(resolveWorkbenchSelection(options.bundle, next).assetIds);
    for (const id of beforeResolved) if (!afterResolved.has(id)) affected.add(id);
    for (const id of afterResolved) if (!beforeResolved.has(id)) affected.add(id);
    const changedRuntimes = new Set(
      [...affected].flatMap((id) => options.bundle.assets[id]?.runtimeIdentity ?? []),
    );
    for (const asset of Object.values(options.bundle.assets))
      if (asset.runtimeIdentity !== undefined && changedRuntimes.has(asset.runtimeIdentity))
        affected.add(asset.id);
    return affected;
  };

  const refreshVisibleRows = (affected: ReadonlySet<string>): void => {
    for (const row of scopeAll<HTMLElement>("article[data-workbench-asset-id]")) {
      const id = row.dataset.workbenchAssetId;
      if (id === undefined || !affected.has(id)) continue;
      const asset = options.bundle.assets[id];
      if (asset !== undefined) updateRow(row, asset);
    }
  };

  const refreshActiveInspector = (): void => {
    if (inspectorMode === "draft") return;
    if (details.dataset.workbenchInspectorView === "exposure") {
      renderExposureOverview();
      return;
    }
    if (openDetailKey !== undefined) return;
    const assetId = details.dataset.workbenchInspectorAssetId;
    const asset = assetId === undefined ? undefined : options.bundle.assets[assetId];
    const facts = details.querySelector<HTMLElement>(
      "[data-workbench-selection] .workbench-detail-facts",
    );
    if (asset === undefined || facts === null) return;
    const panelAction = details.querySelector<HTMLButtonElement>(
      "[data-workbench-inspector-action]",
    );
    const rowAction = [
      ...inventory.querySelectorAll<HTMLButtonElement>("[data-workbench-row-action]"),
    ].find((button) => button.dataset.workbenchAssetId === asset.id);
    if (panelAction !== null && rowAction !== undefined) {
      panelAction.textContent = rowAction.textContent;
      panelAction.disabled = rowAction.disabled;
      panelAction.title = rowAction.title;
      const label = rowAction.getAttribute("aria-label");
      if (label !== null) panelAction.setAttribute("aria-label", label);
    }
    const selected = new Set(resolveWorkbenchSelection(options.bundle, state).assetIds);
    const directRoots = state.roots.filter((entry) => entry.assetId === asset.id);
    const directRequests = state.requests.filter((entry) => entry.assetId === asset.id);
    const exclusionEntries = state.exclusions.filter((entry) => entry.assetId === asset.id);
    const directOrigins = [...directRoots, ...directRequests].map((entry) => entry.origin);
    const presentation = catalogRowPresentation({
      asset,
      state: catalogAssetState({
        excluded: exclusionEntries.length > 0,
        requested: directRequests.length > 0,
        structuralDirect: directRoots.some((entry) => entry.mode === "structural"),
        directSelect: directRoots.some((entry) => entry.mode === "select"),
        selected: selected.has(asset.id),
      }),
      nextAction: actionFor(asset, state)?.type,
      explicitAdministratorExclusion: exclusionEntries.some(
        (entry) => entry.origin.kind === "administrator",
      ),
      hasNonAdministratorExclusion: exclusionEntries.some(
        (entry) => entry.origin.kind !== "administrator",
      ),
    });
    const appendFact = (label: string, value: string): void => {
      const term = document.createElement("dt");
      const definition = document.createElement("dd");
      term.textContent = label;
      definition.textContent = value;
      facts.append(term, definition);
    };
    facts.replaceChildren();
    appendFact("State", presentation.status);
    appendFact("Meaning", presentation.explanation);
    appendFact("If you add this", assetDecisionPresentation(asset, options.bundle).consequence);
    appendFact(
      "Direct origin",
      directOrigins.length === 0
        ? "None."
        : Array.from(
            new Map(
              directOrigins.map((origin) => [originKey(origin), originLabel(origin)]),
            ).values(),
          )
            .sort(compareText)
            .join(", "),
    );
    appendFact(
      "Exclusion origin",
      exclusionEntries.length === 0
        ? "None."
        : Array.from(
            new Map(
              exclusionEntries.map((entry) => [originKey(entry.origin), originLabel(entry.origin)]),
            ).values(),
          )
            .sort(compareText)
            .join(", "),
    );
    const exclusion = [
      ...details.querySelectorAll<HTMLButtonElement>("[data-workbench-exclusion-id]"),
    ].find((button) => button.dataset.workbenchExclusionId === asset.id);
    if (exclusion !== undefined) updateExclusionButton(exclusion, asset, presentation);
  };

  const scheduleEvidenceRefresh = (): void => {
    if (evidenceRefreshTimer !== undefined) {
      clearTimeout(evidenceRefreshTimer);
      evidenceRefreshTimer = undefined;
    }
    const now = Date.now();
    let nextBoundary = Number.POSITIVE_INFINITY;
    for (const evidence of Object.values(options.bundle.evidence)) {
      if (evidence.verification.state !== "verified") continue;
      for (const timestamp of [
        evidence.verification.verifiedAt,
        evidence.verification.validUntil,
      ]) {
        if (timestamp === undefined) continue;
        const boundary = Date.parse(timestamp);
        if (Number.isFinite(boundary) && boundary > now)
          nextBoundary = Math.min(nextBoundary, boundary);
      }
    }
    if (!Number.isFinite(nextBoundary)) return;
    evidenceRefreshTimer = setTimeout(
      () => {
        evidenceRefreshTimer = undefined;
        const visibleAssetIds = new Set(
          [...scopeAll<HTMLElement>("article[data-workbench-asset-id]")]
            .map((row) => row.dataset.workbenchAssetId)
            .filter((id): id is string => id !== undefined),
        );
        refreshVisibleRows(visibleAssetIds);
        if (expandedAssetId !== undefined) renderInventory();
        else {
          renderSourceSummary();
          if (details.dataset.workbenchInspectorView === "exposure") renderExposureOverview();
        }
        if (openDetailKey?.startsWith("asset:") && inspectorOpen) {
          const asset = options.bundle.assets[openDetailKey.slice("asset:".length)];
          if (asset !== undefined) {
            const catalogDetail =
              openCatalogDetail?.assetId === asset.id ? openCatalogDetail : undefined;
            renderDetails(
              catalogDetail?.mode === "developer-tool-setup"
                ? developerToolDetailsPresentation(asset)
                : assetDetailsPresentation(asset, options.bundle),
              {
                catalogAsset: catalogDetail === undefined ? undefined : asset,
                referenceAsset: asset,
                preserveFocus: true,
              },
            );
          }
        }
        scheduleEvidenceRefresh();
      },
      Math.min(nextBoundary - now, 2_147_483_647),
    );
  };

  const renderRows = (
    host: HTMLElement,
    assetIds: readonly string[],
    page: number,
    setPage: (next: number) => void,
    total = assetIds.length,
    alreadyPaged = false,
  ): void => {
    const active = document.activeElement;
    const focusTarget =
      active instanceof HTMLButtonElement && host.contains(active)
        ? {
            assetId: active.dataset.workbenchAssetId,
            exclusionId: active.dataset.workbenchExclusionId,
            detailId: active.dataset.workbenchDetailId,
            expandId: active.dataset.workbenchExpandId,
          }
        : undefined;
    const rows = document.createElement("div");
    rows.className = "workbench-inventory-rows";
    rows.dataset.wbSourcesCards = "";
    rows.id = "cards-grid";
    tw(rows, "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3");
    for (const assetId of alreadyPaged ? assetIds : pageItems(assetIds, page)) {
      const asset = options.bundle.assets[assetId];
      if (asset === undefined) continue;
      const row = document.createElement("article");
      const title = document.createElement("button");
      const action = document.createElement("button");
      const detailsButton = document.createElement("button");
      const expandButton = document.createElement("button");
      const exclusionButton = document.createElement("button");
      const moreOptions = document.createElement("details");
      const moreOptionsSummary = document.createElement("summary");
      const moreOptionsHelp = document.createElement("p");
      const actions = document.createElement("div");
      const purpose = document.createElement("p");
      const kind = document.createElement("span");
      const decisionFacts = document.createElement("div");
      const access = document.createElement("p");
      const evidence = document.createElement("p");
      const methodology = document.createElement("span");
      const detail = document.createElement("p");
      // admin-sources.html #cards-grid card: icon + mono title + category chip,
      // three-line summary, footer with the status pill and the card controls.
      row.className = "workbench-asset";
      tw(
        row,
        "group relative rounded border border-solid border-hairline bg-wb-card hover:bg-wb-card-hover p-3 flex flex-col justify-between min-w-0 hover:border-primary transition-all shadow-xs",
      );
      row.dataset.workbenchAssetId = asset.id;
      title.className = "workbench-row-title";
      tw(
        title,
        "min-w-0 p-0 border-0 bg-transparent text-left font-mono font-bold text-wb-heading text-[13px] tracking-tight truncate cursor-pointer",
      );
      title.type = "button";
      title.dataset.workbenchExpandId = asset.id;
      title.setAttribute("aria-controls", details.id);
      title.id = "workbench-asset-title-" + asset.id;
      title.textContent = humanizedAssetLabel(asset);
      const kindIcon = catalogKindIcon(asset.kind);
      const icon = document.createElement("span");
      icon.className = "workbench-row-icon";
      tw(icon, "inline-flex w-[15px] h-[15px] shrink-0 [&>svg]:w-full [&>svg]:h-full");
      if (kindIcon.colorClass !== undefined) icon.classList.add(kindIcon.colorClass);
      icon.setAttribute("aria-hidden", "true");
      // Static glyph markup from the package-owned icon table; no catalog text.
      icon.innerHTML = workbenchIcon(kindIcon.name);
      const decision = assetDecisionPresentation(asset, options.bundle);
      purpose.className = "workbench-row-purpose";
      tw(purpose, "m-0 mt-2 text-[11px] leading-relaxed text-on-surface-variant line-clamp-3");
      purpose.textContent = decision.purpose;
      kind.className = "workbench-row-kind";
      tw(
        kind,
        "px-1.5 py-0.5 rounded bg-surface-container-low border border-solid border-hairline text-[8.5px] font-mono uppercase text-outline whitespace-nowrap",
      );
      kind.textContent = catalogKindLabel(asset.kind);
      // Declared access and the status line have no place on the prototype
      // card: they stay in the card's text for assistive technology and in
      // the inspector, which shows both in full.
      decisionFacts.className = "workbench-row-decision";
      tw(decisionFacts, "flex items-center gap-2 min-w-0");
      tw(access, "sr-only");
      access.textContent = "Access: " + decision.access;
      access.title = decision.access;
      evidence.className = "workbench-row-evidence";
      tw(
        evidence,
        "m-0 px-1.5 py-0.5 rounded font-mono font-medium truncate min-w-0 before:content-[''] before:inline-block before:align-middle before:mr-1 before:w-1 before:h-1 before:rounded-full before:bg-current bg-surface-container-low text-on-surface-variant data-[workbench-evidence-tone=positive]:bg-wb-pass-bg data-[workbench-evidence-tone=positive]:text-wb-pass data-[workbench-evidence-tone=warning]:bg-wb-review-bg data-[workbench-evidence-tone=warning]:text-wb-review",
      );
      evidence.dataset.workbenchRowEvidence = "true";
      evidence.textContent = decision.evidenceLabel;
      evidence.title = decision.evidenceHelp;
      evidence.dataset.workbenchNeedsInformation = String(decision.needsInformation);
      decisionFacts.append(access, evidence);
      methodology.className = "workbench-methodology-badge";
      tw(
        methodology,
        "block mt-2 px-1.5 py-0.5 rounded border border-solid border-wb-badge-border bg-wb-badge-bg font-mono text-[10px] text-wb-badge",
      );
      methodology.textContent = "Optional: choose up to one methodology.";
      methodology.hidden = asset.exclusiveSlot !== "methodology";
      detail.className = "workbench-row-summary";
      tw(detail, "sr-only");
      detail.dataset.workbenchRowDetail = "true";
      actions.className = "workbench-row-actions";
      tw(
        actions,
        "pt-2.5 mt-2.5 border-0 border-t border-solid border-hairline flex items-center justify-between gap-2 text-[10px] min-w-0",
      );
      expandButton.type = "button";
      expandButton.tabIndex = -1;
      expandButton.className = "workbench-row-expand";
      tw(
        expandButton,
        "p-1 rounded text-outline hover:bg-surface-container hover:text-on-surface aria-expanded:text-primary transition-colors",
      );
      expandButton.dataset.workbenchExpandId = asset.id;
      expandButton.setAttribute(
        "aria-expanded",
        String(expandedAssetId === asset.id && (!compactInspector.matches || inspectorOpen)),
      );
      expandButton.setAttribute("aria-controls", details.id);
      expandButton.setAttribute("aria-describedby", title.id);
      expandButton.setAttribute("aria-label", "Inspect " + humanizedAssetLabel(asset));
      expandButton.title = "Inspect";
      expandButton.append(glyph("info", "w-[13px] h-[13px]"));
      // The prototype's toggle switch: blue while the item is in the draft
      // (the next action removes it), outlined while it can be added.
      action.type = "button";
      action.className = "workbench-row-toggle";
      tw(
        action,
        "px-2 py-0.5 rounded font-mono text-[10px] font-medium whitespace-nowrap bg-primary-container text-on-primary hover:bg-primary-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed data-[workbench-removal=true]:bg-surface-container-highest data-[workbench-removal=true]:text-on-surface",
      );
      action.dataset.workbenchAssetId = asset.id;
      action.dataset.workbenchRowAction = "true";
      action.setAttribute("aria-describedby", title.id);
      moreOptions.className = "workbench-row-more";
      moreOptionsSummary.textContent = "More options";
      moreOptionsSummary.setAttribute(
        "aria-label",
        "More options for " + humanizedAssetLabel(asset),
      );
      moreOptionsHelp.textContent =
        "Prevents optional inclusion. Required dependencies and saved requests are kept.";
      exclusionButton.type = "button";
      exclusionButton.className = "btn sm secondary";
      exclusionButton.dataset.workbenchExclusionId = asset.id;
      exclusionButton.dataset.workbenchRowExclusion = "true";
      exclusionButton.setAttribute("aria-describedby", title.id);
      moreOptions.append(moreOptionsSummary, moreOptionsHelp, exclusionButton);
      detailsButton.type = "button";
      detailsButton.className = "btn sm secondary";
      detailsButton.dataset.workbenchDetailId = asset.id;
      detailsButton.setAttribute("aria-controls", details.id);
      detailsButton.setAttribute("aria-describedby", title.id);
      detailsButton.setAttribute("aria-label", "Details for " + humanizedAssetLabel(asset));
      detailsButton.setAttribute("aria-expanded", String(openDetailKey === "asset:" + asset.id));
      detailsButton.textContent =
        previousCatalogReportPresentation(
          asset,
          options.bundle,
          options.referenceReports?.[asset.id],
        ) === undefined
          ? "Read details"
          : "Read previous report";
      const controls = document.createElement("div");
      tw(controls, "flex items-center gap-1.5 shrink-0");
      controls.append(expandButton, action);
      actions.append(decisionFacts, controls);
      const heading = document.createElement("div");
      tw(heading, "flex items-start justify-between gap-2 min-w-0");
      const name = document.createElement("div");
      tw(name, "flex items-center gap-1.5 min-w-0");
      name.append(icon, title);
      heading.append(name, kind);
      const body = document.createElement("div");
      tw(body, "min-w-0");
      body.append(heading, purpose, methodology, detail);
      row.append(body, actions);
      updateRow(row, asset);
      if (expandedAssetId === asset.id && openDetailKey === undefined) {
        const inspectorHeading = document.createElement("h3");
        const back = document.createElement("button");
        const close = document.createElement("button");
        const selection = document.createElement("section");
        const selectionHeading = document.createElement("h4");
        const selectionFacts = document.createElement("dl");
        const expanded = document.createElement("section");
        const why = document.createElement("section");
        const whyHeading = document.createElement("h4");
        const whyAccess = document.createElement("p");
        const evidenceSheet = document.createElement("section");
        const evidenceHeading = document.createElement("h4");
        const evidenceStatus = document.createElement("p");
        const evidenceResult = document.createElement("p");
        const evidenceAnalyzers = document.createElement("ul");
        const evidenceBinding = document.createElement("p");
        const evidenceCoverage = document.createElement("p");
        const evidenceFreshness = document.createElement("p");
        const evidenceQualification = document.createElement("p");
        const evidenceScope = document.createElement("p");
        const evidenceFindings = document.createElement("div");
        const evidenceNextStep = document.createElement("p");
        const evidenceCaveat = document.createElement("p");
        const evidence = assetEvidencePresentation(asset, options.bundle);
        const selected = new Set(resolveWorkbenchSelection(options.bundle, state).assetIds);
        const directRoots = state.roots.filter((entry) => entry.assetId === asset.id);
        const directRequests = state.requests.filter((entry) => entry.assetId === asset.id);
        const exclusionEntries = state.exclusions.filter((entry) => entry.assetId === asset.id);
        const directOrigins = [...directRoots, ...directRequests].map((entry) => entry.origin);
        const assetState = catalogAssetState({
          excluded: exclusionEntries.length > 0,
          requested: directRequests.length > 0,
          structuralDirect: directRoots.some((entry) => entry.mode === "structural"),
          directSelect: directRoots.some((entry) => entry.mode === "select"),
          selected: selected.has(asset.id),
        });
        const inspectorStatus = catalogRowPresentation({
          asset,
          state: assetState,
          nextAction: actionFor(asset, state)?.type,
          explicitAdministratorExclusion: exclusionEntries.some(
            (entry) => entry.origin.kind === "administrator",
          ),
          hasNonAdministratorExclusion: exclusionEntries.some(
            (entry) => entry.origin.kind !== "administrator",
          ),
        });
        updateExclusionButton(exclusionButton, asset, inspectorStatus);
        const appendSelectionFact = (label: string, value: string): void => {
          const term = document.createElement("dt");
          const definition = document.createElement("dd");
          term.textContent = label;
          definition.textContent = value;
          selectionFacts.append(term, definition);
        };
        inspectorHeading.id = "workbench-detail-title";
        inspectorHeading.tabIndex = -1;
        inspectorHeading.textContent = humanizedAssetLabel(asset);
        const sourceName = catalogSourceDisplayName(options.bundle, asset.sourceId);
        const inspectorHeader = inspectorHead({
          heading: inspectorHeading,
          tone: evidence.tone,
          version: assetVersion(asset),
          kind: asset.kind,
          meta: [sourceName, inspectorStatus.status],
          ...(evidence.findings.length === 0
            ? {}
            : {
                flags: `${evidence.findings.length} finding${evidence.findings.length === 1 ? "" : "s"}`,
              }),
        });
        inspectorHeader.classList.add("workbench-inspector-header");
        back.type = "button";
        back.className = "workbench-exposure-back";
        tw(back, BACK_BUTTON);
        back.dataset.workbenchDetailsClose = "true";
        back.textContent = "Back to catalog";
        close.type = "button";
        close.className = "workbench-inspector-close";
        tw(close, FOOTER_BUTTON);
        close.dataset.workbenchDetailsClose = "true";
        close.textContent = "Close details";
        // Upstream provenance: where the item comes from, at which version.
        const source = options.bundle.sources[asset.sourceId];
        const provenanceRows: (readonly [string, string | Node])[] = [["Source", sourceName]];
        if (source !== undefined) {
          const origin = inspectorNode("span", "text-primary", source.upstreamOrigin.locator);
          provenanceRows.push(["Origin", origin], ["Revision", source.revision.id]);
        }
        provenanceRows.push(["Digest", asset.contentDigest]);
        if (evidence.component !== undefined) {
          const component = document.createElement("p");
          tw(component, "m-0 text-right");
          component.dataset.workbenchCoreComponent = "true";
          component.textContent =
            `${evidence.component.label} · ${evidence.component.package}. ` +
            `Bundled ${asset.kind === "hook" ? "control" : "path"}: ${evidence.component.path}.`;
          provenanceRows.push(["Component", component]);
        }
        const provenance = inspectorSection("Upstream provenance", keyValueBox(provenanceRows));
        // The prototype's "Held back by the rule ..." line: the item's draft state.
        const stateLine = inspectorNode("div", "flex items-start gap-2 text-[11.5px] min-w-0");
        stateLine.dataset.wbInspectorState = "";
        const stateCopy = inspectorNode("p", "m-0 min-w-0 leading-snug");
        stateCopy.append(
          inspectorNode("span", "font-semibold text-on-surface", inspectorStatus.status),
          inspectorNode("span", "text-outline", " " + inspectorStatus.explanation),
        );
        stateLine.append(
          inspectorNode(
            "span",
            `mt-1 w-2 h-2 rounded-full shrink-0 ${selected.has(asset.id) ? "bg-primary" : "bg-outline"}`,
          ),
          stateCopy,
        );
        selection.className = "workbench-inspector-selection";
        selection.dataset.workbenchSelection = "true";
        selectionFacts.className = "workbench-detail-facts";
        tw(selectionFacts, WB_FACTS);
        tw(selection, "flex flex-col gap-1.5");
        tw(selectionHeading, INSPECTOR_LABEL);
        selectionHeading.textContent = "Draft status";
        appendSelectionFact("State", inspectorStatus.status);
        appendSelectionFact("Meaning", inspectorStatus.explanation);
        appendSelectionFact("If you add this", decision.consequence);
        appendSelectionFact(
          "Direct origin",
          directOrigins.length === 0
            ? "None."
            : Array.from(
                new Map(
                  directOrigins.map((origin) => [originKey(origin), originLabel(origin)]),
                ).values(),
              )
                .sort(compareText)
                .join(", "),
        );
        appendSelectionFact(
          "Exclusion origin",
          exclusionEntries.length === 0
            ? "None."
            : Array.from(
                new Map(
                  exclusionEntries.map((entry) => [
                    originKey(entry.origin),
                    originLabel(entry.origin),
                  ]),
                ).values(),
              )
                .sort(compareText)
                .join(", "),
        );
        selection.append(selectionHeading, selectionFacts);
        expanded.className = "workbench-expanded-item";
        expanded.id = "workbench-expanded-" + asset.id;
        why.className = "workbench-expanded-why";
        tw(why, "flex flex-col gap-3 min-w-0");
        why.dataset.workbenchDeclaration = "true";
        whyHeading.textContent = "Claims";
        tw(whyHeading, "sr-only");
        const overview = inspectorNode(
          "p",
          "m-0 text-on-surface leading-relaxed text-[11px]",
          decision.purpose,
        );
        whyAccess.textContent = "What it can access: " + decision.access;
        tw(whyAccess, "sr-only");
        const targets = asset.authoring.supportedTargets;
        why.append(
          whyHeading,
          inspectorSection("Publisher overview", overview),
          inspectorSection(
            "Declared capabilities",
            capabilityRow("wifi", "text-primary", "What it can access", decision.access),
            capabilityRow(
              "terminal",
              "text-secondary",
              "Policy targets",
              targets.length === 0
                ? "No managed policy target is declared for this item."
                : targets.join(", "),
              "font-mono text-secondary text-[10.5px]",
            ),
            capabilityRow("vpn_key", "text-tertiary", "If you add this", decision.consequence),
          ),
          whyAccess,
        );
        evidenceSheet.className = "workbench-evidence-sheet";
        evidenceSheet.dataset.workbenchChecks = "true";
        evidenceSheet.dataset.workbenchEvidenceState = evidence.state;
        evidenceSheet.dataset.workbenchEvidenceTone = evidence.tone;
        evidenceHeading.textContent = "Checks";
        evidenceStatus.textContent = evidence.statusLabel;
        evidenceResult.className = "workbench-report-result";
        evidenceResult.textContent =
          (evidence.state === "stale" ? "Historical reported result: " : "Reported result: ") +
          evidence.reportedResult;
        evidenceAnalyzers.className = "workbench-report-analyzers";
        evidenceAnalyzers.setAttribute("aria-label", "Analyzers named in the report");
        for (const analyzer of evidence.analyzers) {
          const item = document.createElement("li");
          item.textContent = analyzer.name + " · " + analyzer.version;
          evidenceAnalyzers.append(item);
        }
        evidenceBinding.textContent = evidence.binding;
        evidenceCoverage.textContent = evidence.coverage;
        evidenceFreshness.textContent = evidence.freshness;
        evidenceQualification.textContent = evidence.qualification;
        evidenceScope.textContent =
          evidence.scopePaths.length === 0
            ? "No covered paths are available for this review state."
            : "Covered paths: " + evidence.scopePaths.join(", ");
        const findingsHeading = document.createElement("p");
        findingsHeading.textContent =
          evidence.findingsLabel + " (" + evidence.findings.length + " listed)";
        evidenceFindings.append(findingsHeading);
        if (evidence.findings.length === 0) {
          const emptyFindings = document.createElement("p");
          tw(emptyFindings, "m-0 text-[11px] text-outline leading-snug");
          emptyFindings.textContent =
            "The report lists no findings. Check its coverage before drawing a conclusion.";
          evidenceFindings.append(emptyFindings);
        } else {
          const findingsList = document.createElement("ul");
          // The prototype's evidence box: mono lines on the code surface.
          tw(
            findingsList,
            "wb-evidence-box m-0 p-2 list-none rounded bg-surface-container-lowest border border-solid border-hairline font-mono text-[10.5px] leading-relaxed flex flex-col gap-0.5 text-on-surface-variant min-w-0 break-words",
          );
          for (const finding of evidence.findings) {
            const item = document.createElement("li");
            const explanation = findingExplanation(finding);
            if (explanation === undefined) item.textContent = finding;
            else {
              const meaning = document.createElement("p");
              meaning.textContent = explanation;
              const original = document.createElement("details");
              const summary = document.createElement("summary");
              summary.textContent = "Original report detail";
              const text = document.createElement("p");
              text.textContent = finding;
              original.append(summary, text);
              item.append(meaning, original);
            }
            findingsList.append(item);
          }
          evidenceFindings.append(findingsList);
        }
        evidenceNextStep.textContent =
          (evidence.state === "unverified" ? "Verification: " : "Next step: ") + evidence.nextStep;
        evidenceCaveat.textContent = evidence.limitation;
        // admin-item.html Security: the tinted finding callout, the scanner
        // grid, the evidence box, then the report's own caveats.
        tw(evidenceSheet, "flex flex-col gap-1.5 min-w-0 scroll-mt-32");
        tw(evidenceHeading, INSPECTOR_LABEL);
        const callout = inspectorNode(
          "div",
          `p-2.5 rounded border border-solid flex flex-col gap-1 min-w-0 ${CALLOUT_TONE[evidence.tone]}`,
        );
        const calloutTop = inspectorNode("div", "flex items-center justify-between gap-2 min-w-0");
        const calloutTitle = inspectorNode(
          "div",
          `flex items-center gap-1.5 font-semibold text-[11px] min-w-0 ${CALLOUT_TEXT[evidence.tone]}`,
        );
        tw(evidenceStatus, "m-0 min-w-0");
        calloutTitle.append(glyph("radar", "w-[15px] h-[15px]"), evidenceStatus);
        calloutTop.append(calloutTitle);
        if (evidence.findings.length > 0)
          calloutTop.append(
            inspectorNode(
              "span",
              "px-1.5 py-0.5 rounded bg-surface-container-highest text-tertiary font-mono text-[9.5px] font-bold shrink-0",
              `${evidence.findings.length} listed`,
            ),
          );
        callout.append(calloutTop);
        for (const line of [evidenceResult, evidenceCoverage, evidenceBinding])
          tw(line, "m-0 text-[11px] text-on-surface-variant leading-snug");
        const evidenceFacts: HTMLElement[] = [evidenceHeading, callout];
        if (
          evidence.state === "verified" ||
          evidence.state === "unverified" ||
          evidence.state === "stale"
        ) {
          callout.append(evidenceResult, evidenceCoverage);
          if (evidence.analyzers.length > 0) {
            const scanned = inspectorNode(
              "div",
              "flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-outline font-semibold pt-1",
            );
            scanned.append(
              inspectorNode("span", "", "Scanned by"),
              inspectorNode(
                "span",
                "text-secondary normal-case",
                `${evidence.analyzers.length} analyzer${evidence.analyzers.length === 1 ? "" : "s"} named`,
              ),
            );
            evidenceFacts.push(scanned, analyzerGrid(evidence.analyzers));
          }
          tw(evidenceFindings, "flex flex-col gap-1 min-w-0 pt-1");
          tw(
            findingsHeading,
            "m-0 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold",
          );
          evidenceFacts.push(evidenceFindings);
          if (evidence.state === "verified" || evidence.state === "stale")
            evidenceFacts.push(evidenceFreshness);
          if (evidence.showQualification) evidenceFacts.push(evidenceQualification);
        } else {
          callout.append(evidenceBinding);
        }
        for (const line of [evidenceFreshness, evidenceQualification])
          tw(line, "m-0 text-[11px] text-on-surface-variant leading-snug");
        if (evidence.sourceItemReports !== undefined)
          evidenceFacts.push(sourceItemReportsElement(evidence.sourceItemReports));
        evidenceSheet.append(...evidenceFacts);
        const technical = document.createElement("details");
        const technicalSummary = document.createElement("summary");
        const metadata = document.createElement("pre");
        technical.className = "workbench-item-technical";
        tw(
          technical,
          "rounded border border-solid border-hairline bg-surface-container-low min-w-0 scroll-mt-32",
        );
        tw(technicalSummary, `${INSPECTOR_LABEL} px-2 py-1.5 cursor-pointer`);
        technicalSummary.textContent = "More technical details";
        metadata.textContent = assetDetailsPresentation(asset, options.bundle).advancedJson;
        const raw = document.createElement("details");
        const rawSummary = document.createElement("summary");
        rawSummary.textContent = "Prepared metadata";
        raw.append(rawSummary, metadata);
        technical.append(
          technicalSummary,
          selection,
          evidenceNextStep,
          evidenceCaveat,
          evidenceScope,
          evidenceAnalyzers,
          detailsButton,
          moreOptions,
          raw,
        );
        const previousReport = previousCatalogReportPresentation(
          asset,
          options.bundle,
          options.referenceReports?.[asset.id],
        );
        if (previousReport !== undefined) {
          evidenceSheet.append(previousCatalogReportElement(previousReport, { compact: true }));
          technical.insertBefore(previousCatalogReportElement(previousReport), raw);
        }
        const expandedActions = document.createElement("div");
        expandedActions.className = "workbench-expanded-actions";
        const panelAction = action.cloneNode(true) as HTMLButtonElement;
        // The footer's primary button (the prototype's "Apply").
        panelAction.className = INSPECTOR_PRIMARY;
        delete panelAction.dataset.workbenchRowAction;
        panelAction.dataset.workbenchInspectorAction = "true";
        tw(expanded, "flex flex-col gap-3 min-w-0");
        expanded.dataset.wbInspectorSections = "";
        expanded.append(stateLine, why, provenance, evidenceSheet, technical);
        if (comparisonPreview?.assetId === asset.id) {
          const comparison = selectionComparisonPresentation(asset, options.bundle, state);
          const preview = document.createElement("section");
          const previewHeading = document.createElement("h4");
          const explanation = document.createElement("p");
          const changes = document.createElement("p");
          const confirm = document.createElement("button");
          const cancel = document.createElement("button");
          preview.className = "workbench-selection-comparison";
          tw(
            preview,
            "p-2.5 rounded border border-solid border-wb-badge-border bg-wb-review-bg flex flex-col gap-1.5 text-[11px] min-w-0",
          );
          tw(previewHeading, "m-0 text-tertiary font-semibold text-[11px]");
          previewHeading.textContent = "Review replacement";
          previewHeading.tabIndex = -1;
          previewHeading.dataset.workbenchComparisonHeading = "true";
          explanation.textContent = comparison.explanation;
          const delta = comparison.preview.changes;
          changes.textContent =
            "This preview removes " +
            (delta.roots.removed.length +
              delta.requests.removed.length +
              delta.exclusions.removed.length) +
            " saved record" +
            (delta.roots.removed.length +
              delta.requests.removed.length +
              delta.exclusions.removed.length ===
            1
              ? ""
              : "s") +
            " and adds " +
            (delta.roots.added.length +
              delta.requests.added.length +
              delta.exclusions.added.length) +
            " saved record" +
            (delta.roots.added.length +
              delta.requests.added.length +
              delta.exclusions.added.length ===
            1
              ? ""
              : "s") +
            ". Saved choices can be removed while another origin still includes the item.";
          const records = (["roots", "requests", "exclusions"] as const).flatMap((category) =>
            (["removed", "added"] as const).flatMap((operation) =>
              delta[category][operation].map((entry) => ({ category, operation, entry })),
            ),
          );
          const recordList = document.createElement("div");
          recordList.className = "workbench-comparison-records";
          const renderRecords = (pageNumber: number): void => {
            recordList.replaceChildren();
            for (const { category, operation, entry } of pageItems(records, pageNumber)) {
              const record = document.createElement("p");
              record.dataset.workbenchComparisonChange = `${operation}-${category}`;
              const item = options.bundle.assets[entry.assetId];
              const label = item === undefined ? entry.assetId : humanizedAssetLabel(item);
              const stale =
                item === undefined ||
                entry.sourceId !== item.sourceId ||
                entry.sourceRevisionId !== item.sourceRevisionId ||
                entry.contentDigest !== item.contentDigest;
              record.textContent = `${operation === "removed" ? "Remove" : "Add"} ${category === "roots" ? "choice" : category === "requests" ? "request" : "exclusion"}: ${label}${stale ? " (saved version needs review)" : ""} · ${originLabel(entry.origin)}`;
              record.title = `${entry.assetId} · ${entry.sourceId} · ${entry.sourceRevisionId} · ${entry.contentDigest} · ${originKey(entry.origin).replaceAll("\u0000", " · ")}`;
              recordList.append(record);
            }
            renderPageControls(
              recordList,
              pageNumber,
              records.length,
              renderRecords,
              previewHeading,
            );
          };
          renderRecords(0);
          const effectiveRemoved = document.createElement("p");
          effectiveRemoved.textContent =
            "No longer included: " + previewList(delta.removedAssetIds) + ".";
          const effectiveAdded = document.createElement("p");
          effectiveAdded.textContent = "Newly included: " + previewList(delta.addedAssetIds) + ".";
          confirm.type = "button";
          confirm.className = "btn sm primary";
          confirm.dataset.workbenchComparisonConfirmId = asset.id;
          confirm.textContent = "Confirm replacement";
          confirm.disabled =
            comparison.kind !== "conflict" ||
            !comparison.preview.accepted ||
            comparison.preview.action === undefined;
          cancel.type = "button";
          cancel.className = "btn sm secondary";
          cancel.dataset.workbenchComparisonCancel = "true";
          cancel.textContent = "Cancel";
          preview.append(
            previewHeading,
            explanation,
            changes,
            recordList,
            effectiveRemoved,
            effectiveAdded,
            confirm,
            cancel,
          );
          expanded.insertBefore(preview, technical);
        }
        details.dataset.workbenchInspectorAssetId = asset.id;
        details.dataset.workbenchInspectorView = "item";
        details.setAttribute("aria-labelledby", inspectorHeading.id);
        inspectorMode = "item";
        lastInspectedAssetId = asset.id;
        lastFullDetail = undefined;
        expandedActions.append(back, close, panelAction);
        tw(expandedActions, "flex items-center gap-2 flex-1 min-w-0");
        details.replaceChildren(
          inspectorHeader,
          inspectorBody(expanded),
          inspectorFooter(expandedActions),
        );
        syncInspectorPresentation();
      }
      rows.append(row);
    }
    host.replaceChildren(rows);
    renderPageControls(host, page, total, setPage, undefined, "before");
    if (focusTarget !== undefined) {
      const replacement = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.dataset.workbenchAssetId === focusTarget.assetId &&
          button.dataset.workbenchExclusionId === focusTarget.exclusionId &&
          button.dataset.workbenchDetailId === focusTarget.detailId &&
          button.dataset.workbenchExpandId === focusTarget.expandId,
      );
      replacement?.focus();
    }
  };

  const renderSourceSummary = (): void => {
    const sourceId = filtersState.sourceId;
    sourceReview.replaceChildren(draftCounts);
    if (sourceId !== undefined) {
      const summary = sourceEvidenceSummary(browseBundle, sourceId, state);
      const choicesInDraft = sourceEvidenceSummary(options.bundle, sourceId, state).choicesInDraft;
      const source = options.bundle.sources[sourceId];
      // admin-sources.html masthead: "ECC Manifest — ecc@ecc v2.0.0".
      const heading = document.createElement("h3");
      tw(
        heading,
        "m-0 text-[22px] font-bold text-wb-heading tracking-tight flex flex-wrap items-center gap-x-2 font-mono min-w-0 break-all",
      );
      const name = document.createElement("span");
      name.textContent = catalogSourceDisplayName(options.bundle, sourceId);
      heading.append(name);
      if (source !== undefined) {
        const dash = document.createElement("span");
        tw(dash, "text-outline font-light");
        dash.setAttribute("aria-hidden", "true");
        dash.textContent = "—";
        const revision = document.createElement("span");
        tw(revision, "text-tertiary");
        revision.textContent = source.revision.id;
        heading.append(dash, revision);
      }
      // The meta line: the source's own facts, then its review cells.
      const meta = document.createElement("div");
      tw(
        meta,
        "flex flex-wrap items-center gap-2 text-[11px] font-mono text-outline pt-0.5 min-w-0",
      );
      const separator = (): HTMLSpanElement => {
        const node = document.createElement("span");
        tw(node, "text-outline");
        node.setAttribute("aria-hidden", "true");
        node.textContent = "·";
        return node;
      };
      if (source !== undefined) {
        const kindPill = document.createElement("span");
        tw(
          kindPill,
          "px-2 py-0.5 rounded bg-wb-pass-bg text-wb-pass font-semibold flex items-center gap-1.5 text-[10.5px] uppercase",
        );
        kindPill.append(dot("bg-current"), source.distributor.kind);
        const locator = document.createElement("span");
        tw(locator, "text-primary break-all min-w-0");
        locator.textContent = source.upstreamOrigin.locator;
        const compiler = document.createElement("span");
        tw(compiler, "text-secondary break-all min-w-0");
        compiler.textContent = `${source.compiler.id} @ ${source.compiler.version}`;
        meta.append(kindPill, separator(), locator, separator(), compiler);
      }
      const cells = document.createElement("div");
      cells.className = "workbench-source-review-cells";
      tw(cells, "flex flex-wrap items-center gap-2 text-[11px] font-mono text-outline min-w-0");
      const addCell = (label: string, value: number, help: string): void => {
        const cell = document.createElement("p");
        const count = document.createElement("strong");
        const caption = document.createElement("span");
        tw(
          cell,
          "m-0 inline-flex items-center gap-1 min-w-0 data-[workbench-evidence-tone=warning]:text-tertiary",
        );
        tw(count, "font-semibold text-on-surface");
        count.textContent = String(value);
        caption.textContent = label;
        cell.title = help;
        if (label.startsWith("Needs review")) {
          cell.dataset.workbenchEvidenceTone = value > 0 ? "warning" : "neutral";
          if (value > 0) tw(count, "text-tertiary");
        }
        cell.append(count, caption);
        if (cells.childElementCount > 0) cells.append(separator());
        cells.append(cell);
      };
      addCell(
        "Reports included · " + summary.currentReports + " currently verified",
        summary.includedReports,
        "Items with an exact-version report attached, including reports awaiting verification. A report is not an organization approval.",
      );
      addCell(
        "Needs review · " + summary.reportsWithConcerns + " items with reported concerns",
        summary.needsReview,
        "Items without a current, qualified passing report need attention before relying on that report.",
      );
      addCell(
        "Choices in draft",
        choicesInDraft,
        "Current source choices and requests. Choices from other sources stay in the shared draft.",
      );
      const titleRow = document.createElement("div");
      tw(titleRow, "flex items-center justify-between flex-wrap gap-2 min-w-0");
      titleRow.append(heading, draftCounts);
      sourceReview.replaceChildren(titleRow, meta, cells);
    }
  };
  const renderSourceControls = (browse: ReturnType<typeof catalogBrowse>): void => {
    const option = (text: string, value: string): HTMLOptionElement => {
      const element = document.createElement("option");
      element.textContent = text;
      element.value = value;
      return element;
    };
    sourceFilter.replaceChildren(
      ...browse.sourceOptions.map((item) => option(item.label + " (" + item.count + ")", item.id)),
    );
    sourceFilter.value = filtersState.sourceId ?? "";
    renderSourceSummary();
    typeTabs.replaceChildren();
    const totalByType = browse.typeOptions.reduce((total, item) => total + item.count, 0);
    const addType = (id: string | undefined, label: string, count: number): void => {
      if (count === 0 && filtersState.kind !== id) return;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "workbench-type-tab";
      tw(
        tab,
        "shrink-0 px-2.5 py-1 rounded font-mono text-[10.5px] text-on-surface-variant hover:bg-surface-container transition-colors aria-pressed:bg-surface-container-highest aria-pressed:text-on-surface aria-pressed:font-semibold",
      );
      tab.dataset.workbenchType = id ?? "";
      tab.setAttribute("aria-pressed", String(filtersState.kind === id));
      tab.textContent = `${label} (${count})`;
      typeTabs.append(tab);
    };
    addType(undefined, "All", totalByType);
    for (const item of browse.typeOptions) addType(item.id, item.label, item.count);
    sourceTabs.replaceChildren();
    // admin-sources.html "Catalog scopes": the open scope is the highlighted
    // card (folder_open, primary name, green count); the others are quiet cards.
    for (const item of browse.sourceOptions) {
      const active = item.id === filtersState.sourceId;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "workbench-source-tab";
      tw(
        tab,
        active
          ? "flex items-center justify-between gap-1 w-full px-2.5 py-2 rounded border border-solid border-hairline bg-surface-container-low text-left font-medium"
          : "flex items-center justify-between gap-1 w-full px-2.5 py-2 rounded border border-solid border-hairline hover:bg-surface-container-low text-left font-medium transition-colors",
      );
      tab.dataset.workbenchSourceTab = item.id;
      tab.setAttribute("aria-pressed", String(active));
      const name = document.createElement("span");
      tw(name, "flex items-center gap-1.5 min-w-0 flex-1");
      const label = document.createElement("span");
      tw(
        label,
        active
          ? "text-primary truncate font-semibold text-[11.5px]"
          : "text-on-surface truncate font-semibold text-[11.5px]",
      );
      label.textContent = item.label + " ";
      name.append(
        glyph(active ? "folder_open" : "folder", active ? "text-primary" : "text-outline"),
        label,
      );
      const count = document.createElement("span");
      count.textContent = String(item.count);
      tw(
        count,
        active
          ? "font-mono text-[10px] px-1 rounded bg-surface-container-highest text-secondary font-bold shrink-0"
          : "font-mono text-[10.5px] px-1 text-outline shrink-0",
      );
      count.setAttribute("aria-hidden", "true");
      tab.append(name, count);
      sourceTabs.append(tab);
    }
  };
  const otherTypeMatchCount = (browse: ReturnType<typeof catalogBrowse>): number => {
    const selectedKind = filtersState.kind;
    if (selectedKind === undefined) return 0;
    return browse.typeOptions.reduce(
      (total, item) => total + (item.id === selectedKind ? 0 : item.count),
      0,
    );
  };
  const emptyBrowseMessage = (browse: ReturnType<typeof catalogBrowse>): string => {
    const query = filtersState.query?.trim();
    const selectedKind = filtersState.kind;
    if (selectedKind !== undefined) {
      const otherMatches = otherTypeMatchCount(browse);
      const item = otherMatches === 1 ? "item is" : "items are";
      const type = catalogKindLabel(selectedKind).toLowerCase();
      const scope = filtersState.sourceId === undefined ? "the catalog" : "the selected source";
      const subject = query ? `match "${query}"` : "are available";
      return (
        `No ${type} ${subject} in ${scope}.` +
        (otherMatches === 0 ? "" : ` ${otherMatches} ${item} available in other types.`)
      );
    }
    if (query) return `No catalog items match "${query}" in the selected source.`;
    const sourceId = filtersState.sourceId;
    return sourceId === undefined
      ? "No prepared catalog source is available."
      : `No catalog items are present in ${catalogSourceDisplayName(options.bundle, sourceId)}.`;
  };

  const renderBrowseResults = (browse: ReturnType<typeof catalogBrowse>): void => {
    renderSourceControls(browse);
    browseResults.hidden = !browse.active;
    if (!browse.active) {
      browseResults.replaceChildren();
      expandedAssetId = undefined;
      if (openDetailKey === undefined) renderIdleInspector();
      return;
    }
    if (browse.total === 0) {
      expandedAssetId = undefined;
      if (openDetailKey === undefined) renderIdleInspector();
      const empty = document.createElement("p");
      empty.className = "help";
      tw(empty, "m-0 text-[12px] text-on-surface-variant");
      empty.textContent = emptyBrowseMessage(browse);
      const otherMatches = otherTypeMatchCount(browse);
      if (filtersState.kind !== undefined && otherMatches > 0) {
        const showAll = document.createElement("button");
        showAll.type = "button";
        showAll.className = "btn sm secondary";
        tw(showAll, BTN_SECONDARY);
        showAll.dataset.workbenchShowAllTypes = "true";
        showAll.textContent = "Show all types";
        showAll.addEventListener(
          "click",
          () => {
            updateFilters({ ...filtersState, kind: undefined });
            queueMicrotask(() =>
              typeTabs.querySelector<HTMLButtonElement>('[data-workbench-type=""]')?.focus(),
            );
          },
          { signal: teardown.signal },
        );
        browseResults.replaceChildren(empty, showAll);
      } else browseResults.replaceChildren(empty);
      return;
    }
    if (expandedAssetId !== undefined && !browse.pageAssetIds.includes(expandedAssetId))
      expandedAssetId = undefined;
    renderRows(
      browseResults,
      browse.pageAssetIds,
      browse.page,
      (next) => {
        filtersState = { ...filtersState, page: next };
        expandedAssetId = undefined;
        openDetailKey = undefined;
        detailTrigger = undefined;
        inspectorOpen = false;
        syncInspectorPresentation();
        renderInventory();
      },
      browse.total,
      true,
    );
    if (openDetailKey === undefined && expandedAssetId === undefined) renderIdleInspector();
  };

  const renderInventory = (): void => {
    if (filtersState.sourceId === undefined && groups[0] !== undefined)
      filtersState = { ...filtersState, sourceId: groups[0].id, page: 0 };
    const browse = catalogBrowse(browseInventory, filtersState);
    renderBrowseResults(browse);
  };
  const previewList = (assetIds: readonly string[]): string => {
    const labels = assetIds
      .map((assetId) => options.bundle.assets[assetId])
      .filter((asset): asset is AuthoringAssetV1 => asset !== undefined)
      .map(humanizedAssetLabel);
    const visible = labels.slice(0, 6);
    return labels.length > visible.length
      ? visible.join(", ") + ", and " + (labels.length - visible.length) + " more"
      : visible.join(", ");
  };
  const showTemplatePreview = (
    template: AuthoringCatalogBundleV1["templates"][string],
    trigger: HTMLButtonElement,
  ): void => {
    const reduction = reduceWorkbenchAction(options.bundle, state, {
      type: "apply-template",
      templateId: template.id,
    });
    showDetails(
      "template:" + template.id,
      templateDetailsPresentation(template, options.bundle),
      trigger,
    );
    if (!inspectorOpen) return;
    const close = details.querySelector<HTMLButtonElement>(
      "[data-workbench-details-close]:not(.workbench-exposure-back)",
    );
    if (close !== null) close.textContent = "Cancel preview";
    const preview = document.createElement("section");
    preview.className = "workbench-template-preview";
    const heading = document.createElement("h4");
    heading.textContent = "Before you add this starting point";
    preview.append(heading);
    if (!reduction.accepted) {
      const message = document.createElement("p");
      message.textContent =
        reduction.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
        "This starting point cannot be added to the current draft.";
      preview.append(message);
    } else {
      const before = new Set(resolveWorkbenchSelection(options.bundle, state).assetIds);
      const after = new Set(resolveWorkbenchSelection(options.bundle, reduction.state).assetIds);
      const addedEffective = [...after].filter((assetId) => !before.has(assetId));
      const rootIds = new Set(
        reduction.state.roots
          .filter(
            (root) =>
              !state.roots.some(
                (beforeRoot) =>
                  beforeRoot.assetId === root.assetId &&
                  originKey(beforeRoot.origin) === originKey(root.origin),
              ),
          )
          .map((root) => root.assetId),
      );
      const addedRequests = reduction.state.requests.filter(
        (request) =>
          !state.requests.some(
            (beforeRequest) =>
              beforeRequest.assetId === request.assetId &&
              originKey(beforeRequest.origin) === originKey(request.origin),
          ),
      );
      const addedExclusions = reduction.state.exclusions.filter(
        (exclusion) =>
          !state.exclusions.some(
            (beforeExclusion) =>
              beforeExclusion.assetId === exclusion.assetId &&
              originKey(beforeExclusion.origin) === originKey(exclusion.origin),
          ),
      );
      const dependencies = addedEffective.filter((assetId) => !rootIds.has(assetId));
      const summary = document.createElement("p");
      summary.textContent =
        "This preview adds " +
        rootIds.size +
        " draft selection" +
        (rootIds.size === 1 ? "" : "s") +
        ", " +
        addedRequests.length +
        " request" +
        (addedRequests.length === 1 ? "" : "s") +
        ", " +
        addedExclusions.length +
        " exclusion" +
        (addedExclusions.length === 1 ? "" : "s") +
        ", and " +
        dependencies.length +
        (dependencies.length === 1 ? " required dependency" : " required dependencies") +
        ".";
      preview.append(summary);
      if (addedEffective.length > 0) {
        const included = document.createElement("p");
        included.textContent = "Affected items: " + previewList(addedEffective) + ".";
        preview.append(included);
      }
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "btn sm primary";
      confirm.dataset.workbenchTemplateId = template.id;
      confirm.textContent = "Add to draft";
      preview.append(confirm);
    }
    tw(
      preview,
      "p-2.5 rounded border border-solid border-wb-badge-border bg-wb-review-bg flex flex-col gap-1.5 text-[11px] min-w-0",
    );
    tw(heading, "m-0 text-tertiary font-semibold text-[11px]");
    (details.querySelector<HTMLElement>("[data-wb-inspector-body]") ?? details).append(preview);
  };
  const renderTemplates = (): void => {
    templateList.replaceChildren();
    const appliedOrigins = new Map<string, Extract<WorkbenchOriginV1, { kind: "template" }>>();
    for (const entry of [...state.roots, ...state.exclusions]) {
      if (entry.origin.kind === "template")
        appliedOrigins.set(originKey(entry.origin), entry.origin);
    }
    const activeSourceId = filtersState.sourceId;
    const available = Object.values(options.bundle.templates)
      .filter((template) =>
        [...template.roots.map((entry) => entry.assetId), ...template.exclusions].every(
          (assetId) => browseInventory.assets[assetId],
        ),
      )
      .filter(
        (template) =>
          activeSourceId === undefined ||
          (template.roots.length > 0 &&
            template.roots.every(
              (root) => options.bundle.assets[root.assetId]?.sourceId === activeSourceId,
            )),
      )
      .sort((left, right) => compareText(left.id, right.id));
    templateSummary.textContent =
      "Starting points" + (available.length === 0 ? "" : " (" + available.length + ")");
    templates.hidden = available.length === 0;
    if (!templates.open) return;
    for (const template of available) {
      const row = document.createElement("article");
      const title = document.createElement("h3");
      const description = document.createElement("p");
      const preview = document.createElement("button");
      row.className = "workbench-template-option";
      tw(
        row,
        "rounded border border-solid border-outline-variant bg-surface-card p-3 flex flex-col gap-1.5 min-w-0",
      );
      tw(title, "m-0 text-[13px] font-semibold font-mono text-on-surface");
      tw(description, "m-0 text-[11px] text-on-surface-variant");
      title.textContent = template.label ?? template.id;
      description.textContent =
        template.roots.length +
        " starting selection" +
        (template.roots.length === 1 ? "" : "s") +
        " and " +
        template.exclusions.length +
        " saved exclusion" +
        (template.exclusions.length === 1 ? "" : "s") +
        ".";
      preview.type = "button";
      preview.className = "btn sm secondary";
      tw(preview, `self-start ${BTN_SECONDARY}`);
      preview.dataset.workbenchTemplateDetailId = template.id;
      preview.setAttribute("aria-controls", details.id);
      preview.setAttribute("aria-expanded", String(openDetailKey === "template:" + template.id));
      preview.textContent = "Preview";
      row.append(title, description, preview);
      templateList.append(row);
    }
    for (const origin of [...appliedOrigins.values()].sort((left, right) =>
      compareText(originKey(left), originKey(right)),
    )) {
      if (
        !available.some(
          (template) => template.id === origin.id && template.digest === origin.digest,
        )
      )
        continue;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.workbenchTemplateRemoveId = origin.id;
      remove.dataset.workbenchTemplateRemoveDigest = origin.digest;
      const template = options.bundle.templates[origin.id];
      const templateLabel =
        template?.digest === origin.digest ? (template.label ?? origin.id) : origin.id;
      remove.textContent = "Remove starting point " + templateLabel;
      tw(remove, `self-start ${BTN_SECONDARY}`);
      templateList.append(remove);
    }
  };
  const savedEntryNeedsReview = (entry: {
    assetId: string;
    sourceId: string;
    sourceRevisionId: string;
    contentDigest: string;
  }): boolean => {
    const asset = options.bundle.assets[entry.assetId];
    return (
      asset === undefined ||
      asset.sourceId !== entry.sourceId ||
      asset.sourceRevisionId !== entry.sourceRevisionId ||
      asset.contentDigest !== entry.contentDigest
    );
  };
  let repairLimit = PAGE_SIZE;
  const renderRepairs = (): void => {
    repairs.replaceChildren();
    const entries = [
      ...state.roots
        .filter(savedEntryNeedsReview)
        .map((entry) => ({ type: "remove-root" as const, entry })),
      ...state.requests
        .filter(savedEntryNeedsReview)
        .map((entry) => ({ type: "remove-request" as const, entry })),
      ...state.exclusions
        .filter(savedEntryNeedsReview)
        .map((entry) => ({ type: "remove-exclusion" as const, entry })),
    ];
    const visibleEntries = entries.slice(0, repairLimit);
    const templateOrigins = new Map<string, Extract<WorkbenchOriginV1, { kind: "template" }>>();
    for (const { entry } of visibleEntries)
      if (entry.origin.kind === "template")
        templateOrigins.set(originKey(entry.origin), entry.origin);
    for (const origin of [...templateOrigins.values()].sort((left, right) =>
      compareText(originKey(left), originKey(right)),
    )) {
      const row = document.createElement("p");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.workbenchTemplateRemoveId = origin.id;
      remove.dataset.workbenchTemplateRemoveDigest = origin.digest;
      remove.textContent = "Remove " + origin.id;
      tw(remove, BTN_SECONDARY);
      tw(row, REPAIR_ROW);
      row.append("Saved template selection needs review: " + originLabel(origin) + ". ", remove);
      repairs.append(row);
    }
    for (const { type, entry } of visibleEntries) {
      if (entry.origin.kind === "template") continue;
      const row = document.createElement("p");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.workbenchRepairType = type;
      remove.dataset.workbenchRepairAssetId = entry.assetId;
      remove.dataset.workbenchRepairOrigin = entry.origin.kind;
      remove.textContent = "Remove saved " + type.replace("remove-", "") + ": " + entry.assetId;
      tw(remove, BTN_SECONDARY);
      tw(row, REPAIR_ROW);
      row.append(
        "Saved " +
          type.replace("remove-", "") +
          " needs review (" +
          originLabel(entry.origin) +
          "): " +
          entry.assetId +
          ". ",
        remove,
      );
      repairs.append(row);
    }
    if (entries.length > visibleEntries.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.dataset.workbenchRepairMore = "true";
      more.textContent = "Show more saved selections";
      tw(more, `self-start ${BTN_SECONDARY}`);
      repairs.append(more);
    }
    repairs.hidden = !repairs.hasChildNodes();
  };
  renderTemplates();
  renderRepairs();
  templates.addEventListener("toggle", renderTemplates, {
    signal: teardown.signal,
  });

  inventory.append(browseResults);

  for (const scope of scopes)
    scope.addEventListener(
      "click",
      (event) => {
        const target = event.target as Element;
        const panelView = target.closest<HTMLButtonElement>("[data-workbench-panel-view]");
        const draftOpen = target.closest<HTMLButtonElement>("[data-workbench-draft-open]");
        if (panelView !== null || draftOpen !== null) {
          const view = draftOpen !== null ? "draft" : panelView?.dataset.workbenchPanelView;
          if (view !== "item" && view !== "draft" && view !== "exposure") return;
          inspectorMode = view;
          inspectorOpen = true;
          openDetailKey = undefined;
          openCatalogDetail = undefined;
          expandedAssetId = undefined;
          comparisonPreview = undefined;
          if (draftOpen !== null || detailTrigger === undefined)
            detailTrigger = draftOpen ?? panelView ?? undefined;
          if (view === "item" && lastFullDetail !== undefined && detailTrigger !== undefined) {
            showDetails(
              lastFullDetail.key,
              lastFullDetail.presentation,
              detailTrigger,
              lastFullDetail.catalogDetail,
            );
          } else if (view === "item" && lastInspectedAssetId !== undefined) {
            expandedAssetId = lastInspectedAssetId;
            renderInventory();
          } else renderIdleInspector();
          updateDetailButtons();
          details.querySelector<HTMLElement>("#workbench-detail-title")?.focus();
          return;
        }
        const exposureOpen = target.closest<HTMLButtonElement>("[data-workbench-exposure-open]");
        if (exposureOpen !== null) {
          openDetailKey = undefined;
          expandedAssetId = undefined;
          comparisonPreview = undefined;
          detailTrigger = exposureOpen;
          inspectorOpen = true;
          updateDetailButtons();
          renderExposureOverview({ focusHeading: true });
          return;
        }
        if (target.closest<HTMLButtonElement>("[data-workbench-exposure-back]") !== null) {
          openDetailKey = undefined;
          expandedAssetId = undefined;
          comparisonPreview = undefined;
          updateDetailButtons();
          renderExposureOverview({ focusHeading: true });
          return;
        }
        if (target.closest<HTMLButtonElement>("[data-workbench-details-close]") !== null) {
          closeDetails();
          return;
        }
        const exposureInspect = target.closest<HTMLButtonElement>(
          "[data-workbench-exposure-inspect-id]",
        );
        const exposureAssetId = exposureInspect?.dataset.workbenchExposureInspectId;
        if (exposureInspect !== null && exposureAssetId !== undefined) {
          const asset = options.bundle.assets[exposureAssetId];
          if (asset === undefined) return;
          if (browseInventory.assets[asset.id] === undefined) {
            showDetails(
              "asset:" + asset.id,
              assetDetailsPresentation(asset, options.bundle),
              exposureInspect,
              { asset, mode: "catalog" },
            );
            return;
          }
          templates.open = false;
          templateList.replaceChildren();
          filtersState = {
            sourceId: asset.sourceId,
            kind: asset.kind,
            query: asset.id,
            page: 0,
          };
          search.value = asset.id;
          openDetailKey = undefined;
          expandedAssetId = asset.id;
          comparisonPreview = undefined;
          detailTrigger = exposureInspect;
          inspectorOpen = true;
          renderInventory();
          scopeOne<HTMLElement>("#workbench-detail-title")?.focus();
          return;
        }
        const repairButton = target.closest<HTMLButtonElement>("[data-workbench-repair-type]");
        const repairType = repairButton?.dataset.workbenchRepairType;
        const repairAssetId = repairButton?.dataset.workbenchRepairAssetId;
        const repairOrigin = repairButton?.dataset.workbenchRepairOrigin;
        if (
          repairType !== undefined &&
          repairAssetId !== undefined &&
          (repairOrigin === "administrator" || repairOrigin === "legacy-unattributed")
        ) {
          const result = options.dispatch({
            type: repairType as "remove-root" | "remove-request" | "remove-exclusion",
            assetId: repairAssetId,
            origin: { kind: repairOrigin },
          });
          if (result.accepted) {
            acceptState(result.state);
            showDiagnostics(result);
            refresh();
          } else
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Saved selection removal rejected.";
          return;
        }
        if (target.closest<HTMLButtonElement>("[data-workbench-repair-more]") !== null) {
          repairLimit += PAGE_SIZE;
          renderRepairs();
          return;
        }
        const draftId = target.closest<HTMLButtonElement>("[data-workbench-draft-id]")?.dataset
          .workbenchDraftId;
        if (draftId !== undefined) {
          const result = options.dispatch({ type: "remove-draft", id: draftId });
          if (result.accepted) {
            acceptState(result.state);
            showDiagnostics(result);
            refresh();
          } else
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Draft removal rejected.";
          return;
        }
        const exclusionId = target.closest<HTMLButtonElement>("[data-workbench-exclusion-id]")
          ?.dataset.workbenchExclusionId;
        if (exclusionId !== undefined) {
          const result = options.dispatch(
            state.exclusions.some(
              (exclusion) =>
                exclusion.assetId === exclusionId && exclusion.origin.kind === "administrator",
            )
              ? {
                  type: "remove-exclusion",
                  assetId: exclusionId,
                  origin: administratorOrigin,
                }
              : {
                  type: "add-exclusion",
                  assetId: exclusionId,
                  origin: administratorOrigin,
                },
          );
          if (result.accepted) {
            const previous = state;
            acceptState(result.state);
            showDiagnostics(result);
            refreshCounts();
            renderDraftReview();
            refreshVisibleRows(changedAssetIds(previous, state));
            renderSourceSummary();
            refreshActiveInspector();
            queueMicrotask(() =>
              [...scopeAll<HTMLButtonElement>("[data-workbench-exclusion-id]")]
                .find((button) => button.dataset.workbenchExclusionId === exclusionId)
                ?.focus({ preventScroll: true }),
            );
          } else
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Exclusion rejected.";
          return;
        }
        const removeTemplate = target.closest<HTMLButtonElement>(
          "[data-workbench-template-remove-id]",
        );
        const removeTemplateId = removeTemplate?.dataset.workbenchTemplateRemoveId;
        const removeTemplateDigest = removeTemplate?.dataset.workbenchTemplateRemoveDigest;
        if (removeTemplateId !== undefined && removeTemplateDigest !== undefined) {
          const fromDraftReview =
            removeTemplate !== null && draftReviewList.contains(removeTemplate);
          const result = options.dispatch({
            type: "remove-template",
            templateId: removeTemplateId,
            digest: removeTemplateDigest,
          });
          if (result.accepted) {
            acceptState(result.state);
            showDiagnostics(result);
            refresh();
            if (fromDraftReview) {
              if (compactInspector.matches && inspectorOpen)
                details.querySelector<HTMLElement>("#workbench-detail-title")?.focus();
              else draftReviewSummary.focus();
            }
          } else
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Template removal rejected.";
          return;
        }
        const templateDetailButton = target.closest<HTMLButtonElement>(
          "[data-workbench-template-detail-id]",
        );
        const templateDetailId = templateDetailButton?.dataset.workbenchTemplateDetailId;
        if (templateDetailId !== undefined && templateDetailButton !== null) {
          const template = options.bundle.templates[templateDetailId];
          if (template !== undefined) showTemplatePreview(template, templateDetailButton);
          return;
        }
        const templateId = target.closest<HTMLButtonElement>("[data-workbench-template-id]")
          ?.dataset.workbenchTemplateId;
        if (templateId !== undefined) {
          const result = options.dispatch({ type: "apply-template", templateId });
          if (result.accepted) {
            acceptState(result.state);
            showDiagnostics(result);
            refresh();
          } else
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Template rejected.";
          return;
        }
        if (target.closest<HTMLButtonElement>("[data-workbench-comparison-cancel]") !== null) {
          const assetId = comparisonPreview?.assetId;
          comparisonPreview = undefined;
          renderInventory();
          if (assetId !== undefined) restoreComparisonFocus(assetId, "expand");
          return;
        }
        const comparisonConfirm = target.closest<HTMLButtonElement>(
          "[data-workbench-comparison-confirm-id]",
        );
        const comparisonAssetId = comparisonConfirm?.dataset.workbenchComparisonConfirmId;
        if (comparisonAssetId !== undefined && comparisonPreview?.assetId === comparisonAssetId) {
          const comparisonAsset = options.bundle.assets[comparisonAssetId];
          if (comparisonAsset === undefined) return;
          const comparison = selectionComparisonPresentation(
            comparisonAsset,
            options.bundle,
            state,
          );
          if (
            !workbenchStatesEqualV1(state, comparisonPreview.expectedState) ||
            comparison.kind !== "conflict" ||
            !comparison.preview.accepted ||
            comparison.preview.action === undefined
          ) {
            comparisonPreview = undefined;
            diagnostics.textContent = "The draft changed. Review the replacement again.";
            renderInventory();
            restoreComparisonFocus(comparisonAssetId, "expand");
            return;
          }
          const result = options.dispatch(
            comparison.preview.action,
            comparisonPreview.expectedState,
          );
          if (result.accepted) {
            acceptState(result.state);
            showDiagnostics(result);
            refresh();
            restoreComparisonFocus(comparisonAssetId, "primary");
          } else {
            acceptState(result.state);
            comparisonPreview = undefined;
            diagnostics.textContent =
              result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
              "Replacement rejected. Review the current draft again.";
            renderInventory();
            restoreComparisonFocus(comparisonAssetId, "expand");
          }
          return;
        }
        const expandButton = target.closest<HTMLButtonElement>("[data-workbench-expand-id]");
        const expandId = expandButton?.dataset.workbenchExpandId;
        if (expandId !== undefined && expandButton !== null) {
          expandedAssetId = expandId;
          openDetailKey = undefined;
          comparisonPreview = undefined;
          detailTrigger = expandButton;
          inspectorOpen = true;
          syncInspectorPresentation();
          renderInventory();
          scopeOne<HTMLElement>("#workbench-detail-title")?.focus();
          return;
        }
        const detailButton = target.closest<HTMLButtonElement>("[data-workbench-detail-id]");
        const detailId = detailButton?.dataset.workbenchDetailId;
        if (detailId !== undefined && detailButton !== null) {
          const detailAsset = options.bundle.assets[detailId];
          if (detailAsset !== undefined)
            showDetails(
              "asset:" + detailAsset.id,
              assetDetailsPresentation(detailAsset, options.bundle),
              detailButton,
            );
          return;
        }
        const button = target.closest<HTMLButtonElement>(
          "button[data-workbench-row-action][data-workbench-asset-id], button[data-workbench-inspector-action]",
        );
        const assetId = button?.dataset.workbenchAssetId;
        const asset = assetId === undefined ? undefined : options.bundle.assets[assetId];
        if (asset === undefined || button === null) return;
        const action = actionFor(asset, state);
        if (action === undefined) {
          if (asset.authoring.action === "inspect-evidence") {
            showDetails(
              "asset:" + asset.id,
              assetDetailsPresentation(asset, options.bundle),
              button,
            );
            options.inspectEvidence?.(asset);
          }
          if (asset.authoring.action === "prepare-approval") options.prepareApproval?.(asset);
          return;
        }
        if (action.type === "select-root" || action.type === "record-request") {
          const comparison = selectionComparisonPresentation(asset, options.bundle, state);
          if (comparison.kind === "conflict" && comparison.preview.accepted) {
            expandedAssetId = asset.id;
            openDetailKey = undefined;
            detailTrigger = button;
            inspectorOpen = true;
            syncInspectorPresentation();
            comparisonPreview = {
              assetId: asset.id,
              expectedState: structuredClone(state),
            };
            renderInventory();
            scopeOne<HTMLElement>("[data-workbench-comparison-heading]")?.focus();
            return;
          }
        }
        const result = options.dispatch(action);
        if (!result.accepted) {
          diagnostics.textContent =
            result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
            "Selection rejected.";
          return;
        }
        showDiagnostics(result);
        const previous = state;
        acceptState(result.state);
        refreshCounts();
        renderDraftReview();
        refreshVisibleRows(changedAssetIds(previous, state));
        renderSourceSummary();
        refreshActiveInspector();
      },
      { signal: teardown.signal },
    );
  const restoreComparisonFocus = (assetId: string, action: "expand" | "primary"): void => {
    queueMicrotask(() => {
      const replacement = [...scopeAll<HTMLButtonElement>("button")].find((button) =>
        action === "expand"
          ? button.dataset.workbenchExpandId === assetId
          : button.dataset.workbenchAssetId === assetId &&
            button.dataset.workbenchRowAction !== undefined,
      );
      replacement?.focus();
    });
  };
  const updateFilters = (next: CatalogBrowseFilters, preferredAssetId?: string): void => {
    filtersState = { ...next, page: 0 };
    openDetailKey = undefined;
    detailTrigger = undefined;
    comparisonPreview = undefined;
    expandedAssetId = preferredAssetId;
    inspectorOpen = false;
    syncInspectorPresentation();
    if (search.value !== (filtersState.query ?? "")) search.value = filtersState.query ?? "";
    renderInventory();
  };
  const selectSource = (sourceId: string | undefined, focusSearch: boolean): void => {
    if (sourceId === undefined || sourceId === filtersState.sourceId) return;
    templates.open = false;
    templateList.replaceChildren();
    updateFilters({ sourceId, query: filtersState.query, kind: undefined });
    renderTemplates();
    if (focusSearch) search.focus();
  };
  sourceFilter.addEventListener(
    "change",
    () => {
      selectSource(sourceFilter.value || undefined, false);
      queueMicrotask(() => sourceFilter.focus());
    },
    { signal: teardown.signal },
  );
  typeTabs.addEventListener(
    "click",
    (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>("[data-workbench-type]");
      if (tab === null) return;
      const kind = tab.dataset.workbenchType || undefined;
      updateFilters({ ...filtersState, kind });
      queueMicrotask(() => {
        [...typeTabs.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.dataset.workbenchType === (kind ?? ""))
          ?.focus();
      });
    },
    { signal: teardown.signal },
  );
  sourceTabs.addEventListener(
    "click",
    (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>(
        "[data-workbench-source-tab]",
      );
      const sourceId = tab?.dataset.workbenchSourceTab;
      selectSource(sourceId, false);
      queueMicrotask(() => {
        [...sourceTabs.querySelectorAll<HTMLButtonElement>("button")]
          .find((candidate) => candidate.dataset.workbenchSourceTab === sourceId)
          ?.focus();
      });
    },
    { signal: teardown.signal },
  );
  search.addEventListener(
    "input",
    () => updateFilters({ ...filtersState, query: search.value || undefined }),
    { signal: teardown.signal },
  );

  const renderDraftRows = (): void => {
    draftList.replaceChildren();
    if (!drafts.open) return;
    for (const draft of state.drafts) {
      const row = document.createElement("p");
      const remove = document.createElement("button");
      row.textContent =
        "Local draft · requires Core preparation: " +
        draft.id +
        " (" +
        draft.declaration.kind +
        ") ";
      remove.type = "button";
      remove.dataset.workbenchDraftId = draft.id;
      remove.textContent = "Remove draft";
      row.append(remove);
      draftList.append(row);
    }
  };
  const refreshDrafts = (): void => {
    draftSummaryControl.textContent = "Prepared local drafts (" + state.drafts.length + ")";
    drafts.hidden = state.drafts.length === 0;
    renderDraftRows();
  };
  const renderDraftReview = (): void => {
    const entries: Array<{
      category: string;
      assetId: string;
      origin?: WorkbenchOriginV1;
      needsReview?: boolean;
      savedEntry?:
        | WorkbenchStateV1["roots"][number]
        | WorkbenchStateV1["requests"][number]
        | WorkbenchStateV1["exclusions"][number];
      entryKind?: "root" | "request" | "exclusion";
    }> = [];
    const rootIds = new Set(state.roots.map((root) => root.assetId));
    for (const root of state.roots) {
      const needsReview = savedEntryNeedsReview(root);
      entries.push({
        category: needsReview
          ? "Saved choice needs review"
          : root.mode === "structural"
            ? "Grouping choice"
            : "Saved choice",
        assetId: root.assetId,
        origin: root.origin,
        needsReview,
        savedEntry: root,
        entryKind: "root",
      });
    }
    const resolved = resolveWorkbenchSelection(options.bundle, state);
    for (const assetId of resolved.assetIds)
      if (!rootIds.has(assetId)) entries.push({ category: "Included dependency", assetId });
    for (const request of state.requests) {
      const needsReview = savedEntryNeedsReview(request);
      entries.push({
        category: needsReview ? "Request needs review" : "Request",
        assetId: request.assetId,
        origin: request.origin,
        needsReview,
        savedEntry: request,
        entryKind: "request",
      });
    }
    for (const exclusion of state.exclusions) {
      const needsReview = savedEntryNeedsReview(exclusion);
      entries.push({
        category: needsReview ? "Exclusion needs review" : "Exclusion",
        assetId: exclusion.assetId,
        origin: exclusion.origin,
        needsReview,
        savedEntry: exclusion,
        entryKind: "exclusion",
      });
    }
    draftReviewSummary.textContent = "Review draft (" + entries.length + " entries)";
    draftReviewSummary.prepend(dot("bg-tertiary"));
    draftReviewSummary.append(glyph("arrow_forward", "w-3 h-3"));
    draftEntryCount = entries.length;
    options.onDraftCount?.(entries.length);
    draftReviewList.replaceChildren();
    syncInspectorPresentation();
    if (inspectorMode !== "draft") return;
    const heading = document.createElement("h3");
    const intro = document.createElement("p");
    const back = document.createElement("button");
    heading.id = "workbench-detail-title";
    heading.tabIndex = -1;
    heading.textContent = "Review draft";
    tw(heading, "m-0 font-semibold text-on-surface text-[13px] font-mono");
    intro.textContent = `${entries.length} saved entries. Changes here update your policy draft.`;
    intro.className = "help";
    tw(intro, "m-0 text-[11px] text-outline font-mono");
    back.type = "button";
    back.className = "workbench-exposure-back";
    tw(back, FOOTER_BUTTON);
    back.dataset.workbenchDetailsClose = "true";
    back.textContent = "Back to catalog";
    tw(draftReviewList, "flex flex-col gap-1.5 min-w-0");
    const draftHeader = inspectorNode("div", "flex flex-col gap-1 min-w-0");
    draftHeader.append(inspectorNode("span", INSPECTOR_LABEL, "Draft review"), heading, intro);
    details.dataset.workbenchInspectorView = "draft";
    details.removeAttribute("data-workbench-inspector-asset-id");
    details.setAttribute("aria-labelledby", heading.id);
    details.replaceChildren(
      inspectorHead(),
      inspectorBody(draftHeader, draftReviewList),
      inspectorFooter(back),
    );
    syncInspectorPresentation();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      tw(
        empty,
        "m-0 p-3 rounded border border-dashed border-hairline bg-surface-container-low text-[11.5px] text-on-surface-variant",
      );
      empty.textContent = "This draft has no saved choices, requests, dependencies, or exclusions.";
      draftReviewList.append(empty);
      return;
    }
    const adoption =
      options.adoptionBindings === undefined
        ? undefined
        : planWorkbenchAdoptionV1(options.bundle, state, options.adoptionBindings);
    if (adoption !== undefined && !adoption.accepted) {
      const problem = document.createElement("p");
      problem.className = "workbench-overlap-notice";
      tw(
        problem,
        "m-0 p-2.5 rounded border border-solid border-wb-badge-border bg-wb-review-bg text-[11px] text-on-surface leading-snug",
      );
      problem.setAttribute("role", "status");
      problem.textContent =
        "This draft needs repair before adoption commands are available. " +
        adoption.diagnostics.join(" ");
      draftReviewList.append(problem);
    }
    const shownTemplates = new Set<string>();
    for (const entry of pageItems(entries, draftReviewPage)) {
      const row = document.createElement("article");
      const category = document.createElement("p");
      const title = document.createElement("h3");
      const origin = document.createElement("p");
      const detailsButton = document.createElement("button");
      const asset = options.bundle.assets[entry.assetId];
      row.className = "workbench-draft-review-item";
      tw(
        row,
        "p-2.5 rounded bg-surface-container-low border border-solid border-hairline flex flex-col gap-1.5 min-w-0",
      );
      category.className = "workbench-draft-review-category";
      tw(
        category,
        `m-0 self-start px-1.5 py-0.5 rounded border border-solid font-mono text-[9.5px] uppercase tracking-wider font-semibold ${entry.needsReview === true ? "bg-wb-review-bg border-wb-badge-border text-wb-review" : "bg-surface-container border-hairline text-outline"}`,
      );
      category.textContent = entry.category;
      tw(title, "m-0 font-mono font-bold text-[12px] text-on-surface break-words");
      tw(origin, "m-0 font-mono text-[10px] text-outline");
      title.textContent =
        entry.needsReview || asset === undefined
          ? "Saved item: " + entry.assetId
          : humanizedAssetLabel(asset);
      row.append(category, title);
      if (entry.needsReview || asset === undefined) {
        const help = document.createElement("p");
        help.className = "workbench-review-context";
        help.textContent =
          adoption?.items.find((item) => item.assetId === entry.assetId)?.nextAction ??
          "The source or version for this saved item is no longer in the current catalog. Remove the old choice, or review and select its current version. Your saved record is preserved.";
        row.append(help);
      }
      if (entry.origin !== undefined) {
        origin.textContent = "Origin: " + originLabel(entry.origin);
        row.append(origin);
        if (entry.origin.kind === "template" && !shownTemplates.has(originKey(entry.origin))) {
          shownTemplates.add(originKey(entry.origin));
          const template = options.bundle.templates[entry.origin.id];
          const currentDefinition = template?.digest === entry.origin.digest;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "btn sm secondary";
          remove.dataset.workbenchTemplateRemoveId = entry.origin.id;
          remove.dataset.workbenchTemplateRemoveDigest = entry.origin.digest;
          remove.textContent =
            "Remove all choices from " +
            (currentDefinition ? (template.label ?? template.id) : entry.origin.id);
          const help = document.createElement("p");
          help.textContent =
            (currentDefinition
              ? ""
              : "The saved starting point definition is no longer current. ") +
            "Removes its saved choices, requests, and exclusions together. Other origins are kept.";
          const removal = document.createElement("div");
          removal.className = "workbench-template-removal";
          tw(removal, "flex flex-col items-start gap-1");
          removal.append(help, remove);
          row.append(removal);
        }
      }
      if (
        (isDeveloperToolCatalogAssetId(entry.assetId) || entry.assetId === "aih/github") &&
        entry.savedEntry !== undefined &&
        entry.entryKind !== undefined &&
        entry.origin !== undefined &&
        (entry.origin.kind === "administrator" || entry.origin.kind === "legacy-unattributed")
      ) {
        const retained = document.createElement("p");
        const remove = document.createElement("button");
        const kind =
          entry.entryKind === "root"
            ? "choice"
            : entry.entryKind === "request"
              ? "request"
              : "exclusion";
        const label = asset === undefined ? entry.assetId : humanizedAssetLabel(asset);
        retained.className = "workbench-review-context";
        retained.textContent = isDeveloperToolCatalogAssetId(entry.assetId)
          ? "This saved catalog entry is retained for compatibility. Developer tool setup owns new choices for this tool."
          : "This saved catalog entry is retained for compatibility. GitHub is not part of the Core baseline.";
        remove.type = "button";
        remove.className = "btn sm secondary";
        remove.dataset.workbenchSetupPinRemoveId = entry.assetId;
        remove.dataset.workbenchRepairType =
          entry.entryKind === "root"
            ? "remove-root"
            : entry.entryKind === "request"
              ? "remove-request"
              : "remove-exclusion";
        remove.dataset.workbenchRepairAssetId = entry.assetId;
        remove.dataset.workbenchRepairOrigin = entry.origin.kind;
        remove.textContent = "Remove saved catalog " + kind;
        remove.setAttribute("aria-label", `Remove saved catalog ${kind} for ${label}`);
        row.append(retained, remove);
      }
      if (asset !== undefined && !entry.needsReview) {
        const decision = assetDecisionPresentation(asset, options.bundle);
        const evidence = assetEvidencePresentation(asset, options.bundle);
        const context = document.createElement("section");
        context.className = "workbench-review-context";
        tw(context, "flex flex-col gap-1 min-w-0");
        const purpose = document.createElement("p");
        purpose.textContent = decision.purpose;
        const consequence = document.createElement("p");
        consequence.textContent =
          entry.entryKind === "exclusion"
            ? "This is an administrator exclusion. It does not erase other saved requests."
            : decision.consequence;
        const report = document.createElement("p");
        tw(
          report,
          "m-0 self-start px-1.5 py-0.5 rounded font-mono text-[10px] font-medium bg-surface-container text-on-surface-variant data-[workbench-evidence-tone=positive]:bg-wb-pass-bg data-[workbench-evidence-tone=positive]:text-wb-pass data-[workbench-evidence-tone=warning]:bg-wb-review-bg data-[workbench-evidence-tone=warning]:text-wb-review",
        );
        report.dataset.workbenchEvidenceTone = evidence.tone;
        report.textContent =
          evidence.statusLabel +
          (evidence.findings.length === 0
            ? ""
            : " · " + evidence.findings.length + " findings to review");
        const adoptionDetails = document.createElement("details");
        const adoptionSummary = document.createElement("summary");
        adoptionSummary.textContent = "Adoption details";
        adoptionDetails.append(adoptionSummary, consequence);
        context.append(purpose, report, adoptionDetails);
        if (entry.entryKind !== "exclusion") {
          const handoff = adoption?.items.find((item) => item.assetId === asset.id);
          if (handoff !== undefined) {
            const next = document.createElement("p");
            next.textContent = "Next step: " + handoff.nextAction;
            adoptionDetails.append(next);
            if (adoption?.accepted && handoff.command !== undefined) {
              const command = document.createElement("code");
              tw(
                command,
                "block mt-1 p-2 rounded bg-surface-container-lowest border border-solid border-hairline font-mono text-[10.5px] text-on-surface break-all",
              );
              command.textContent = handoff.command;
              adoptionDetails.append(command);
            }
          }
        }
        row.append(context);
        const savedEntry = entry.savedEntry;
        const entryKind = entry.entryKind;
        if (savedEntry !== undefined && entryKind !== undefined) {
          const reasonPanel = document.createElement("div");
          const reasonDisclosure = document.createElement("details");
          const reasonSummary = document.createElement("summary");
          reasonDisclosure.className = "workbench-review-rationale";
          reasonSummary.textContent = savedEntry.rationale ? "Edit reason" : "Add a reason";
          reasonPanel.className = "workbench-review-reason";
          tw(reasonPanel, "flex flex-col gap-1.5 pt-1.5");
          const label = document.createElement("label");
          tw(label, "text-[10px] font-mono uppercase tracking-wider text-outline font-semibold");
          const reason = document.createElement("textarea");
          tw(reason, WB_TEXTAREA);
          reason.id = "workbench-reason-" + draftReviewList.children.length;
          reason.name = "selection-rationale";
          reason.maxLength = 1000;
          reason.rows = 2;
          reason.value = savedEntry.rationale ?? "";
          reason.placeholder =
            "Why this choice? For example: use this MCP for local code review; omit the duplicate from ECC.";
          label.htmlFor = reason.id;
          label.textContent =
            "Your reason for " + humanizedAssetLabel(asset) + " (saved in the policy)";
          const save = document.createElement("button");
          save.type = "button";
          save.className = "btn sm secondary";
          tw(save, "self-start");
          save.textContent = "Save reason";
          const feedback = document.createElement("span");
          tw(feedback, "text-[10.5px] font-mono text-outline empty:hidden");
          feedback.setAttribute("role", "status");
          save.addEventListener("click", () => {
            const rationale = reason.value.trim().normalize("NFC");
            const result = options.dispatch(
              {
                type: "set-rationale",
                entry: entryKind,
                assetId: savedEntry.assetId,
                origin: savedEntry.origin,
                sourceId: savedEntry.sourceId,
                sourceRevisionId: savedEntry.sourceRevisionId,
                contentDigest: savedEntry.contentDigest,
                ...(rationale === "" ? {} : { rationale }),
              },
              state,
            );
            if (result.accepted) {
              acceptState(result.state);
              feedback.textContent =
                rationale === "" ? "Reason cleared." : "Reason saved in this policy draft.";
            } else
              feedback.textContent =
                result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
                "The reason could not be saved. Review this item's current version.";
          });
          reasonPanel.append(label, reason, save, feedback);
          reasonDisclosure.append(reasonSummary, reasonPanel);
          row.append(reasonDisclosure);
        }
        detailsButton.type = "button";
        detailsButton.className = "btn sm secondary";
        detailsButton.dataset.workbenchDetailId = asset.id;
        detailsButton.setAttribute("aria-controls", details.id);
        detailsButton.setAttribute("aria-label", "Read details for " + humanizedAssetLabel(asset));
        tw(detailsButton, "self-start");
        detailsButton.textContent =
          previousCatalogReportPresentation(
            asset,
            options.bundle,
            options.referenceReports?.[asset.id],
          ) === undefined
            ? "Read details"
            : "Read previous report";
        row.append(detailsButton);
      }
      draftReviewList.append(row);
    }
    renderPageControls(
      draftReviewList,
      draftReviewPage,
      entries.length,
      (next) => {
        draftReviewPage = Math.max(0, next);
        renderDraftReview();
      },
      draftReviewSummary,
    );
  };
  drafts.addEventListener("toggle", renderDraftRows, {
    signal: teardown.signal,
  });

  const refreshKindLedger = (): void => {
    const mount = document.querySelector("[data-kind-ledger-mount]");
    if (mount === null) return;
    const selectedAssetIds = resolveWorkbenchSelection(options.bundle, state).assetIds;
    // Same population as the visible catalog (browseBundle hides setup-owned assets).
    mountKindLedger(mount, Object.values(browseBundle.assets), selectedAssetIds);
  };

  const refresh = (): void => {
    refreshCounts();
    renderDraftReview();
    refreshDrafts();
    renderTemplates();
    renderRepairs();
    renderInventory();
    refreshKindLedger();
    scheduleEvidenceRefresh();
  };
  refresh();
  return {
    state: () => state,
    restore(nextState, nextDiagnostics = []) {
      acceptState(nextState);
      diagnostics.textContent = nextDiagnostics.join(" ");
      refresh();
    },
    dispatch(action, expectedState) {
      const result = options.dispatch(action, expectedState);
      if (result.accepted) {
        acceptState(result.state);
        showDiagnostics(result);
        refresh();
      }
      return result;
    },
    inspectAssetDetails(assetId, trigger) {
      const asset = options.bundle.assets[assetId];
      if (asset === undefined) return;
      showDetails("asset:" + asset.id, developerToolDetailsPresentation(asset), trigger, {
        asset,
        mode: "developer-tool-setup",
      });
    },
    showInspectorView(view) {
      inspectorNavigation
        .querySelector<HTMLButtonElement>(`[data-workbench-panel-view="${view}"]`)
        ?.click();
    },
    destroy: () => {
      if (evidenceRefreshTimer !== undefined) clearTimeout(evidenceRefreshTimer);
      teardown.abort();
    },
  };
}
