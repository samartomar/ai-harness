export interface WorkbenchSession {
  snapshotPolicy(): unknown;
  validatePolicy(policy: unknown): { policy: unknown; message?: string };
  restorePolicy(policy: unknown): string | undefined;
}

export interface GenericWorkspaceShellContext {
  model: { workbenchBundle?: unknown };
  byId(id: string): HTMLElement | null;
  session: WorkbenchSession;
}

function moveContainingSection(
  byId: GenericWorkspaceShellContext["byId"],
  target: HTMLElement,
  id: string,
): void {
  const element = byId(id);
  const section = element?.closest("section");
  if (section !== null && section !== undefined) target.append(section);
}

function addViewTabs(byId: GenericWorkspaceShellContext["byId"], tabs: HTMLElement): void {
  const closeDrawers = () => {
    const drawers: ReadonlyArray<readonly [string, string]> = [
      ["drawer", "scrim"],
      ["authoring-sidebar", "authoring-scrim"],
      ["ecc-mcp-sidebar", "ecc-mcp-scrim"],
    ];
    for (const [drawerId, scrimId] of drawers) {
      const drawer = byId(drawerId);
      const scrim = byId(scrimId);
      if (drawer !== null) drawer.hidden = true;
      scrim?.classList.remove("open");
    }
  };

  const setView = (view: string) => {
    closeDrawers();
    document.body.dataset.view = view;
    tabs.querySelectorAll<HTMLButtonElement>("[data-view-tab]").forEach((tab) => {
      tab.setAttribute("aria-pressed", tab.dataset.viewTab === view ? "true" : "false");
    });
  };

  window.__aihSetWorkbenchView = setView;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("#open-artifacts") !== null) {
        setView("artifacts");
      }
    },
    true,
  );
  tabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>("[data-view-tab]");
    if (tab?.dataset.viewTab !== undefined) setView(tab.dataset.viewTab);
  });
  setView("compose");
}

declare global {
  interface Window {
    __aihSetWorkbenchView?: (view: string) => void;
    __aihPolicyWorkbenchSession?: WorkbenchSession;
  }
}

/**
 * Mounts only the retained, non-catalog Studio forms around the generic
 * Workbench inventory. Catalog rendering and selection remain in
 * catalog-inventory.ts.
 */
export function mountGenericWorkspaceShell(context: GenericWorkspaceShellContext): boolean {
  if (context.model.workbenchBundle === undefined) return false;

  const workspace = document.querySelector<HTMLElement>(".work");
  const toolbar = document.querySelector<HTMLElement>(".bar");
  if (workspace === null || toolbar === null) return true;

  const tabs = document.createElement("nav");
  tabs.className = "tabs";
  tabs.setAttribute("aria-label", "Workbench views");
  tabs.innerHTML = [
    ["compose", "Compose"],
    ["artifacts", "Artifacts"],
    ["author", "Authoring"],
    ["imports", "Imports"],
  ]
    .map(
      ([id, label]) =>
        `<button type="button" data-view-tab="${id}" aria-pressed="false">${label}</button>`,
    )
    .join("");
  toolbar.prepend(tabs);

  const panels: Record<"artifacts" | "author" | "imports", HTMLElement> = {
    artifacts: document.createElement("div"),
    author: document.createElement("div"),
    imports: document.createElement("div"),
  };
  for (const [id, panel] of Object.entries(panels)) {
    panel.id = `panel-${id}`;
    panel.className = "plane pane";
    panel.setAttribute("role", "main");
    workspace.append(panel);
  }

  moveContainingSection(context.byId, panels.author, "protected-form");
  moveContainingSection(context.byId, panels.author, "curation-rows");
  moveContainingSection(context.byId, panels.author, "custom-rows");
  for (const id of ["curation-editor", "custom-editor", "remote-custom-editor"]) {
    const editor = context.byId(id);
    if (editor !== null) panels.author.append(editor);
  }
  const settings = context.byId("policy-settings");
  if (settings !== null) panels.author.prepend(settings);

  const byo = document.createElement("section");
  byo.className = "gcard sect";
  byo.innerHTML = '<h2>Bring Your Own</h2><div class="brow" id="byo-actions"></div>';
  const byoActions = byo.querySelector<HTMLElement>("#byo-actions");
  if (byoActions !== null) {
    for (const id of ["open-artifacts", "open-custom-hook-info"]) {
      const action = context.byId(id);
      if (action !== null) {
        action.className = "pop-row";
        byoActions.append(action);
      }
    }
  }
  panels.author.append(byo);

  const imports = document.createElement("section");
  imports.className = "gcard sect importbar";
  imports.innerHTML =
    '<h2>Imports and exports</h2><p class="help">Policy, evidence, and decisions are local files. Imported evidence is stored as a local draft until Core preparation.</p><div class="form-grid"><label>Policy download filename<input id="policy-download-name" value="aih-org-policy.json" maxlength="132" autocomplete="off" spellcheck="false"></label><div><p class="help" id="policy-file-help">Use one safe JSON filename per project or team. The browser chooses the download folder; move the file into an administrator-controlled policy folder when required.</p><pre class="mono" id="policy-file-command">aih policy validate &lt;target-root&gt; --policy aih-org-policy.json</pre></div></div><div class="cap">Import files</div><div class="brow" id="import-actions"></div>';
  const importActions = imports.querySelector<HTMLElement>("#import-actions");
  if (importActions !== null) {
    for (const id of ["import-policy", "import-evidence", "import-decision"]) {
      const action = context.byId(id);
      if (action !== null) importActions.append(action);
    }
  }
  panels.imports.append(imports);

  const filename = imports.querySelector<HTMLInputElement>("#policy-download-name");
  const help = imports.querySelector<HTMLElement>("#policy-file-help");
  const command = imports.querySelector<HTMLElement>("#policy-file-command");
  const updateFilenameHelp = () => {
    if (filename === null || help === null || command === null) return;
    const value = filename.value.trim();
    const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/.test(value);
    filename.setAttribute("aria-invalid", valid ? "false" : "true");
    help.textContent = valid
      ? "Use one safe JSON filename per project or team. The browser chooses the download folder; move the file into an administrator-controlled policy folder when required."
      : "Use a JSON filename without folders, spaces, or hidden characters.";
    command.textContent = valid
      ? `aih policy validate <target-root> --policy ${value}`
      : "aih policy validate <target-root> --policy <safe-policy-file.json>";
  };
  filename?.addEventListener("input", updateFilenameHelp);
  updateFilenameHelp();

  window.__aihPolicyWorkbenchSession = context.session;
  addViewTabs(context.byId, tabs);
  return true;
}
