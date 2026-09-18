import { workbenchIcon } from "./icons.js";
import {
  buildProjectPolicyV1,
  type TrimUseV1,
  type UserDoorViewModelV1,
  userDoorViewModelV1,
} from "./user-door-model.js";

/**
 * The user door (P5b): trim the org policy's allowed items into an
 * `aih-project-policy.json` download (D5, D7). Every model-derived string is
 * written with `textContent`/attributes; only constant icon markup uses
 * `innerHTML`. No token or context cost is shown (D6).
 */

export const PROJECT_POLICY_FILENAME = "aih-project-policy.json";

const USES: readonly { use: TrimUseV1; label: string }[] = [
  { use: "required", label: "Required" },
  { use: "optional", label: "Optional" },
  { use: "skip", label: "Skip" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className: string): HTMLSpanElement {
  const node = el(
    "span",
    `inline-flex shrink-0 w-4 h-4 [&>svg]:w-full [&>svg]:h-full ${className}`,
  );
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = workbenchIcon(name);
  return node;
}

const LABEL =
  "text-[10px] font-mono uppercase tracking-wider font-semibold text-on-surface-variant";
const CARD =
  "rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface p-3 flex flex-col gap-2";

function sourceChipNode(view: UserDoorViewModelV1): HTMLElement {
  const chip = el(
    "div",
    "flex flex-wrap items-center gap-1.5 px-2 py-1 rounded border border-solid border-outline-variant bg-surface-container-low text-[11px] text-on-surface min-w-0",
  );
  chip.id = "user-policy-source";
  const source = view.source;
  const ok = source?.valid === true;
  chip.append(
    icon(ok ? "verified_user" : "info", ok ? "text-secondary" : "text-error"),
    el("span", "font-mono uppercase tracking-wider text-[10px] text-on-surface-variant", "Policy"),
    el("span", "font-mono", source?.kind ?? "none"),
  );
  if (source?.name !== undefined) {
    const name = el("span", "font-mono font-semibold break-all", source.name);
    name.title = source.name;
    chip.append(name);
  }
  chip.append(el("span", "text-on-surface-variant", ok ? "valid" : "invalid"));
  chip.dataset.valid = ok ? "true" : "false";
  return chip;
}

export function mountUserDoor(root: HTMLElement, model: unknown): void {
  const view = userDoorViewModelV1(model);
  const choices = new Map<string, TrimUseV1>();
  root.replaceChildren();
  root.className =
    "user-door flex-1 w-full max-w-6xl mx-auto p-4 grid gap-4 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] items-start";

  const listCard = el("section", CARD);
  listCard.setAttribute("aria-labelledby", "user-trim-title");
  const head = el("div", "flex flex-wrap items-center justify-between gap-2");
  const title = el(
    "h2",
    "text-[15px] font-semibold text-on-surface",
    "Choose what this project uses",
  );
  title.id = "user-trim-title";
  head.append(title, sourceChipNode(view));
  listCard.append(
    head,
    el(
      "p",
      "text-[12px] text-on-surface-variant",
      "Only items your organization's policy allows are listed. Required and Optional items are kept; skipped items are left out of the file.",
    ),
  );
  const list = el("ul", "flex flex-col m-0 p-0 list-none");
  list.id = "user-trim-list";
  if (view.source?.valid === false) {
    const error = el("p", "text-[12px] text-on-surface flex items-start gap-1.5");
    error.id = "user-source-error";
    error.append(icon("info", "text-error"), el("span", "", view.saveBlocked ?? ""));
    listCard.append(error);
  } else if (view.missing.length > 0) {
    const empty = el("div", "flex flex-col gap-1.5 text-[12px] text-on-surface");
    empty.id = "user-trim-empty";
    empty.append(
      el(
        "p",
        "",
        "This page cannot list your organization's items yet. The Workbench server does not provide:",
      ),
    );
    const missing = el("ul", "list-disc pl-5 m-0 text-on-surface-variant");
    for (const entry of view.missing) missing.append(el("li", "", entry));
    empty.append(missing);
    listCard.append(empty);
  } else if (view.items.length === 0) {
    const empty = el("p", "text-[12px] text-on-surface-variant", "The org policy lists no items.");
    empty.id = "user-trim-empty";
    listCard.append(empty);
  }
  const counts = el("p", "text-[11px] font-mono text-on-surface-variant");
  counts.id = "user-trim-counts";
  const renderCounts = () => {
    const tally = { required: 0, optional: 0, skip: 0 };
    for (const item of view.items) tally[choices.get(item.assetId) ?? "optional"] += 1;
    counts.textContent = `${tally.required} required · ${tally.optional} optional · ${tally.skip} skipped`;
  };
  for (const item of view.items) {
    const row = el(
      "li",
      "flex flex-wrap items-center gap-2 py-2 min-w-0 border-0 border-t border-solid border-outline-variant first:border-t-0",
    );
    row.dataset.assetId = item.assetId;
    const text = el("div", "flex-1 min-w-0 flex flex-col");
    const name = el(
      "span",
      "text-[12px] font-medium text-on-surface break-words",
      item.label ?? item.assetId,
    );
    const meta = el(
      "span",
      "text-[10.5px] font-mono text-on-surface-variant break-all",
      [item.kind, item.assetId].filter((part) => part !== undefined).join(" · "),
    );
    text.append(name, meta);
    const group = el(
      "div",
      "flex items-center gap-0.5 p-0.5 rounded border border-solid border-outline-variant bg-surface-container-low shrink-0",
    );
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", `Use of ${item.label ?? item.assetId}`);
    const buttons: HTMLButtonElement[] = [];
    const paint = () => {
      const current = choices.get(item.assetId) ?? "optional";
      row.dataset.use = current;
      for (const button of buttons) {
        const on = button.dataset.use === current;
        button.setAttribute("aria-checked", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        button.className = `px-2 py-0.5 rounded text-[11px] transition-colors ${
          on
            ? "bg-surface-container-highest text-on-surface font-semibold"
            : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
        }`;
      }
    };
    const choose = (use: TrimUseV1) => {
      choices.set(item.assetId, use);
      paint();
      renderCounts();
    };
    for (const [index, option] of USES.entries()) {
      const button = el("button", "", option.label);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.use = option.use;
      button.addEventListener("click", () => choose(option.use));
      button.addEventListener("keydown", (event) => {
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = USES[(index + step + USES.length) % USES.length];
        if (next === undefined) return;
        choose(next.use);
        buttons.find((candidate) => candidate.dataset.use === next.use)?.focus();
      });
      buttons.push(button);
      group.append(button);
    }
    paint();
    row.append(text, group);
    list.append(row);
  }
  listCard.append(list, counts);
  if (view.ambiguous.length > 0) {
    const note = el(
      "p",
      "text-[11px] text-on-surface-variant",
      `Not offered, listed under more than one origin: ${view.ambiguous.join(", ")}`,
    );
    note.id = "user-trim-ambiguous";
    listCard.append(note);
  }
  renderCounts();
  counts.hidden = view.items.length === 0;

  const side = el("aside", `${CARD} md:sticky md:top-4`);
  side.setAttribute("aria-label", "Save project policy");
  const forLabel = el("label", "flex flex-col gap-1");
  forLabel.append(el("span", LABEL, "Project name"));
  const forName = el(
    "input",
    "px-2 py-1 rounded border border-solid border-outline-variant bg-surface-container-low text-on-surface text-[12px] font-mono",
  );
  forName.id = "user-for-name";
  forName.type = "text";
  forName.autocomplete = "off";
  forName.required = true;
  forName.setAttribute("aria-required", "true");
  forLabel.append(forName);
  const typeLabel = el("label", "flex flex-col gap-1");
  typeLabel.append(el("span", LABEL, "For"));
  const forType = el(
    "select",
    "px-2 py-1 rounded border border-solid border-outline-variant bg-surface-container-low text-on-surface text-[12px]",
  );
  forType.id = "user-for-type";
  for (const value of ["project", "persona", "agent"]) {
    const option = el("option", "", value[0]?.toUpperCase() + value.slice(1));
    option.value = value;
    forType.append(option);
  }
  typeLabel.append(forType);
  const tools = el("fieldset", "flex flex-col gap-1 border-0 p-0 m-0 min-w-0");
  tools.id = "user-ai-tools";
  tools.append(el("legend", `${LABEL} mb-1`, "AI tools"));
  const toolGrid = el("div", "flex flex-wrap gap-x-3 gap-y-1");
  for (const tool of view.aiTools) {
    const label = el("label", "flex items-center gap-1 text-[12px] text-on-surface");
    const box = el("input", "");
    box.type = "checkbox";
    box.name = "user-ai-tool";
    box.id = `user-ai-tool-${tool}`;
    box.value = tool;
    label.append(box, el("span", "font-mono", tool));
    toolGrid.append(label);
  }
  tools.append(toolGrid);
  if (view.aiTools.length > 0 && !view.aiToolsFromPolicy)
    tools.append(
      el(
        "p",
        "text-[11px] text-on-surface-variant",
        "The org policy does not limit AI tools; every tool aih supports is listed.",
      ),
    );
  const message = el("p", "text-[12px] text-on-surface min-h-[1em]");
  message.id = "user-save-message";
  message.setAttribute("aria-live", "polite");
  const save = el(
    "button",
    "flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-primary hover:bg-primary-bright text-on-primary text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:bg-surface-container-highest disabled:text-on-surface-variant",
  );
  save.id = "user-save";
  save.type = "button";
  save.setAttribute("aria-describedby", "user-save-message");
  save.append(icon("save", ""), el("span", "", `Save ${PROJECT_POLICY_FILENAME}`));
  if (view.saveBlocked !== undefined) {
    save.disabled = true;
    message.textContent = view.saveBlocked;
  }
  save.addEventListener("click", () => {
    const selectedTools = [
      ...tools.querySelectorAll<HTMLInputElement>("input[name='user-ai-tool']:checked"),
    ].map((box) => box.value);
    const result = buildProjectPolicyV1(view, {
      choices,
      forType: forType.value as "project" | "persona" | "agent",
      forName: forName.value,
      aiTools: selectedTools,
    });
    if (!result.ok) {
      message.textContent = `Not saved: ${result.errors.join("; ")}`;
      return;
    }
    const blob = new Blob([`${JSON.stringify(result.policy, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = PROJECT_POLICY_FILENAME;
    link.click();
    URL.revokeObjectURL(url);
    message.textContent = `Download started. Put ${PROJECT_POLICY_FILENAME} in the project folder and commit it.`;
  });
  side.append(
    el("h2", "text-[13px] font-semibold text-on-surface", "Save and use"),
    forLabel,
    typeLabel,
    tools,
    save,
    message,
    el(
      "p",
      "text-[11px] text-on-surface-variant",
      "Saving downloads the file; nothing is written to disk by the Workbench. The org policy is never changed.",
    ),
  );
  root.append(listCard, side);
}

/** Wire the user page's own theme toggle (the admin runtime is not mounted here). */
export function mountUserDoorTheme(toggle: HTMLElement | null): void {
  if (!(toggle instanceof HTMLButtonElement)) return;
  const sync = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };
  toggle.addEventListener("click", () => {
    document.documentElement.dataset.theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    sync();
  });
  sync();
}

/**
 * Chooser door: the launch folder is neither a policy repository nor a
 * project. Say which folder opens which page; no new behaviour.
 */
export function mountChooserNote(anchor: HTMLElement | null): void {
  if (anchor === null) return;
  const note = el(
    "aside",
    "wb-door-chooser mx-3 my-2 p-3 rounded border border-solid border-outline-variant bg-surface-container-lowest text-on-surface text-[12px] flex items-start gap-2",
  );
  note.id = "door-chooser-note";
  note.setAttribute("aria-label", "Which page opens");
  const body = el("div", "flex flex-col gap-1 min-w-0");
  body.append(el("p", "font-semibold", "This folder is not a policy repository or a project."));
  const list = el("ul", "list-disc pl-5 m-0 text-on-surface-variant");
  list.append(
    el(
      "li",
      "",
      "A folder with aih-org-policy.json (or AIH_ORG_POLICY set) opens this admin page.",
    ),
    el(
      "li",
      "",
      "A project bound to an org policy (.aih-config.json) or holding aih-project-policy.json opens the project page.",
    ),
  );
  body.append(list);
  note.append(icon("info", "text-primary"), body);
  anchor.after(note);
}
