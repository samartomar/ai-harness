import {
  type CatalogBrowseFilters,
  catalogBrowse,
  catalogKindLabel,
  catalogSourceDisplayName,
  CATALOG_BROWSE_PAGE_SIZE as PAGE_SIZE,
} from "../catalog-browse.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  WorkbenchOriginV1,
  WorkbenchStateV1,
} from "../contracts.js";
import {
  resolveWorkbenchSelection,
  type WorkbenchActionV1,
  type WorkbenchReductionV1,
  workbenchSelectionCounts,
} from "../selection-engine.js";
import { evidenceDisplayFor } from "./evidence-display.js";

export interface WorkbenchMountOptions {
  bundle: AuthoringCatalogBundleV1;
  initialState: WorkbenchStateV1;
  initialDiagnostics?: readonly string[];
  dispatch(action: WorkbenchActionV1): WorkbenchReductionV1;
  inspectEvidence?(asset: AuthoringAssetV1): void;
  prepareApproval?(asset: AuthoringAssetV1): void;
}

export interface MountedWorkbench {
  state(): WorkbenchStateV1;
  restore(state: WorkbenchStateV1, diagnostics?: readonly string[]): void;
  dispatch(action: WorkbenchActionV1): WorkbenchReductionV1;
  destroy(): void;
}

interface SourceGroup {
  id: string;
  label: string;
  assetIds: readonly string[];
}

interface GroupView {
  section: HTMLElement;
  heading: HTMLButtonElement;
  body: HTMLElement;
  expanded: boolean;
  page: number;
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
  const groupViews = new Map<string, GroupView>();
  const teardown = new AbortController();
  const counts = document.createElement("p");
  const filters = document.createElement("div");
  const sourceFilter = document.createElement("select");
  const typeFilter = document.createElement("select");
  const search = document.createElement("input");
  const inventory = document.createElement("section");
  const browseResults = document.createElement("section");
  const diagnostics = document.createElement("p");
  const templates = document.createElement("div");
  const repairs = document.createElement("div");
  const drafts = document.createElement("div");
  const details = document.createElement("pre");
  details.className = "workbench-detail";
  details.hidden = true;
  let filtersState: CatalogBrowseFilters = {};

  root.replaceChildren();
  root.classList.add("workbench-inventory");
  counts.className = "help";
  counts.setAttribute("aria-live", "polite");
  filters.className = "workbench-catalog-filters";
  const sourceLabel = document.createElement("label");
  sourceLabel.textContent = "Source ";
  sourceLabel.append(sourceFilter);
  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Type ";
  typeLabel.append(typeFilter);
  filters.append(sourceLabel, typeLabel);
  sourceFilter.setAttribute("aria-label", "Source");
  typeFilter.setAttribute("aria-label", "Type");
  search.type = "search";
  search.placeholder = "Search catalog";
  search.setAttribute("aria-label", "Search catalog");
  inventory.setAttribute("aria-label", "Catalog inventory");
  browseResults.setAttribute("aria-label", "Catalog browse results");
  templates.setAttribute("aria-label", "Selection templates");
  repairs.setAttribute("aria-label", "Saved selections needing review");
  drafts.setAttribute("aria-label", "Prepared local drafts");
  diagnostics.className = "help error";
  root.append(counts, filters, search, diagnostics, templates, repairs, drafts, inventory, details);

  const refreshCounts = (): void => {
    const value = workbenchSelectionCounts(options.bundle, state);
    counts.textContent = `${value.selectedControlCount} selected controls · ${value.rootCount} direct roots · ${value.requestCount} requested · effective: not evaluated — needs a target repository`;
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
  ): void => {
    if (total <= PAGE_SIZE) return;
    const controls = document.createElement("div");
    const previous = document.createElement("button");
    const next = document.createElement("button");
    previous.type = "button";
    next.type = "button";
    previous.textContent = "Previous 50";
    next.textContent = "Next 50";
    previous.disabled = page === 0;
    next.disabled = (page + 1) * PAGE_SIZE >= total;
    previous.addEventListener("click", () => onPage(page - 1), {
      signal: teardown.signal,
    });
    next.addEventListener("click", () => onPage(page + 1), {
      signal: teardown.signal,
    });
    controls.append(
      previous,
      document.createTextNode(` ${page + 1} / ${Math.ceil(total / PAGE_SIZE)} `),
      next,
    );
    host.append(controls);
  };

  const evidenceFor = (asset: AuthoringAssetV1): string =>
    evidenceDisplayFor(asset, Object.values(options.bundle.evidence)).text;
  const showDetails = (asset: AuthoringAssetV1): void => {
    const chunk = options.bundle.detailChunks[asset.detailChunkId];
    try {
      details.textContent =
        chunk === undefined
          ? "No prepared metadata chunk is available."
          : JSON.stringify(JSON.parse(chunk.bytes), null, 2);
    } catch {
      details.textContent = "Prepared metadata is malformed and cannot be displayed.";
    }
    details.hidden = false;
  };

  const updateRow = (row: HTMLElement, asset: AuthoringAssetV1): void => {
    const detail = row.querySelector<HTMLElement>("[data-workbench-row-detail]");
    const action = row.querySelector<HTMLButtonElement>("[data-workbench-row-action]");
    const exclusion = row.querySelector<HTMLButtonElement>("[data-workbench-row-exclusion]");
    if (detail === null || action === null || exclusion === null) return;
    const selected = new Set(resolveWorkbenchSelection(options.bundle, state).assetIds);
    const directRoots = state.roots.filter((root) => root.assetId === asset.id);
    const directRequests = state.requests.filter((request) => request.assetId === asset.id);
    const requested = directRequests.length > 0;
    const directOrigins = [...directRoots, ...directRequests].map((entry) => entry.origin);
    const administratorDirect = directOrigins.some(
      (origin) => origin.kind === "administrator" || origin.kind === "legacy-unattributed",
    );
    const structuralDirect = directRoots.some((root) => root.mode === "structural");
    const nextAction = actionFor(asset, state);
    const detailHandler =
      asset.authoring.action === "inspect-evidence"
        ? options.inspectEvidence
        : asset.authoring.action === "prepare-approval"
          ? options.prepareApproval
          : undefined;
    const excluded = state.exclusions.some((item) => item.assetId === asset.id);
    const status = excluded
      ? "Excluded"
      : requested
        ? "Requested"
        : structuralDirect
          ? "Structural root"
          : administratorDirect
            ? "Selected"
            : selected.has(asset.id)
              ? directOrigins.length > 0
                ? "Selected"
                : "Selected (dependency)"
              : "Available";
    detail.textContent = `Source: ${catalogSourceDisplayName(options.bundle, asset.sourceId)} · Type: ${catalogKindLabel(asset.kind)} · Status: ${status} · ${evidenceFor(asset)}`;
    if (directOrigins.length > 0)
      detail.textContent += ` · origin: ${[...new Map(directOrigins.map((origin) => [originKey(origin), originLabel(origin)])).values()].sort(compareText).join(", ")}`;
    exclusion.textContent = state.exclusions.some(
      (item) => item.assetId === asset.id && item.origin.kind === "administrator",
    )
      ? "Include"
      : "Exclude";
    action.textContent =
      nextAction?.type === "remove-request"
        ? `Remove ${originLabel(nextAction.origin).toLowerCase()} request`
        : nextAction?.type === "remove-root"
          ? `Remove ${originLabel(nextAction.origin).toLowerCase()} selection`
          : nextAction === undefined
            ? asset.authoring.action === "inspect-evidence"
              ? "Inspect evidence"
              : "Prepare approval"
            : requested
              ? "Add administrator request"
              : asset.authoring.action === "record-request"
                ? "Request"
                : selected.has(asset.id)
                  ? "Add administrator selection"
                  : "Select";
    action.disabled = nextAction === undefined && detailHandler === undefined;
    const pressed =
      asset.authoring.action === "record-request"
        ? directRequests.some(
            (request) =>
              request.origin.kind === "administrator" ||
              request.origin.kind === "legacy-unattributed",
          )
        : directRoots.some(
            (root) =>
              root.origin.kind === "administrator" || root.origin.kind === "legacy-unattributed",
          );
    action.setAttribute("aria-pressed", pressed ? "true" : "false");
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
          }
        : undefined;
    const rows = document.createElement("div");
    rows.className = "workbench-inventory-rows";
    for (const assetId of alreadyPaged ? assetIds : pageItems(assetIds, page)) {
      const asset = options.bundle.assets[assetId];
      if (asset === undefined) continue;
      const row = document.createElement("article");
      const action = document.createElement("button");
      const detailsButton = document.createElement("button");
      const exclusionButton = document.createElement("button");
      const label = document.createElement("span");
      const methodology = document.createElement("span");
      const detail = document.createElement("span");
      row.dataset.workbenchAssetId = asset.id;
      label.textContent = asset.label;
      methodology.className = "workbench-methodology-badge";
      methodology.textContent = "Optional: choose up to one methodology.";
      methodology.hidden = asset.exclusiveSlot !== "methodology";
      action.type = "button";
      action.dataset.workbenchAssetId = asset.id;
      action.dataset.workbenchRowAction = "true";
      detailsButton.type = "button";
      detailsButton.dataset.workbenchDetailId = asset.id;
      detailsButton.textContent = "Details";
      exclusionButton.type = "button";
      exclusionButton.dataset.workbenchExclusionId = asset.id;
      exclusionButton.dataset.workbenchRowExclusion = "true";
      detail.dataset.workbenchRowDetail = "true";
      row.append(label, methodology, detail, action, exclusionButton, detailsButton);
      updateRow(row, asset);
      rows.append(row);
    }
    host.replaceChildren(rows);
    renderPageControls(host, page, total, setPage);
    if (focusTarget !== undefined) {
      const replacement = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.dataset.workbenchAssetId === focusTarget.assetId &&
          button.dataset.workbenchExclusionId === focusTarget.exclusionId &&
          button.dataset.workbenchDetailId === focusTarget.detailId,
      );
      replacement?.focus();
    }
  };

  const renderGroup = (group: SourceGroup, view: GroupView): void => {
    if (!view.expanded) {
      view.body.replaceChildren();
      return;
    }
    renderRows(view.body, group.assetIds, view.page, (next) => {
      view.page = Math.max(0, next);
      renderGroup(group, view);
    });
  };

  const renderFilterOptions = (browse: ReturnType<typeof catalogBrowse>): void => {
    const sourceTotal = browse.sourceOptions.reduce((total, option) => total + option.count, 0);
    const typeTotal = browse.typeOptions.reduce((total, option) => total + option.count, 0);
    const option = (text: string, value: string): HTMLOptionElement => {
      const element = document.createElement("option");
      element.textContent = text;
      element.value = value;
      return element;
    };
    sourceFilter.replaceChildren(
      option(`All sources (${sourceTotal})`, ""),
      ...browse.sourceOptions.map((item) => option(`${item.label} (${item.count})`, item.id)),
    );
    typeFilter.replaceChildren(
      option(`All types (${typeTotal})`, ""),
      ...browse.typeOptions.map((item) => option(`${item.label} (${item.count})`, item.id)),
    );
    sourceFilter.value = filtersState.sourceId ?? "";
    typeFilter.value = filtersState.kind ?? "";
  };

  const emptyBrowseMessage = (): string => {
    const query = filtersState.query?.trim();
    if (query) return `No catalog items match "${query}" in the selected prepared catalog.`;
    if (filtersState.sourceId !== undefined && filtersState.kind !== undefined)
      return `No ${catalogKindLabel(filtersState.kind).toLowerCase()} are present in the prepared source ${catalogSourceDisplayName(options.bundle, filtersState.sourceId)}.`;
    if (filtersState.sourceId !== undefined)
      return `No catalog items are present in the prepared source ${catalogSourceDisplayName(options.bundle, filtersState.sourceId)}.`;
    return `No ${catalogKindLabel(filtersState.kind ?? "item").toLowerCase()} are present in this prepared catalog.`;
  };

  const renderBrowseResults = (browse: ReturnType<typeof catalogBrowse>): void => {
    renderFilterOptions(browse);
    browseResults.hidden = !browse.active;
    if (!browse.active) {
      browseResults.replaceChildren();
      return;
    }
    if (browse.total === 0) {
      const empty = document.createElement("p");
      empty.className = "help";
      empty.textContent = emptyBrowseMessage();
      browseResults.replaceChildren(empty);
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
    const browse = catalogBrowse(options.bundle, filtersState);
    for (const group of groups) {
      const view = groupViews.get(group.id);
      if (view === undefined) continue;
      view.section.hidden = browse.active;
      if (browse.active) {
        view.body.hidden = true;
        view.body.replaceChildren();
      } else {
        view.body.hidden = !view.expanded;
        view.heading.setAttribute("aria-expanded", String(view.expanded));
        renderGroup(group, view);
      }
    }
    renderBrowseResults(browse);
  };
  const addGroup = (group: SourceGroup): void => {
    const section = document.createElement("section");
    const heading = document.createElement("button");
    const body = document.createElement("div");
    const view: GroupView = {
      section,
      heading,
      body,
      expanded: false,
      page: 0,
    };
    heading.type = "button";
    heading.textContent = `${group.label} (${group.assetIds.length})`;
    heading.setAttribute("aria-expanded", "false");
    body.hidden = true;
    heading.addEventListener(
      "click",
      () => {
        view.expanded = !view.expanded;
        body.hidden = !view.expanded;
        heading.setAttribute("aria-expanded", String(view.expanded));
        renderGroup(group, view);
      },
      { signal: teardown.signal },
    );
    section.append(heading, body);
    inventory.append(section);
    groupViews.set(group.id, view);
  };

  const renderTemplates = (): void => {
    templates.replaceChildren();
    const appliedOrigins = new Map<string, Extract<WorkbenchOriginV1, { kind: "template" }>>();
    for (const entry of [...state.roots, ...state.exclusions]) {
      if (entry.origin.kind === "template")
        appliedOrigins.set(originKey(entry.origin), entry.origin);
    }
    for (const template of Object.values(options.bundle.templates).sort((left, right) =>
      compareText(left.id, right.id),
    )) {
      const apply = document.createElement("button");
      const inspect = document.createElement("button");
      apply.type = "button";
      apply.dataset.workbenchTemplateId = template.id;
      apply.title = template.id;
      apply.textContent = `Apply ${template.label ?? template.id} (${template.roots.length} roots)`;
      inspect.type = "button";
      inspect.dataset.workbenchTemplateDetailId = template.id;
      inspect.textContent = "Details";
      templates.append(apply, inspect);
    }
    for (const origin of [...appliedOrigins.values()].sort((left, right) =>
      compareText(originKey(left), originKey(right)),
    )) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.workbenchTemplateRemoveId = origin.id;
      remove.dataset.workbenchTemplateRemoveDigest = origin.digest;
      const template = options.bundle.templates[origin.id];
      const templateLabel =
        template?.digest === origin.digest ? (template.label ?? origin.id) : origin.id;
      remove.title = origin.id;
      remove.textContent = `Remove ${templateLabel}`;
      templates.append(remove);
    }
    templates.hidden = !templates.hasChildNodes();
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

  for (const group of groups) addGroup(group);
  inventory.append(browseResults);

  root.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element;
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
          state = result.state;
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
          state = result.state;
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
          state = result.state;
          showDiagnostics(result);
          refreshCounts();
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
        const result = options.dispatch({
          type: "remove-template",
          templateId: removeTemplateId,
          digest: removeTemplateDigest,
        });
        if (result.accepted) {
          state = result.state;
          showDiagnostics(result);
          refresh();
        } else
          diagnostics.textContent =
            result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
            "Template removal rejected.";
        return;
      }
      const templateDetailId = target.closest<HTMLButtonElement>(
        "[data-workbench-template-detail-id]",
      )?.dataset.workbenchTemplateDetailId;
      if (templateDetailId !== undefined) {
        const template = options.bundle.templates[templateDetailId];
        if (template !== undefined) {
          details.textContent = JSON.stringify(template, null, 2);
          details.hidden = false;
        }
        return;
      }
      const templateId = target.closest<HTMLButtonElement>("[data-workbench-template-id]")?.dataset
        .workbenchTemplateId;
      if (templateId !== undefined) {
        const result = options.dispatch({ type: "apply-template", templateId });
        if (result.accepted) {
          state = result.state;
          showDiagnostics(result);
          refresh();
        } else
          diagnostics.textContent =
            result.diagnostics?.map((diagnostic) => diagnostic.message).join(" ") ??
            "Template rejected.";
        return;
      }
      const detailId = target.closest<HTMLButtonElement>("[data-workbench-detail-id]")?.dataset
        .workbenchDetailId;
      if (detailId !== undefined) {
        const detailAsset = options.bundle.assets[detailId];
        if (detailAsset !== undefined) showDetails(detailAsset);
        return;
      }
      const button = target.closest<HTMLButtonElement>(
        "button[data-workbench-row-action][data-workbench-asset-id]",
      );
      const assetId = button?.dataset.workbenchAssetId;
      const asset = assetId === undefined ? undefined : options.bundle.assets[assetId];
      if (asset === undefined) return;
      const action = actionFor(asset, state);
      if (action === undefined) {
        if (asset.authoring.action === "inspect-evidence") {
          showDetails(asset);
          options.inspectEvidence?.(asset);
        }
        if (asset.authoring.action === "prepare-approval") options.prepareApproval?.(asset);
        return;
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
      state = result.state;
      refreshCounts();
      refreshVisibleRows(changedAssetIds(previous, state));
    },
    { signal: teardown.signal },
  );
  const updateFilters = (next: CatalogBrowseFilters): void => {
    filtersState = { ...next, page: 0 };
    renderInventory();
  };
  sourceFilter.addEventListener(
    "change",
    () =>
      updateFilters({
        ...filtersState,
        sourceId: sourceFilter.value || undefined,
      }),
    { signal: teardown.signal },
  );
  typeFilter.addEventListener(
    "change",
    () => updateFilters({ ...filtersState, kind: typeFilter.value || undefined }),
    { signal: teardown.signal },
  );
  search.addEventListener(
    "input",
    () => updateFilters({ ...filtersState, query: search.value || undefined }),
    { signal: teardown.signal },
  );

  const refreshDrafts = (): void => {
    drafts.replaceChildren();
    if (state.drafts.length === 0) {
      drafts.hidden = true;
      return;
    }
    drafts.hidden = false;
    for (const draft of state.drafts) {
      const row = document.createElement("p");
      const remove = document.createElement("button");
      row.textContent = `Local draft—requires Core preparation: ${draft.id} (${draft.declaration.kind}) `;
      remove.type = "button";
      remove.dataset.workbenchDraftId = draft.id;
      remove.textContent = "Remove draft";
      row.append(remove);
      drafts.append(row);
    }
  };
  const refresh = (): void => {
    refreshCounts();
    refreshDrafts();
    renderTemplates();
    renderRepairs();
    renderInventory();
  };
  refresh();
  return {
    state: () => state,
    restore(nextState, nextDiagnostics = []) {
      state = nextState;
      diagnostics.textContent = nextDiagnostics.join(" ");
      refresh();
    },
    dispatch(action) {
      const result = options.dispatch(action);
      if (result.accepted) {
        state = result.state;
        showDiagnostics(result);
        refresh();
      }
      return result;
    },
    destroy: () => teardown.abort(),
  };
}
