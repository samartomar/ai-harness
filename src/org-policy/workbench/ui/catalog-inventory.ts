import {
  type CatalogBrowseFilters,
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
  sourceEvidenceSummary,
  templateDetailsPresentation,
} from "./catalog-presentation.js";
import {
  mcpRuntimeOverlapPresentation,
  selectionComparisonPresentation,
} from "./selection-comparison.js";

export interface WorkbenchMountOptions {
  bundle: AuthoringCatalogBundleV1;
  adoptionBindings?: WorkbenchPolicyBindingsV1;
  initialState: WorkbenchStateV1;
  initialDiagnostics?: readonly string[];
  dispatch(action: WorkbenchActionV1, expectedState?: WorkbenchStateV1): WorkbenchReductionV1;
  inspectEvidence?(asset: AuthoringAssetV1): void;
  prepareApproval?(asset: AuthoringAssetV1): void;
}

export interface MountedWorkbench {
  state(): WorkbenchStateV1;
  restore(state: WorkbenchStateV1, diagnostics?: readonly string[]): void;
  dispatch(action: WorkbenchActionV1, expectedState?: WorkbenchStateV1): WorkbenchReductionV1;
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

function assetLabel(asset: AuthoringAssetV1): string {
  return `${asset.label}\u0000${asset.id}`;
}

const administratorOrigin: WorkbenchOriginV1 = { kind: "administrator" };

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
 * Generic, source-neutral Workbench inventory. Detail chunks are intentionally
 * absent: callers mount them only after their Core-prepared chunk is opened.
 */
export function mountWorkbench(
  root: HTMLElement,
  options: WorkbenchMountOptions,
): MountedWorkbench {
  let state = options.initialState;
  const groups = sourceGroups(options.bundle);
  const teardown = new AbortController();
  const draftSummary = document.createElement("section");
  const draftSummaryHeading = document.createElement("h2");
  const draftSummaryIntro = document.createElement("p");
  const counts = document.createElement("p");
  const draftReview = document.createElement("details");
  const draftReviewSummary = document.createElement("summary");
  const draftReviewList = document.createElement("div");
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
  const details = document.createElement("section");
  details.className = "workbench-detail";
  details.id = "workbench-detail-panel";
  details.dataset.workbenchDetail = "true";
  details.hidden = true;
  let filtersState: CatalogBrowseFilters = { sourceId: groups[0]?.id };
  let openDetailKey: string | undefined;
  let detailTrigger: HTMLButtonElement | undefined;
  let evidenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let draftReviewPage = 0;
  let expandedAssetId: string | undefined;
  let comparisonPreview: { assetId: string; expectedState: WorkbenchStateV1 } | undefined;

  root.replaceChildren();
  root.classList.add("workbench-inventory");
  draftSummary.className = "workbench-draft-summary";
  draftSummary.dataset.workbenchDraftSummary = "true";
  draftSummaryHeading.textContent = "Build your policy";
  draftSummaryIntro.textContent =
    "Save source-scoped choices, then review the combined draft before Core checks it against a repository.";
  counts.className = "workbench-draft-counts";
  counts.setAttribute("aria-live", "polite");
  draftReview.className = "workbench-draft-review";
  draftReviewSummary.textContent = "Review draft";
  draftReviewList.className = "workbench-draft-review-list";
  draftReview.append(draftReviewSummary, draftReviewList);
  draftSummary.append(draftSummaryHeading, draftSummaryIntro, counts, draftReview);
  templateSummary.textContent = "Starting points";
  templateList.className = "workbench-template-list";
  templates.className = "workbench-starting-points";
  templates.append(templateSummary, templateList);
  draftSummaryControl.textContent = "Prepared local drafts";
  draftList.className = "workbench-draft-list";
  drafts.className = "workbench-drafts";
  drafts.append(draftSummaryControl, draftList);
  sourceTabs.className = "workbench-source-tabs";
  sourceTabs.setAttribute("aria-label", "Catalog sources");
  filters.className = "workbench-catalog-filters";
  const sourceLabel = document.createElement("label");
  sourceLabel.className = "workbench-source-picker";
  sourceLabel.textContent = "Choose source";
  sourceLabel.htmlFor = "workbench-source-filter";
  sourceLabel.append(sourceFilter);
  filters.append(sourceLabel);
  sourceFilter.setAttribute("aria-label", "Choose catalog source");
  sourceReview.className = "workbench-source-review";
  browseTools.className = "workbench-browse-tools";
  typeTabs.className = "workbench-type-tabs";
  typeTabs.setAttribute("aria-label", "Catalog item types");
  browseTools.append(search, typeTabs);
  sourceFilter.id = "workbench-source-filter";
  sourceFilter.name = "workbench-source-filter";
  search.type = "search";
  search.id = "workbench-catalog-search";
  search.name = "workbench-catalog-search";
  search.placeholder = "Search catalog";
  search.setAttribute("aria-label", "Search catalog");
  inventory.setAttribute("aria-label", "Catalog inventory");
  browseResults.setAttribute("aria-label", "Catalog browse results");
  templates.setAttribute("aria-label", "Selection templates");
  repairs.setAttribute("aria-label", "Saved selections needing review");
  drafts.setAttribute("aria-label", "Prepared local drafts");
  diagnostics.className = "help error";
  root.append(
    draftSummary,
    sourceTabs,
    filters,
    sourceReview,
    browseTools,
    diagnostics,
    templates,
    repairs,
    drafts,
    inventory,
    details,
  );

  const refreshCounts = (): void => {
    const value = workbenchSelectionCounts(options.bundle, state);
    const controls = document.createElement("span");
    const selections = document.createElement("span");
    const requests = document.createElement("span");
    controls.textContent = "Controls " + value.selectedControlCount;
    controls.title = "Controls selected directly in this portable draft.";
    selections.textContent = "Selections " + value.rootCount;
    selections.title = "Choices saved in this portable draft, including grouping context.";
    requests.textContent = "Requests " + value.requestCount;
    requests.title = "Items awaiting later Core review, not active controls.";
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
    previous.className = next.className = "btn sm secondary";
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
    range.textContent = `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} items`;
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
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-workbench-detail-id]"))
      button.setAttribute(
        "aria-expanded",
        String(openDetailKey === "asset:" + button.dataset.workbenchDetailId),
      );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-workbench-template-detail-id]",
    ))
      button.setAttribute(
        "aria-expanded",
        String(openDetailKey === "template:" + button.dataset.workbenchTemplateDetailId),
      );
  };
  const closeDetails = (): void => {
    const trigger = detailTrigger;
    openDetailKey = undefined;
    detailTrigger = undefined;
    details.hidden = true;
    details.replaceChildren();
    updateDetailButtons();
    if (trigger?.isConnected) trigger.focus();
    else search.focus();
  };
  const renderDetails = (
    presentation: ReturnType<typeof assetDetailsPresentation>,
    {
      focusHeading = false,
      preserveFocus = false,
    }: { focusHeading?: boolean; preserveFocus?: boolean },
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
    close.type = "button";
    close.className = "btn sm secondary";
    close.dataset.workbenchDetailsClose = "true";
    close.textContent = "Close details";
    summary.className = "workbench-detail-summary";
    summary.textContent = presentation.summary;
    facts.className = "workbench-detail-facts";
    for (const fact of presentation.facts) {
      const term = document.createElement("dt");
      const definition = document.createElement("dd");
      term.textContent = fact.label;
      definition.textContent = fact.value;
      facts.append(term, definition);
    }
    advanced.className = "workbench-detail-advanced";
    advanced.open = advancedWasOpen;
    advancedSummary.textContent = "Advanced prepared metadata";
    raw.textContent = presentation.advancedJson;
    advanced.append(advancedSummary, raw);
    details.replaceChildren(heading, close, summary, facts, advanced);
    if (focusHeading) heading.focus();
    else if (focusTarget === "close") close.focus();
    else if (focusTarget === "advanced") advancedSummary.focus();
    else if (focusTarget === "heading") heading.focus();
  };
  const invalidateTemplatePreview = (): void => {
    if (openDetailKey?.startsWith("template:")) closeDetails();
  };
  const acceptState = (nextState: WorkbenchStateV1): void => {
    invalidateTemplatePreview();
    comparisonPreview = undefined;
    state = nextState;
    draftReviewPage = 0;
  };

  const showDetails = (
    key: string,
    presentation: ReturnType<typeof assetDetailsPresentation>,
    trigger: HTMLButtonElement,
  ): void => {
    if (openDetailKey === key && !details.hidden) {
      closeDetails();
      return;
    }
    details.hidden = false;
    renderDetails(presentation, { focusHeading: true });
    openDetailKey = key;
    detailTrigger = trigger;
    updateDetailButtons();
  };

  details.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDetails();
    },
    { signal: teardown.signal },
  );

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
          selectSource(other.sourceId, false);
          expandedAssetId = other.id;
          updateFilters({
            sourceId: other.sourceId,
            kind: other.kind,
            query: other.label,
            page: 0,
          });
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
    if (exclusion !== null) {
      exclusion.textContent = presentation.exclusionAction;
      exclusion.title = presentation.exclusionHelp;
      exclusion.setAttribute(
        "aria-label",
        presentation.exclusionAction + " for " + humanizedAssetLabel(asset),
      );
    }
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
    for (const row of root.querySelectorAll<HTMLElement>("article[data-workbench-asset-id]")) {
      const id = row.dataset.workbenchAssetId;
      if (id === undefined || !affected.has(id)) continue;
      const asset = options.bundle.assets[id];
      if (asset !== undefined) updateRow(row, asset);
    }
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
          [...root.querySelectorAll<HTMLElement>("article[data-workbench-asset-id]")]
            .map((row) => row.dataset.workbenchAssetId)
            .filter((id): id is string => id !== undefined),
        );
        refreshVisibleRows(visibleAssetIds);
        if (expandedAssetId !== undefined) renderInventory();
        else renderSourceSummary();
        if (openDetailKey?.startsWith("asset:") && !details.hidden) {
          const asset = options.bundle.assets[openDetailKey.slice("asset:".length)];
          if (asset !== undefined)
            renderDetails(assetDetailsPresentation(asset, options.bundle), {
              preserveFocus: true,
            });
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
    for (const assetId of alreadyPaged ? assetIds : pageItems(assetIds, page)) {
      const asset = options.bundle.assets[assetId];
      if (asset === undefined) continue;
      const row = document.createElement("article");
      const title = document.createElement("h3");
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
      row.className = "workbench-asset";
      row.dataset.workbenchAssetId = asset.id;
      title.className = "workbench-row-title";
      title.id = "workbench-asset-title-" + asset.id;
      title.textContent = humanizedAssetLabel(asset);
      const decision = assetDecisionPresentation(asset, options.bundle);
      purpose.className = "workbench-row-purpose";
      purpose.textContent = decision.purpose;
      kind.className = "workbench-row-kind";
      kind.textContent = catalogKindLabel(asset.kind);
      decisionFacts.className = "workbench-row-decision";
      access.textContent = "Access: " + decision.access;
      access.title = decision.access;
      evidence.className = "workbench-row-evidence";
      evidence.dataset.workbenchRowEvidence = "true";
      evidence.textContent = decision.evidenceLabel;
      evidence.title = decision.evidenceHelp;
      evidence.dataset.workbenchNeedsInformation = String(decision.needsInformation);
      decisionFacts.append(access, evidence);
      methodology.className = "workbench-methodology-badge";
      methodology.textContent = "Optional: choose up to one methodology.";
      methodology.hidden = asset.exclusiveSlot !== "methodology";
      detail.className = "workbench-row-summary";
      detail.dataset.workbenchRowDetail = "true";
      actions.className = "workbench-row-actions";
      expandButton.type = "button";
      expandButton.className = "btn sm secondary workbench-row-expand";
      expandButton.dataset.workbenchExpandId = asset.id;
      expandButton.setAttribute("aria-expanded", String(expandedAssetId === asset.id));
      expandButton.setAttribute("aria-controls", "workbench-expanded-" + asset.id);
      expandButton.setAttribute("aria-describedby", title.id);
      expandButton.textContent = expandedAssetId === asset.id ? "Close item" : "Open item";
      action.type = "button";
      action.className = "btn sm primary";
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
      detailsButton.textContent = "Read details";
      actions.append(action, expandButton);
      row.append(title, kind, purpose, decisionFacts, methodology, detail, actions);
      if (expandedAssetId === asset.id) {
        const expanded = document.createElement("section");
        const why = document.createElement("section");
        const whyHeading = document.createElement("h4");
        const whyAccess = document.createElement("p");
        const whyAction = document.createElement("p");
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
        expanded.className = "workbench-expanded-item";
        expanded.id = "workbench-expanded-" + asset.id;
        why.className = "workbench-expanded-why";
        whyHeading.textContent = "Why use it";
        whyAccess.textContent = "Source-declared access: " + decision.access;
        whyAction.textContent = "What the action saves: " + decision.consequence;
        why.append(whyHeading, purpose.cloneNode(true), whyAccess, whyAction);
        evidenceSheet.className = "workbench-evidence-sheet";
        evidenceSheet.dataset.workbenchEvidenceState = evidence.state;
        evidenceSheet.dataset.workbenchEvidenceTone = evidence.tone;
        evidenceHeading.textContent = "Security review";
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
          emptyFindings.textContent =
            "The report lists no findings. Check its coverage before drawing a conclusion.";
          evidenceFindings.append(emptyFindings);
        } else {
          const findingsList = document.createElement("ul");
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
        const evidenceFacts: HTMLElement[] = [evidenceHeading, evidenceStatus];
        if (
          evidence.state === "verified" ||
          evidence.state === "unverified" ||
          evidence.state === "stale"
        ) {
          evidenceFacts.push(evidenceResult, evidenceCoverage, evidenceScope);
          if (evidence.analyzers.length > 0) {
            const analyzerHeading = document.createElement("p");
            analyzerHeading.textContent = "Analyzers named in the report";
            evidenceFacts.push(analyzerHeading, evidenceAnalyzers);
          }
          evidenceFacts.push(evidenceFindings);
          if (evidence.state === "verified" || evidence.state === "stale")
            evidenceFacts.push(evidenceFreshness);
          if (evidence.showQualification) evidenceFacts.push(evidenceQualification);
        } else {
          evidenceFacts.push(evidenceBinding);
        }
        evidenceFacts.push(evidenceNextStep, evidenceCaveat);
        evidenceSheet.append(...evidenceFacts);
        const expandedActions = document.createElement("div");
        expandedActions.className = "workbench-expanded-actions";
        expandedActions.append(detailsButton, moreOptions);
        expanded.append(why, evidenceSheet, expandedActions);
        if (comparisonPreview?.assetId === asset.id) {
          const comparison = selectionComparisonPresentation(asset, options.bundle, state);
          const preview = document.createElement("section");
          const previewHeading = document.createElement("h4");
          const explanation = document.createElement("p");
          const changes = document.createElement("p");
          const confirm = document.createElement("button");
          const cancel = document.createElement("button");
          preview.className = "workbench-selection-comparison";
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
          expanded.append(preview);
        }
        row.append(expanded);
      }
      updateRow(row, asset);
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
    sourceReview.replaceChildren();
    if (sourceId !== undefined) {
      const summary = sourceEvidenceSummary(options.bundle, sourceId, state);
      const heading = document.createElement("h3");
      heading.textContent = catalogSourceDisplayName(options.bundle, sourceId);
      const cells = document.createElement("div");
      cells.className = "workbench-source-review-cells";
      const addCell = (label: string, value: number, help: string): void => {
        const cell = document.createElement("p");
        const count = document.createElement("strong");
        const caption = document.createElement("span");
        count.textContent = String(value);
        caption.textContent = label;
        cell.title = help;
        if (label.startsWith("Needs review"))
          cell.dataset.workbenchEvidenceTone = value > 0 ? "warning" : "neutral";
        cell.append(count, caption);
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
        summary.choicesInDraft,
        "Current source choices and requests. Choices from other sources stay in the shared draft.",
      );
      sourceReview.append(heading, cells);
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
      tab.dataset.workbenchType = id ?? "";
      tab.setAttribute("aria-pressed", String(filtersState.kind === id));
      tab.textContent = `${label} (${count})`;
      typeTabs.append(tab);
    };
    addType(undefined, "All", totalByType);
    for (const item of browse.typeOptions) addType(item.id, item.label, item.count);
    sourceTabs.replaceChildren();
    for (const item of browse.sourceOptions) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "workbench-source-tab";
      tab.dataset.workbenchSourceTab = item.id;
      tab.setAttribute("aria-pressed", String(item.id === filtersState.sourceId));
      tab.textContent = item.label + " ";
      const count = document.createElement("span");
      count.textContent = String(item.count);
      count.setAttribute("aria-hidden", "true");
      tab.append(count);
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
      return;
    }
    if (browse.total === 0) {
      const empty = document.createElement("p");
      empty.className = "help";
      empty.textContent = emptyBrowseMessage(browse);
      const otherMatches = otherTypeMatchCount(browse);
      if (filtersState.kind !== undefined && otherMatches > 0) {
        const showAll = document.createElement("button");
        showAll.type = "button";
        showAll.className = "btn sm secondary";
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
    renderRows(
      browseResults,
      browse.pageAssetIds,
      browse.page,
      (next) => {
        filtersState = { ...filtersState, page: next };
        renderInventory();
      },
      browse.total,
      true,
    );
  };

  const renderInventory = (): void => {
    if (filtersState.sourceId === undefined && groups[0] !== undefined)
      filtersState = { ...filtersState, sourceId: groups[0].id, page: 0 };
    const browse = catalogBrowse(options.bundle, filtersState);
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
    if (details.hidden) return;
    const close = details.querySelector<HTMLButtonElement>("[data-workbench-details-close]");
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
    details.append(preview);
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

  root.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element;
      if (target.closest<HTMLButtonElement>("[data-workbench-details-close]") !== null) {
        closeDetails();
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
        const fromDraftReview = removeTemplate !== null && draftReview.contains(removeTemplate);
        const result = options.dispatch({
          type: "remove-template",
          templateId: removeTemplateId,
          digest: removeTemplateDigest,
        });
        if (result.accepted) {
          acceptState(result.state);
          showDiagnostics(result);
          refresh();
          if (fromDraftReview) draftReviewSummary.focus();
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
      const templateId = target.closest<HTMLButtonElement>("[data-workbench-template-id]")?.dataset
        .workbenchTemplateId;
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
        const comparison = selectionComparisonPresentation(comparisonAsset, options.bundle, state);
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
        const result = options.dispatch(comparison.preview.action, comparisonPreview.expectedState);
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
      if (expandId !== undefined) {
        expandedAssetId = expandedAssetId === expandId ? undefined : expandId;
        renderInventory();
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
        "button[data-workbench-row-action][data-workbench-asset-id]",
      );
      const assetId = button?.dataset.workbenchAssetId;
      const asset = assetId === undefined ? undefined : options.bundle.assets[assetId];
      if (asset === undefined || button === null) return;
      const action = actionFor(asset, state);
      if (action === undefined) {
        if (asset.authoring.action === "inspect-evidence") {
          showDetails("asset:" + asset.id, assetDetailsPresentation(asset, options.bundle), button);
          options.inspectEvidence?.(asset);
        }
        if (asset.authoring.action === "prepare-approval") options.prepareApproval?.(asset);
        return;
      }
      if (action.type === "select-root" || action.type === "record-request") {
        const comparison = selectionComparisonPresentation(asset, options.bundle, state);
        if (comparison.kind === "conflict" && comparison.preview.accepted) {
          expandedAssetId = asset.id;
          comparisonPreview = {
            assetId: asset.id,
            expectedState: structuredClone(state),
          };
          renderInventory();
          root.querySelector<HTMLElement>("[data-workbench-comparison-heading]")?.focus();
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
    },
    { signal: teardown.signal },
  );
  const restoreComparisonFocus = (assetId: string, action: "expand" | "primary"): void => {
    queueMicrotask(() => {
      const replacement = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        action === "expand"
          ? button.dataset.workbenchExpandId === assetId
          : button.dataset.workbenchAssetId === assetId &&
            button.dataset.workbenchRowAction !== undefined,
      );
      replacement?.focus();
    });
  };
  const updateFilters = (next: CatalogBrowseFilters): void => {
    filtersState = { ...next, page: 0 };
    if (search.value !== (filtersState.query ?? "")) search.value = filtersState.query ?? "";
    renderInventory();
  };
  const selectSource = (sourceId: string | undefined, focusSearch: boolean): void => {
    if (sourceId === undefined || sourceId === filtersState.sourceId) return;
    templates.open = false;
    templateList.replaceChildren();
    expandedAssetId = undefined;
    if (openDetailKey !== undefined) closeDetails();
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
        "Local draft—requires Core preparation: " + draft.id + " (" + draft.declaration.kind + ") ";
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
    draftReviewList.replaceChildren();
    if (!draftReview.open) return;
    if (entries.length === 0) {
      const empty = document.createElement("p");
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
      category.className = "workbench-draft-review-category";
      category.textContent = entry.category;
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
          removal.append(help, remove);
          row.append(removal);
        }
      }
      if (asset !== undefined && !entry.needsReview) {
        const decision = assetDecisionPresentation(asset, options.bundle);
        const evidence = assetEvidencePresentation(asset, options.bundle);
        const context = document.createElement("section");
        context.className = "workbench-review-context";
        const purpose = document.createElement("p");
        purpose.textContent = decision.purpose;
        const consequence = document.createElement("p");
        consequence.textContent =
          entry.entryKind === "exclusion"
            ? "This is an administrator exclusion. It does not erase other saved requests."
            : decision.consequence;
        const report = document.createElement("p");
        report.dataset.workbenchEvidenceTone = evidence.tone;
        report.textContent =
          evidence.statusLabel +
          (evidence.findings.length === 0
            ? ""
            : " · " + evidence.findings.length + " findings to review");
        context.append(purpose, consequence, report);
        if (entry.entryKind !== "exclusion") {
          const handoff = adoption?.items.find((item) => item.assetId === asset.id);
          if (handoff !== undefined) {
            const next = document.createElement("p");
            next.textContent = "Next step: " + handoff.nextAction;
            context.append(next);
            if (adoption?.accepted && handoff.command !== undefined) {
              const command = document.createElement("code");
              command.textContent = handoff.command;
              context.append(command);
            }
          }
        }
        row.append(context);
        const savedEntry = entry.savedEntry;
        const entryKind = entry.entryKind;
        if (savedEntry !== undefined && entryKind !== undefined) {
          const reasonPanel = document.createElement("div");
          reasonPanel.className = "workbench-review-reason";
          const label = document.createElement("label");
          const reason = document.createElement("textarea");
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
          save.textContent = "Save reason";
          const feedback = document.createElement("span");
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
          row.append(reasonPanel);
        }
        detailsButton.type = "button";
        detailsButton.className = "btn sm secondary";
        detailsButton.dataset.workbenchDetailId = asset.id;
        detailsButton.setAttribute("aria-controls", details.id);
        detailsButton.setAttribute("aria-label", "Read details for " + humanizedAssetLabel(asset));
        detailsButton.textContent = "Read details";
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
  draftReview.addEventListener("toggle", renderDraftReview, {
    signal: teardown.signal,
  });

  const refresh = (): void => {
    refreshCounts();
    renderDraftReview();
    refreshDrafts();
    renderTemplates();
    renderRepairs();
    renderInventory();
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
    destroy: () => {
      if (evidenceRefreshTimer !== undefined) clearTimeout(evidenceRefreshTimer);
      teardown.abort();
    },
  };
}
