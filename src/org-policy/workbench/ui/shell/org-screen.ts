import { button, el, withId } from "./dom.js";
import { activeManagedMcpServers, governanceOrDefault } from "./policy-grammar.js";
import type { PolicySession } from "./policy-session.js";
import { SCREEN_CHANGE_EVENT } from "./screens.js";

/**
 * The organization screen (NEW-SHELL-PLAN.md S6, prototype
 * `screens/admin-org.html`): deployment setup (posture, allowed CLIs, managed
 * MCP projection, readiness), developer tool setup, the adoption recipe, the
 * evidence and versions drawer, and the ECC hook controls. The policy rules
 * are the legacy runtime's (`legacy-runtime.js` `Xe`, `Jf`, `Qf`, `py`, `uy`,
 * the posture, managed-MCP, sanctioned-CLI and ECC hook handlers), copied
 * without change; every model and policy string reaches the page through
 * `textContent`. Hooks keep the legacy ids.
 */

// biome-ignore lint/suspicious/noExplicitAny: policy JSON is validated by the grammar, not by TypeScript
type Loose = any;

/** The model fields the organization screen reads (`PolicyStudioModel`). */
export interface OrgScreenModel {
  readonly catalog: unknown;
  readonly adoptionRecipe: {
    readonly roles: readonly {
      readonly id: string;
      readonly label: string;
      readonly guidance: string;
      readonly prerequisites: readonly string[];
      readonly conflicts: readonly string[];
      readonly route: unknown;
      readonly usage: { readonly kind: string; readonly serverId?: string };
    }[];
  };
}

export interface OrgScreenOptions {
  readonly model: OrgScreenModel;
  readonly session: () => PolicySession | undefined;
  announce(message: string, error?: boolean): void;
  /** Re-render every screen that reads the policy (the legacy `Xe`). */
  render(): void;
}

export interface OrgScreen {
  render(): void;
  /** Where the developer tool selection mounts (it needs the prepared catalog). */
  readonly developerTools: {
    readonly root: HTMLElement;
    readonly status: HTMLElement;
    readonly summary: HTMLElement;
  };
}

const CARD =
  "flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest min-w-0";
const HEADING = "m-0 text-[13px] font-semibold text-on-surface";
const LABEL =
  "text-[10px] font-mono uppercase tracking-wider font-semibold text-on-surface-variant";
const HELP = "help m-0 text-[12px] text-on-surface-variant";
const TOOL_BUTTON =
  "inline-flex items-center gap-1 h-7 px-2.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface text-[11px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const INFO_BUTTON =
  "instrument-info w-5 h-5 grid place-items-center rounded-full text-[12px] leading-none text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low";
const OVERLAY =
  "absolute right-0 top-full mt-1 z-50 w-[min(420px,calc(100vw-32px))] max-h-[70vh] overflow-auto flex flex-col gap-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface shadow-lg";

const ECC_DISABLE_EXPLAINED_GROUP = new Set([
  "pre:bash:block-no-verify",
  "pre:config-protection",
  "pre:edit-write:gateguard-fact-force",
  "post:quality-gate",
]);

interface EccHookGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly ids?: readonly string[];
  readonly select?: (hook: Loose) => boolean;
}

const ECC_HOOK_GROUPS: readonly EccHookGroup[] = [
  {
    id: "pre-tool-guardrails",
    label: "Pre-tool Guardrails",
    description:
      "Critical controls that prevent unverified Bash execution or accidental overwrites of baseline configuration.",
    ids: ["pre:bash:block-no-verify", "pre:config-protection"],
  },
  {
    id: "gate-checks",
    label: "Gate Checks",
    description: "Validation gates before high-risk edits and after code changes.",
    ids: ["pre:edit-write:gateguard-fact-force", "post:quality-gate"],
  },
  {
    id: "additional-pre-tool",
    label: "Additional Pre-tool Controls",
    description: "Other pinned PreToolUse controls from ECC's exact inventory.",
    select: (hook) => hook.event === "PreToolUse" && !ECC_DISABLE_EXPLAINED_GROUP.has(hook.id),
  },
  {
    id: "session-lifecycle",
    label: "Session & Lifecycle",
    description: "Pinned session-start, compaction, stop, and session-end lifecycle controls.",
    select: (hook) =>
      ["SessionStart", "PreCompact", "Stop", "SessionEnd"].indexOf(hook.event) !== -1,
  },
  {
    id: "post-tool-feedback",
    label: "Post-tool Observability & Feedback",
    description:
      "Remaining pinned PostToolUse and PostToolUseFailure observations, audit signals, and feedback controls.",
    select: (hook) =>
      ["PostToolUse", "PostToolUseFailure"].indexOf(hook.event) !== -1 &&
      !ECC_DISABLE_EXPLAINED_GROUP.has(hook.id),
  },
];

/** The legacy `no`: why a reviewed control lost every sanctioned projector target. */
function projectorGap(governance: Loose, candidate: Loose): string {
  return `${candidate.id} has no projector for the organization-sanctioned CLI set ${governance.supportedClis.join(", ")}; control projector targets: ${candidate.targets.join(", ")}`;
}

/** The legacy `ri`: rebind active reviewed targets to the sanctioned set, in place. */
function rebindSanctionedTargets(governance: Loose): string | null {
  if (!Array.isArray(governance.supportedClis)) return null;
  for (const activation of governance.activations) {
    const reviewed = governance.catalog.reviewed.find(
      (candidate: Loose) => candidate.id === activation.candidate,
    );
    if (!reviewed) continue;
    const targets = reviewed.targets.filter((target: string) =>
      governance.supportedClis.includes(target),
    );
    if (!targets.length) return projectorGap(governance, reviewed);
    activation.targets = targets;
  }
  return null;
}

/** The legacy `Vf`: disabled ids that stay eligible under a profile. */
function eligibleDisabledIds(controls: Loose, profile: string, disabled: unknown): string[] {
  const chosen = new Set(Array.isArray(disabled) ? disabled : []);
  return controls.disabledHooks.eligibleIds.filter((id: string) => {
    const hook = controls.hooks.find((candidate: Loose) => candidate.id === id);
    return chosen.has(id) && hook && hook.profiles.indexOf(profile) !== -1;
  });
}

/** The legacy `cy`: the next action an adoption recipe role routes to. */
function adoptionRoute(route: Loose): string {
  return route.kind === "workbench-row"
    ? `Existing Workbench row: ${route.candidate}`
    : route.kind === "ecc-mcp-approval"
      ? `ECC MCP approval for ${route.id}, then configure its ${route.addability} entry`
      : route.kind === "aih-ecc-profile-lifecycle"
        ? `AIH ECC profile lifecycle: ${route.command}`
        : "No route";
}

function writableGovernance(policy: Loose): Loose {
  policy.governance = governanceOrDefault(policy.governance);
  return policy.governance;
}

/**
 * One information tooltip (`[data-tooltip-button]` + `role="tooltip"`), as
 * the legacy `.tip-wrap`: hover, focus, click and Enter open it; Escape,
 * pointer leave and a click elsewhere close it.
 */
export function infoTip(
  buttonId: string,
  helpId: string,
  label: string,
  text: string,
): HTMLElement {
  const wrap = el("span", "tip-wrap relative inline-flex");
  const trigger = button(INFO_BUTTON, "ⓘ", buttonId);
  trigger.setAttribute("aria-label", label);
  trigger.setAttribute("aria-describedby", helpId);
  trigger.setAttribute("aria-expanded", "false");
  trigger.dataset.tooltipButton = helpId;
  const tip = withId(
    el(
      "span",
      "tooltip fixed z-[70] p-2 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface text-[12px] leading-snug font-normal normal-case tracking-normal whitespace-normal [overflow-wrap:anywhere] shadow-lg",
      text,
    ),
    helpId,
  );
  tip.setAttribute("role", "tooltip");
  tip.dataset.open = "false";
  tip.hidden = true;
  wrap.append(trigger, tip);
  return wrap;
}

let tooltipsMounted = false;

/** The legacy tooltip listeners (`ui`, `Ts`), installed once per page. */
function mountTooltips(): void {
  if (tooltipsMounted) return;
  tooltipsMounted = true;
  const closeAll = () => {
    for (const tip of document.querySelectorAll<HTMLElement>(".tooltip[data-open='true']")) {
      tip.dataset.open = "false";
      tip.hidden = true;
    }
    for (const trigger of document.querySelectorAll<HTMLElement>(
      "[data-tooltip-button][aria-expanded='true']",
    ))
      trigger.setAttribute("aria-expanded", "false");
  };
  const open = (trigger: HTMLElement) => {
    closeAll();
    trigger.setAttribute("aria-expanded", "true");
    trigger.removeAttribute("data-tooltip-dismissed");
    const tip = document.getElementById(trigger.dataset.tooltipButton ?? "");
    if (tip === null) return;
    const box = trigger.getBoundingClientRect();
    const width = Math.min(368, Math.max(24, window.innerWidth - 32));
    tip.style.width = `${width}px`;
    tip.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - 16 - width))}px`;
    tip.style.top = `${Math.max(16, box.bottom + 4)}px`;
    tip.dataset.open = "true";
    tip.hidden = false;
  };
  const triggerOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-tooltip-button]") : null;
  document.addEventListener("focusin", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger !== null && !trigger.hasAttribute("data-tooltip-dismissed")) open(trigger);
  });
  document.addEventListener("focusout", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger === null) return;
    trigger.removeAttribute("data-tooltip-dismissed");
    closeAll();
  });
  document.addEventListener("pointerover", (event) => {
    const wrap = event.target instanceof Element ? event.target.closest(".tip-wrap") : null;
    const trigger = wrap?.querySelector<HTMLElement>("[data-tooltip-button]");
    if (trigger) open(trigger);
  });
  document.addEventListener("pointerout", (event) => {
    const wrap = event.target instanceof Element ? event.target.closest(".tip-wrap") : null;
    if (wrap && !(event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget)))
      closeAll();
  });
  document.addEventListener("click", (event) => {
    const trigger = triggerOf(event.target);
    if (trigger !== null) {
      open(trigger);
      return;
    }
    closeAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const active = document.activeElement;
    closeAll();
    if (active instanceof HTMLElement && active.matches("[data-tooltip-button]")) {
      active.setAttribute("data-tooltip-dismissed", "true");
      active.focus();
    }
  });
}

/** Adoption recipe drawer (legacy `#adoption-recipe`, `workspace-interactions.ts`). */
function adoptionRecipe(model: OrgScreenModel, root: HTMLElement): HTMLElement {
  const entry = withId(el("div", "relative"), "adoption-recipe");
  const trigger = button(TOOL_BUTTON, "", "adoption-recipe-toggle");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "adoption-recipe-panel");
  trigger.append(withId(el("span", "", "Adoption recipe →"), "adoption-recipe-title"));
  const panel = withId(el("aside", OVERLAY), "adoption-recipe-panel");
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "adoption-guide-title");
  const head = el("div", "flex items-center justify-between gap-2");
  const close = button(
    "w-6 h-6 grid place-items-center rounded hover:bg-surface-container text-on-surface-variant",
    "✕",
    "adoption-recipe-close",
  );
  close.setAttribute("aria-label", "Close adoption recipe");
  head.append(withId(el("h3", HEADING, "Adoption recipe"), "adoption-guide-title"), close);
  const roles = withId(el("div", "flex flex-col gap-2"), "adoption-recipe-roles");
  for (const role of model.adoptionRecipe.roles) {
    const usage =
      role.usage.kind === "mcp-server-event"
        ? `MCP server event: ${String(role.usage.serverId)}`
        : "none captured";
    const article = el(
      "article",
      "adoption-role flex flex-col gap-1 p-2 rounded bg-surface-container-low text-[12px]",
    );
    article.dataset.adoptionRole = role.id;
    const line = (label: string, value: string) => {
      const paragraph = el("p", "adoption-route m-0 text-on-surface-variant");
      paragraph.append(el("b", "text-on-surface", label), document.createTextNode(` ${value}`));
      return paragraph;
    };
    article.append(
      el("strong", "text-on-surface", role.label),
      el("p", "m-0 text-on-surface-variant", role.guidance),
      line("Prerequisites:", role.prerequisites.join("; ")),
      line("Overlap / conflict:", role.conflicts.join("; ")),
      line("Next action:", adoptionRoute(role.route)),
      line("Usage / coverage:", usage),
    );
    roles.append(article);
  }
  panel.append(
    head,
    el(
      "p",
      HELP,
      "Use this guide to decide who handles each step. Reading it does not change your policy.",
    ),
    roles,
  );
  entry.append(trigger, panel);

  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelLeave = () => clearTimeout(leaveTimer);
  const setOpen = (open: boolean, restoreFocus = false) => {
    cancelLeave();
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (!open && restoreFocus) trigger.focus({ preventScroll: true });
  };
  const leave = () => {
    cancelLeave();
    leaveTimer = setTimeout(() => {
      if (
        !panel.matches(":hover") &&
        !trigger.matches(":hover") &&
        !panel.contains(document.activeElement)
      )
        setOpen(false);
    }, 220);
  };
  trigger.addEventListener("click", (event) => {
    const opening = panel.hidden !== false;
    setOpen(opening);
    if (opening && event.detail === 0) close.focus({ preventScroll: true });
  });
  close.addEventListener("click", () => setOpen(false, true));
  for (const element of [trigger, panel]) {
    element.addEventListener("pointerenter", cancelLeave);
    element.addEventListener("pointerleave", leave);
  }
  panel.addEventListener("focusout", (event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      (!panel.contains(event.relatedTarget) && event.relatedTarget !== trigger)
    )
      setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (
      event.target instanceof Node &&
      !panel.contains(event.target) &&
      !trigger.contains(event.target)
    )
      setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  root.addEventListener(SCREEN_CHANGE_EVENT, () => setOpen(false));
  return entry;
}

interface EvidenceDeliveryData {
  readonly coreVersion: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly note: string;
}

/**
 * The rows the page template computed (`evidence-delivery-rows.ts`) and
 * embedded as inert JSON in `#wb-evidence-delivery`; undefined when absent.
 */
function evidenceDeliveryData(): EvidenceDeliveryData | undefined {
  const source = document.getElementById("wb-evidence-delivery");
  if (source === null) return undefined;
  const data = JSON.parse(source.textContent ?? "") as Partial<EvidenceDeliveryData>;
  if (
    typeof data.coreVersion !== "string" ||
    typeof data.note !== "string" ||
    !Array.isArray(data.rows) ||
    !data.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        typeof row[0] === "string" &&
        typeof row[1] === "string",
    )
  )
    throw new Error("Evidence and versions data is malformed.");
  return data as EvidenceDeliveryData;
}

/** Evidence & versions drawer (legacy `#evidence-delivery`), or nothing without delivery data. */
function evidenceDelivery(root: HTMLElement): HTMLElement | undefined {
  const data = evidenceDeliveryData();
  if (data === undefined) return undefined;
  const rows = data.rows;
  const details = withId(el("details", "reference-evidence relative"), "evidence-delivery");
  const summary = el(
    "summary",
    "list-none inline-flex items-center h-7 px-2.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-on-surface text-[11px] font-medium cursor-pointer",
    "Evidence & versions",
  );
  const panel = el("div", `reference-evidence-panel ${OVERLAY}`);
  const head = el("div", "flex items-center justify-between gap-2");
  const close = button(TOOL_BUTTON, "Close", "evidence-delivery-close");
  close.setAttribute("aria-label", "Close evidence and versions");
  close.title = "Close evidence and versions";
  head.append(el("h3", HEADING, `Evidence & versions · Core ${data.coreVersion}`), close);
  const list = el("dl", "m-0 flex flex-col gap-1 text-[12px]");
  for (const [label, value] of rows) {
    const term = el("dt", "text-on-surface");
    term.append(el("strong", "", label));
    list.append(term, el("dd", "m-0 text-on-surface-variant [overflow-wrap:anywhere]", value));
  }
  const body = el("div", "help flex flex-col gap-2");
  body.append(list, el("p", "m-0 text-[12px] text-on-surface-variant", data.note));
  panel.append(head, body);
  details.append(summary, panel);

  const closeEvidence = (restoreFocus = false) => {
    if (!details.open) return;
    details.open = false;
    if (restoreFocus) summary.focus({ preventScroll: true });
  };
  close.addEventListener("click", () => closeEvidence(true));
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !details.contains(event.target)) closeEvidence();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && details.open) {
      event.preventDefault();
      closeEvidence(true);
    }
  });
  root.addEventListener(SCREEN_CHANGE_EVENT, () => closeEvidence());
  return details;
}

export function mountOrgScreen(body: HTMLElement, options: OrgScreenOptions): OrgScreen {
  const model = options.model;
  const catalog = model.catalog as Loose;
  const screen = el("div", "flex flex-col gap-3 min-w-0");
  screen.dataset.wbOrg = "";
  mountTooltips();
  const shellRoot = body.closest<HTMLElement>("#wb-root") ?? body;

  // Deployment setup.
  const setup = withId(
    el(
      "section",
      "compact-instrument flex flex-col gap-1.5 px-3 py-2.5 rounded border border-solid border-outline-variant bg-surface-container-lowest min-w-0",
    ),
    "policy-settings",
  );
  setup.setAttribute("aria-labelledby", "policy-settings-title");
  const postureLabel = el("label", "flex items-center gap-1.5");
  const posture = withId(
    el(
      "select",
      "h-7 px-1.5 rounded border border-solid border-outline-variant bg-surface-container-lowest text-[12px] text-on-surface",
    ),
    "posture",
  );
  for (const [value, text] of [
    ["vibe", "Vibe"],
    ["enterprise", "Enterprise"],
  ] as const) {
    const option = el("option", "", text);
    option.value = value;
    posture.append(option);
  }
  postureLabel.append(el("span", LABEL, "Posture"), posture);
  const setupHead = el("div", "flex flex-wrap items-center gap-2 min-w-0");
  const title = el("div", "flex items-center gap-1.5 min-w-0 mr-auto");
  title.append(
    withId(el("h3", HEADING, "Deployment setup"), "policy-settings-title"),
    infoTip(
      "deployment-setup-info",
      "deployment-setup-help",
      "About deployment setup",
      "Choose the hosts this policy may target before adding Core controls. These choices record policy intent; they do not install, start, or contact a server.",
    ),
  );
  const references = el("div", "flex flex-wrap items-center gap-1.5");
  references.setAttribute("role", "group");
  references.setAttribute("aria-label", "Deployment references");
  references.append(adoptionRecipe(model, shellRoot));
  const evidence = evidenceDelivery(shellRoot);
  if (evidence !== undefined) references.append(evidence);
  setupHead.append(title, postureLabel, references);

  const strip = el("div", "flex flex-col gap-1.5 min-w-0");

  const cliHead = el("div", "flex items-center gap-1.5 whitespace-nowrap mr-auto");
  const cliCount = withId(el("span", "text-[11px] text-on-surface-variant"), "supported-cli-count");
  const cliTip = infoTip("supported-cli-info", "supported-cli-note", "About allowed CLIs", "");
  cliHead.append(el("span", LABEL, "Allowed CLI"), cliCount, cliTip);
  const cliNote = cliTip.querySelector<HTMLElement>("#supported-cli-note") as HTMLElement;
  const hosts = withId(el("div", "chips flex flex-wrap gap-1 min-w-0"), "supported-cli-hosts");

  const managedLabel = el("label", "instrument-toggle flex items-center gap-1.5 text-[12px]");
  const managed = withId(el("input", ""), "managed-mcp-projection");
  managed.type = "checkbox";
  managed.setAttribute("aria-describedby", "managed-mcp-help");
  managedLabel.append(
    managed,
    el("span", "text-on-surface", "Allow AIH to configure selected MCP tools"),
    infoTip(
      "managed-mcp-info",
      "managed-mcp-help",
      "About managed MCP projection",
      "Required for supported MCP tools you select. Preview the changes in your project before applying.",
    ),
  );
  const stripHead = el("div", "flex flex-wrap items-center gap-x-4 gap-y-1.5 min-w-0");
  stripHead.append(cliHead, managedLabel);
  strip.append(stripHead, hosts);

  const readiness = withId(el("p", `${HELP} instrument-readiness`), "deployment-readiness");
  readiness.setAttribute("role", "status");
  readiness.setAttribute("aria-live", "polite");

  const tools = withId(
    el(
      "details",
      "developer-tools-disclosure min-w-0 border-0 border-t border-solid border-outline-variant",
    ),
    "developer-tool-selection",
  );
  const toolsSummary = el(
    "summary",
    "flex items-center min-h-[30px] py-1 cursor-pointer text-[12px] font-semibold text-on-surface-variant hover:text-on-surface",
  );
  const toolsSummaryText = withId(
    el("span", "", "Developer tool setup — Loading selection…"),
    "developer-tool-selection-summary",
  );
  toolsSummaryText.setAttribute("aria-live", "polite");
  toolsSummary.append(toolsSummaryText);
  const toolsBody = el("div", "developer-tool-selection-body flex flex-col gap-1.5 pt-1.5 min-w-0");
  const toolsHead = el("div", "flex items-center gap-1.5");
  toolsHead.append(
    withId(el("h3", HEADING, "Developer tool setup"), "developer-tool-selection-title"),
    infoTip(
      "developer-tool-info",
      "developer-tool-help",
      "About developer tool setup",
      "Choose the default developer tools for later setup. This authoring view records selection intent only; it does not claim a tool is installed, configured, or verified.",
    ),
  );
  const toolsStatus = withId(el("p", HELP), "developer-tool-selection-status");
  toolsStatus.setAttribute("role", "status");
  toolsStatus.setAttribute("aria-live", "polite");
  const toolRows = withId(el("div", "min-w-0"), "developer-tool-rows");
  toolsBody.append(toolsHead, toolsStatus, toolRows);
  tools.append(toolsSummary, toolsBody);
  setup.append(setupHead, strip, readiness, tools);

  // ECC hook controls (legacy `#surface-ecc-hooks`, collapsed by default).
  const ecc = withId(el("section", CARD), "surface-ecc-hooks");
  ecc.dataset.open = "0";
  const eccToggle = button(
    "grphead flex items-center gap-2 w-full text-left text-on-surface",
    "",
    "surface-ecc-hooks-toggle",
  );
  eccToggle.dataset.group = "";
  eccToggle.setAttribute("aria-expanded", "false");
  eccToggle.setAttribute("aria-controls", "surface-ecc-hooks-body");
  eccToggle.append(
    el("span", "text-[10px] text-on-surface-variant", "▶"),
    el("h3", HEADING, "ECC hook controls"),
    el("span", `${LABEL} ml-auto`, "ECC"),
  );
  eccToggle.firstElementChild?.setAttribute("aria-hidden", "true");
  const eccBody = withId(el("div", "flex flex-col gap-2 min-w-0"), "surface-ecc-hooks-body");
  eccBody.hidden = true;
  const eccControls = withId(el("div", "flex flex-col gap-2 min-w-0"), "ecc-hook-controls");
  eccBody.append(
    eccControls,
    el(
      "p",
      HELP,
      "AIH records supported Claude environment intent. ECC executes hooks; this form does not install, run, or verify them.",
    ),
  );
  eccToggle.addEventListener("click", () => {
    const open = ecc.dataset.open !== "1";
    ecc.dataset.open = open ? "1" : "0";
    eccToggle.setAttribute("aria-expanded", String(open));
    eccBody.hidden = !open;
  });
  ecc.append(eccToggle, eccBody);

  screen.append(setup, ecc);
  body.replaceChildren(screen);

  const session = () => options.session();
  const governance = (): Loose =>
    governanceOrDefault((session()?.snapshotPolicy() as Loose)?.governance);
  const sanctioned = (): string[] => {
    const value = governance().supportedClis;
    return Array.isArray(value) ? value : [];
  };

  posture.addEventListener("change", () => {
    const current = session();
    if (current === undefined) return;
    const value = posture.value;
    const policy: Loose = current.snapshotPolicy();
    const selected =
      policy.governance && Array.isArray(policy.governance.supportedClis)
        ? policy.governance.supportedClis
        : [];
    if (value === "enterprise" && !selected.length) {
      options.announce(
        "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.",
        true,
      );
      options.render();
      return;
    }
    current.edit((draft) => {
      draft.minimumPosture = value;
      return undefined;
    }, "Posture changed without modifying selections.");
  });

  managed.addEventListener("change", () => {
    const current = session();
    if (current === undefined) return;
    const checked = managed.checked;
    if (!checked && activeManagedMcpServers(current.snapshotPolicy()).length) {
      options.announce(
        "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.",
        true,
      );
      options.render();
      return;
    }
    current.setManagedMcpOptIn(
      checked,
      checked
        ? "Managed MCP projection enabled for selected Core MCP controls. It is saved only when those controls are present."
        : "Managed MCP projection disabled. No server was contacted or changed.",
    );
  });

  hosts.addEventListener("click", (event) => {
    const chip =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-sanctioned-cli]")
        : null;
    const current = session();
    if (chip === null || current === undefined) return;
    const id = chip.getAttribute("data-sanctioned-cli");
    const known: Loose[] = catalog.hosts || [];
    if (!known.some((host) => host.id === id)) return;
    const chosen = new Set(sanctioned());
    if (chosen.has(id as string)) chosen.delete(id as string);
    else chosen.add(id as string);
    const ordered = known.map((host) => host.id).filter((host: string) => chosen.has(host));
    current.edit(
      (draft) => {
        const writable = writableGovernance(draft);
        if (ordered.length) writable.supportedClis = ordered;
        else delete writable.supportedClis;
        const gap = rebindSanctionedTargets(writable);
        return gap
          ? `Policy change rejected: ${gap}. Remove that control before removing its last projectable sanctioned CLI.`
          : undefined;
      },
      ordered.length
        ? `Supported CLI allow-list updated: ${ordered.join(", ")}. Reviewed activation targets were rebound to their exact sanctioned projector intersections; unsanctioned selected or detected CLIs are refused by the engine.`
        : "Supported CLI allow-list cleared without broadening existing activation targets. Vibe permits an omitted list; Enterprise requires an explicit list.",
    );
  });

  eccControls.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const current = session();
    if (target === null || current === undefined) return;
    const controls = catalog.eccHookControls;
    const profileInput = target.closest("[data-ecc-hook-profile]");
    if (profileInput !== null) {
      const profile = profileInput.getAttribute("data-ecc-hook-profile") as string;
      if (!controls.profiles.some((candidate: Loose) => candidate.id === profile)) return;
      current.edit((draft) => {
        const writable = writableGovernance(draft);
        const disabled =
          writable.eccHookControls && Array.isArray(writable.eccHookControls.disabledIds)
            ? writable.eccHookControls.disabledIds
            : [];
        const kept = eligibleDisabledIds(controls, profile, disabled);
        writable.eccHookControls = Object.assign(
          { profile },
          kept.length ? { disabledIds: kept } : {},
        );
        return undefined;
      }, `ECC hook profile set to ${profile}. AIH records supported Claude environment intent; ECC executes the hooks.`);
      return;
    }
    const disable = target.closest<HTMLButtonElement>("[data-ecc-hook-disable]");
    if (disable === null || disable.disabled) return;
    const id = disable.getAttribute("data-ecc-hook-disable") as string;
    const recorded = governance().eccHookControls;
    if (!recorded || !recorded.profile) return;
    const hook = controls.hooks.find((candidate: Loose) => candidate.id === id);
    if (!hook || !hook.disableEligible || hook.profiles.indexOf(recorded.profile) === -1) return;
    const disabledNow = Array.isArray(recorded.disabledIds) ? recorded.disabledIds : [];
    const disabling = disabledNow.indexOf(id) === -1;
    current.edit(
      (draft) => {
        const writable = writableGovernance(draft);
        const disabled = Array.isArray(
          writable.eccHookControls && writable.eccHookControls.disabledIds,
        )
          ? writable.eccHookControls.disabledIds
          : [];
        const next =
          disabled.indexOf(id) === -1
            ? disabled.concat([id])
            : disabled.filter((candidate: string) => candidate !== id);
        const kept = eligibleDisabledIds(controls, recorded.profile, next);
        writable.eccHookControls = Object.assign(
          { profile: recorded.profile },
          kept.length ? { disabledIds: kept } : {},
        );
        return undefined;
      },
      `${disabling ? "Disabled " : "Re-enabled "}${id} for ECC's ${recorded.profile} profile. ECC applies this after process spawn; it is not AIH enforcement.`,
    );
  });

  const renderHosts = () => {
    const known: Loose[] = catalog.hosts || [];
    const targets = known.filter((host) => host.policyTarget);
    const chosen = new Set(sanctioned());
    hosts.replaceChildren(
      ...known.map((host) => {
        const chip = button(
          "chip h-6 px-1.5 rounded border border-solid border-outline-variant bg-surface-container-low hover:bg-surface-container text-[11px] font-mono text-on-surface-variant aria-pressed:border-primary aria-pressed:text-primary",
          host.id,
        );
        chip.dataset.host = host.id;
        chip.dataset.sanctionedCli = host.id;
        chip.setAttribute("aria-pressed", chosen.has(host.id) ? "true" : "false");
        chip.title = `${host.label}${host.policyTarget ? " - a policy activation can target this host" : " - can be sanctioned by org policy, but cannot be targeted by the projector"}. MCP support: ${host.mcpSupport}`;
        return chip;
      }),
    );
    cliCount.textContent = `${chosen.size} selected`;
    cliNote.textContent = `AIH supports ${known.length} CLIs; ${targets.length} can receive policy activations. ${chosen.size} are selected by this policy. Sanctioned, materialization-capable, and projector-capable are separate sets.`;
  };

  const renderReadiness = (current: PolicySession) => {
    const policy: Loose = current.snapshotPolicy();
    const blockers = current.readinessBlockers();
    const recorded = governanceOrDefault(policy.governance);
    const reviewed =
      recorded.catalog && Array.isArray(recorded.catalog.reviewed) ? recorded.catalog.reviewed : [];
    const activations: Loose[] = Array.isArray(recorded.activations) ? recorded.activations : [];
    const active = new Set(
      activations
        .filter((activation) => activation && activation.state === "active")
        .map((activation) => activation.candidate),
    );
    const controls = reviewed.filter(
      (candidate: Loose) =>
        active.has(candidate.id) && (candidate.kind === "mcp" || candidate.kind === "hook"),
    );
    const intersections = controls
      .map((candidate: Loose) => {
        const activation = activations.find(
          (entry) => entry && entry.state === "active" && entry.candidate === candidate.id,
        );
        return `${candidate.id} → ${activation && Array.isArray(activation.targets) ? activation.targets.join(", ") : "none"}`;
      })
      .join("; ");
    readiness.textContent = controls.length
      ? blockers.length
        ? `Deployment setup needs attention before download: ${blockers.join("; ")}. Exact selected target intersections: ${intersections}.`
        : `Draft is ready to export. ${(policy.minimumPosture || "vibe") === "vibe" ? "Governance MCP and hook projection remains disabled in Vibe; choose Enterprise for governed deployment. " : "Governed deployment still requires policy authority and target verification. "}Exact selected target intersections: ${intersections}. Export records the managed-MCP setting.`
      : "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.";
  };

  const renderEccHooks = () => {
    const controls = catalog.eccHookControls;
    const recorded = governance().eccHookControls || {};
    const profile = recorded.profile || "";
    const disabled: string[] = Array.isArray(recorded.disabledIds) ? recorded.disabledIds : [];
    const existing = [
      ...eccControls.querySelectorAll<HTMLDetailsElement>("details[data-ecc-hook-group]"),
    ];
    const rendered = existing.length > 0;
    const open = new Set(
      existing.filter((group) => group.open).map((group) => group.dataset.eccHookGroup),
    );
    const profiles = el(
      "fieldset",
      "flex flex-wrap items-center gap-3 m-0 p-2 rounded border border-solid border-outline-variant",
    );
    profiles.append(el("legend", LABEL, "Profile"));
    for (const candidate of controls.profiles) {
      const label = el("label", "flex items-center gap-1 text-[12px] text-on-surface");
      const input = el("input", "");
      input.type = "radio";
      input.name = "ecc-hook-profile";
      input.value = candidate.id;
      input.dataset.eccHookProfile = candidate.id;
      input.checked = profile === candidate.id;
      label.append(input, document.createTextNode(` ${candidate.label}`));
      profiles.append(label);
    }
    const row = (hook: Loose) => {
      const eligible = !!profile && hook.profiles.indexOf(profile) !== -1;
      const container = el(
        "div",
        "hookreg flex flex-col gap-1 p-2 rounded bg-surface-container-low",
      );
      container.dataset.eccHookId = hook.id;
      const name = el("p", "m-0 text-[12px] text-on-surface");
      name.append(el("b", "font-mono", hook.id), document.createTextNode(` — ${hook.event}`));
      container.append(
        name,
        el(
          "p",
          HELP,
          `Eligible profiles: ${hook.profiles.join(", ")}. ${hook.disableEligible ? "" : "This wrapper remains enabled."}`,
        ),
      );
      if (hook.disableEligible) {
        const action = button(
          TOOL_BUTTON,
          disabled.indexOf(hook.id) !== -1 ? "Re-enable" : "Disable",
        );
        action.dataset.eccHookDisable = hook.id;
        action.disabled = !eligible;
        const actions = el("div", "flex");
        actions.append(action);
        container.append(actions);
      } else
        container.append(el("span", HELP, "Required wrapper; no individual disabled setting."));
      return container;
    };
    let total = 0;
    const groups = ECC_HOOK_GROUPS.map((group, index) => {
      const members: Loose[] = group.ids
        ? group.ids
            .map((id) => controls.hooks.find((hook: Loose) => hook.id === id))
            .filter(Boolean)
        : controls.hooks.filter(group.select);
      total += members.length;
      const details = el("details", "ecc-hook-group flex flex-col gap-1.5 min-w-0");
      details.dataset.eccHookGroup = group.id;
      details.open = rendered ? open.has(group.id) : index < 2;
      const summary = el(
        "summary",
        "flex items-center gap-2 cursor-pointer text-[12px] font-medium text-on-surface",
      );
      const label = el("span", "", group.label);
      label.dataset.eccHookGroupLabel = "";
      const count = el("b", "font-mono text-on-surface-variant", String(members.length));
      count.dataset.eccHookGroupCount = "";
      summary.append(label, count);
      details.append(summary, el("p", HELP, group.description), ...members.map(row));
      return details;
    });
    if (total !== controls.hooks.length)
      throw new Error("ECC hook grouping must render every pinned hook exactly once");
    const intro = el("p", HELP);
    intro.append(
      document.createTextNode(
        "ECC executes hooks; AIH configures the supported profile and disabled-hook list through receipt-owned Claude ",
      ),
      el("code", "font-mono", "settings.json"),
      document.createTextNode(
        " environment keys. Disabling affects ECC execution after process spawn; it is not AIH enforcement.",
      ),
    );
    eccControls.replaceChildren(
      intro,
      profiles,
      el("p", HELP, controls.disabledHooks.detail),
      ...groups,
    );
  };

  return {
    developerTools: { root: toolRows, status: toolsStatus, summary: toolsSummaryText },
    render() {
      const current = session();
      if (current === undefined) return;
      const policy: Loose = current.snapshotPolicy();
      posture.value = policy.minimumPosture || "vibe";
      managed.checked = current.managedMcpOptIn();
      renderHosts();
      renderReadiness(current);
      renderEccHooks();
    },
  };
}
