import { parseNativeStrictJsonObjectV1 } from "../../../../contract/native-strict-json-object-v1.js";
import { policySchemaErrors } from "../../schema-validation.js";
import { decisionProblems } from "../decision-json.js";
import type { AdminShell } from "./admin-shell.js";
import { button, el, icon, withId } from "./dom.js";
import {
  DECISION_FILENAME,
  DEFAULT_POLICY_FILENAME,
  decisionFileText,
  MAX_IMPORT_BYTES,
  POLICY_FILENAME_PATTERN,
} from "./download-format.js";
import type { PolicySession } from "./policy-session.js";

/**
 * Imports and downloads for the new shell (NEW-SHELL-PLAN.md §1, slice S2):
 * the header's Check Policy and Publish actions and its file menu. Every
 * message, limit and filename rule is the legacy runtime's, and every file
 * leaves through `downloadBlob` with the bytes of `download-format.ts`.
 */

/** Hand one JSON file to the browser, exactly as the legacy runtime did. */
export function downloadBlob(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type Announce = AdminShell["announce"];

/** Read the chosen file as text, refusing anything over 1 MiB (legacy `Wf`). */
function readImportFile(
  input: HTMLInputElement,
  announce: Announce,
  onText: (text: string) => void,
): void {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    announce("Import rejected: file exceeds the 1 MiB limit.", true);
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => announce("Import rejected: unable to read file.", true);
  reader.onload = () => onText(String(reader.result || ""));
  reader.readAsText(file);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const MENU_ITEM =
  "flex items-center gap-2 w-full px-2.5 py-1.5 rounded text-left text-[12px] text-on-surface hover:bg-surface-container-low disabled:opacity-50 disabled:cursor-not-allowed";
const FILENAME_HELP =
  "Use one safe JSON filename per project or team. The browser chooses the download folder; move the file into an administrator-controlled policy folder when required.";

export interface FileTransferOptions {
  readonly shell: AdminShell;
  readonly session: PolicySession;
  readonly decisionSchema: unknown;
  /** False when the prepared catalog is invalid: Check Policy and Publish stay disabled. */
  readonly catalogValid: boolean;
  /** Refresh the policy preview (`#config-preview`, `#report-preview`). */
  renderPreview(): void;
}

function fileInput(id: string): HTMLInputElement {
  const input = withId(el("input", "hidden"), id);
  input.type = "file";
  input.accept = "application/json";
  input.hidden = true;
  return input;
}

function menuItem(id: string, glyph: string, label: string): HTMLButtonElement {
  const item = button(MENU_ITEM, "", id);
  item.append(icon(glyph), el("span", "", label));
  return item;
}

export interface FileTransfer {
  /** Remove the header controls and every listener, including the document one. */
  destroy(): void;
}

export function mountFileTransfer(options: FileTransferOptions): FileTransfer {
  const { shell, session } = options;
  const announce = shell.announce;
  const teardown = new AbortController();

  const validate = button(
    "flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface text-[12px] font-medium transition-colors shrink-0",
    "",
    "validate",
  );
  validate.title = "Check Policy";
  validate.setAttribute("aria-label", "Check Policy");
  validate.append(icon("verified_user", "sm:hidden"), el("span", "max-sm:hidden", "Check Policy"));

  const download = button(
    "flex items-center gap-1 px-3 py-1 rounded bg-primary-container hover:bg-primary-bright text-on-primary text-[12px] font-medium transition-colors shadow-xs shrink-0",
    "",
    "download",
  );
  download.title = "Publish: download the policy file";
  download.setAttribute("aria-label", "Publish (download the policy file)");
  download.append(
    el("span", "max-sm:hidden", "Publish"),
    icon("arrow_forward", "w-[13px] h-[13px]"),
  );

  const menuToggle = button(
    "p-1 rounded bg-surface-container-low hover:bg-surface-container border border-solid border-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors flex items-center justify-center shadow-xs shrink-0",
    "",
    "wb-file-menu-toggle",
  );
  menuToggle.setAttribute("aria-label", "Policy files");
  menuToggle.title = "Policy files";
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-controls", "wb-file-menu");
  menuToggle.append(icon("more_vert", "w-[15px] h-[15px]"));

  const menu = withId(
    el(
      "div",
      "absolute right-0 top-9 z-50 w-80 max-w-[calc(100vw-24px)] p-2 flex flex-col gap-1 rounded border border-solid border-outline-variant bg-surface-container-lowest shadow-lg",
    ),
    "wb-file-menu",
  );
  menu.hidden = true;
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "Policy files");

  const importPolicy = menuItem("import-policy", "upload_file", "Import policy (replaces current)");
  const importEvidence = menuItem(
    "import-evidence",
    "upload_file",
    "Import evidence (non-destructive preflight)",
  );
  const importDecision = menuItem(
    "import-decision",
    "upload_file",
    "Import decision (inspection only)",
  );
  const downloadDecision = menuItem("download-decision", "download", "Download decision");
  downloadDecision.disabled = true;
  const exportPolicy = menuItem("export", "code", "Policy JSON");

  const filenameLabel = el(
    "label",
    "flex flex-col gap-1 px-2.5 pt-2 text-[11px] font-medium text-on-surface-variant",
    "Policy download filename",
  );
  const filename = withId(
    el(
      "input",
      "h-7 px-2 rounded border border-solid border-outline-variant bg-surface-container-lowest text-[12px] font-mono text-on-surface",
    ),
    "policy-download-name",
  );
  filename.value = DEFAULT_POLICY_FILENAME;
  filename.maxLength = 132;
  filename.autocomplete = "off";
  filename.spellcheck = false;
  filenameLabel.append(filename);
  const help = withId(
    el("p", "m-0 px-2.5 text-[11px] text-on-surface-variant"),
    "policy-file-help",
  );
  const command = withId(
    el(
      "pre",
      "m-0 mx-2.5 px-2 py-1 rounded bg-surface-container-low text-[11px] font-mono text-on-surface whitespace-pre-wrap break-all",
    ),
    "policy-file-command",
  );
  const github = el(
    "a",
    "flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-on-surface hover:bg-surface-container-low",
  );
  github.href = "https://github.com/samartomar/ai-harness";
  github.target = "_blank";
  github.rel = "noopener noreferrer";
  github.append(icon("arrow_outward"), el("span", "", "Open AIH on GitHub"));
  const clear = menuItem("clear-policy", "sync", "Clear policy (resets your work)");
  clear.classList.add("text-error");
  clear.title = "Clear policy (resets your work)";

  const policyFile = fileInput("policy-file");
  const evidenceFile = fileInput("evidence-file");
  const decisionFile = fileInput("decision-file");

  menu.append(
    importPolicy,
    importEvidence,
    importDecision,
    downloadDecision,
    exportPolicy,
    filenameLabel,
    help,
    command,
    el("hr", "w-full my-1 border-0 border-t border-solid border-outline-variant"),
    github,
    clear,
  );
  const anchor = el("div", "relative flex items-center gap-2 shrink-0");
  anchor.append(validate, download, menuToggle, menu, policyFile, evidenceFile, decisionFile);
  shell.headerActions.append(anchor);

  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  menuToggle.addEventListener("click", () => setMenu(menu.hidden === true));
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setMenu(false);
    menuToggle.focus();
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (menu.hidden || !(target instanceof Node) || anchor.contains(target)) return;
      setMenu(false);
    },
    { signal: teardown.signal },
  );

  const updateFilenameHelp = () => {
    const value = filename.value.trim();
    const valid = POLICY_FILENAME_PATTERN.test(value);
    filename.setAttribute("aria-invalid", valid ? "false" : "true");
    help.textContent = valid
      ? FILENAME_HELP
      : "Use a JSON filename without folders, spaces, or hidden characters.";
    command.textContent = valid
      ? `aih policy validate <target-root> --policy ${value}`
      : "aih policy validate <target-root> --policy <safe-policy-file.json>";
  };
  filename.addEventListener("input", updateFilenameHelp);
  updateFilenameHelp();

  importPolicy.addEventListener("click", () => policyFile.click());
  policyFile.addEventListener("change", () =>
    readImportFile(policyFile, announce, (text) => {
      try {
        const parsed = parseNativeStrictJsonObjectV1(text, "file import");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        session.importPolicy(parsed);
      } catch (error) {
        announce(
          `Policy import rejected: ${errorMessage(error, "valid policy JSON required")}`,
          true,
        );
      }
    }),
  );

  importEvidence.addEventListener("click", () => evidenceFile.click());
  evidenceFile.addEventListener("change", () =>
    readImportFile(evidenceFile, announce, (text) => {
      try {
        const parsed = parseNativeStrictJsonObjectV1(text, "file import");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        session.setReceipt(parsed);
        announce(
          "Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.",
        );
      } catch {
        announce("Evidence import failed: valid JSON object required.", true);
      }
    }),
  );

  // A later decision import supersedes an earlier one still being read.
  let decisionRead = 0;
  const showDecision = () => {
    downloadDecision.disabled = session.decision() === null;
  };
  importDecision.addEventListener("click", () => decisionFile.click());
  decisionFile.addEventListener("change", () => {
    const file = decisionFile.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      announce("Decision import rejected: file exceeds the 1 MiB limit.", true);
      return;
    }
    const read = ++decisionRead;
    const prior = session.decision() === null ? null : structuredClone(session.decision());
    const reader = new FileReader();
    const failed = () => {
      if (read !== decisionRead) return;
      session.setDecision(prior);
      showDecision();
      announce("Decision import rejected: unable to read decision file", true);
    };
    reader.onerror = failed;
    reader.onabort = failed;
    reader.onload = () => {
      if (read !== decisionRead) return;
      try {
        const parsed = parseNativeStrictJsonObjectV1(
          String(reader.result || ""),
          "decision import",
        );
        const problems = decisionProblems(parsed, options.decisionSchema, policySchemaErrors);
        if (problems.length) throw new Error(problems.slice(0, 3).join("; "));
        session.setDecision(structuredClone(parsed));
        announce("Decision imported for inspection only: unverified and not effective.");
        showDecision();
      } catch (error) {
        session.setDecision(prior);
        showDecision();
        announce(
          `Decision import rejected: ${errorMessage(error, "strict decision JSON required")}`,
          true,
        );
      }
    };
    reader.readAsText(file);
  });
  downloadDecision.addEventListener("click", () => {
    const decision = session.decision();
    if (!decision) return;
    downloadBlob(DECISION_FILENAME, decisionFileText(decision));
    announce("Canonical decision download started; it remains unverified and not effective.");
  });

  validate.addEventListener("click", () => {
    const errors = session.validate();
    const blockers = session.readinessBlockers();
    validate.classList.remove("check-failed", "check-attention");
    validate.dataset.wbCheck = errors.length ? "failed" : blockers.length ? "attention" : "passed";
    if (errors.length) {
      validate.classList.add("check-failed");
      validate.title = `Policy check failed: ${errors.join("; ")}`;
      announce(
        `Schema and policy-grammar validation failed: ${errors.slice(0, 3).join("; ")}`,
        true,
      );
    } else if (blockers.length) {
      validate.classList.add("check-attention");
      validate.title = `Deployment setup needs attention: ${blockers.join("; ")}`;
      announce(
        `Schema and policy-grammar validation passed, but deployment setup needs attention: ${blockers.join("; ")}.`,
        true,
      );
    } else {
      validate.title = "Check Policy";
      announce(
        "Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.",
      );
    }
    options.renderPreview();
  });

  exportPolicy.addEventListener("click", () => {
    setMenu(false);
    shell.router.setScreen("changes");
    document.getElementById("wb-screen-title-changes")?.focus({ preventScroll: true });
    const blocked = session.validate().concat(session.readinessBlockers());
    if (blocked.length) {
      announce(`Export blocked: ${blocked.slice(0, 3).join("; ")}`, true);
      return;
    }
    options.renderPreview();
    announce("Policy export preview refreshed from the actual policy schema and grammar.");
  });

  download.addEventListener("click", () => {
    const blocked = session.validate().concat(session.readinessBlockers());
    if (blocked.length) {
      announce(`Download blocked: ${blocked.slice(0, 3).join("; ")}`, true);
      return;
    }
    const name = filename.value.trim();
    if (!POLICY_FILENAME_PATTERN.test(name)) {
      announce(
        "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
        true,
      );
      return;
    }
    downloadBlob(name, session.serialize());
    announce(
      `Policy download started. Validate this file with: aih policy validate <target-root> --policy ${name}`,
    );
  });

  clear.addEventListener("click", () => {
    setMenu(false);
    session.clear();
    menuToggle.focus({ preventScroll: true });
  });

  if (!options.catalogValid) {
    validate.disabled = true;
    download.disabled = true;
  }
  return {
    destroy() {
      teardown.abort();
      anchor.remove();
    },
  };
}
