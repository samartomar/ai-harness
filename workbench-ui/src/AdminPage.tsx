import { type ChangeEvent, useCallback, useId, useMemo, useState } from "react";
import {
  type AdminCatalogItem,
  type AdminEngine,
  type AdminState,
  createAdminEngine,
  DEFAULT_POLICY_FILENAME,
  type EngineOutcome,
} from "../../src/org-policy/workbench/engine/index.js";
import {
  CARD,
  CARD_FOOTER,
  CARD_GRID,
  CARD_TITLE,
  Divider,
  Flyout,
  GHOST_BUTTON,
  HEADER,
  Identity,
  KIND_CHIP,
  MASTHEAD,
  MessageStrip,
  ModeToggle,
  PRIMARY_BUTTON,
  RAIL,
  RAIL_HEADING,
  SECONDARY_BUTTON,
  Segmented,
  SUB_HEADER,
  TEXT_INPUT,
  ToggleSwitch,
  UnavailableControl,
} from "./chrome.js";
import type { WorkbenchHost } from "./host.js";
import { readImportedFile } from "./import-file.js";

/**
 * The organization page (journey J1), in the prototype's `admin-sources.html`
 * design. Every policy decision belongs to the engine entry: this file holds
 * presentation and draft text only.
 */

const MANAGED_MCP_LABEL = "Allow AIH to configure selected MCP tools";

const GITHUB_INTAKE_REASON = "Available on the local page opened by npx @aihq/core --ui";

export interface ModeControl {
  readonly label: string;
  readonly toggle: () => void;
}

export interface AdminPageProps {
  readonly host: WorkbenchHost;
  readonly model: unknown;
  readonly mode: ModeControl;
}

export function AdminPage({ host, model, mode }: AdminPageProps) {
  const created = useMemo(() => createAdminEngine(model), [model]);
  if (!created.ok) {
    return (
      <main className="p-6 space-y-2">
        <h1 className={CARD_TITLE}>Policy Workbench</h1>
        <div className="space-y-1 text-[11.5px] text-tertiary" role="alert">
          {created.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      </main>
    );
  }
  return <AdminWorkspace engine={created.value} host={host} mode={mode} />;
}

function AdminWorkspace({
  engine,
  host,
  mode,
}: {
  readonly engine: AdminEngine;
  readonly host: WorkbenchHost;
  readonly mode: ModeControl;
}) {
  const [state, setState] = useState<AdminState>(() => engine.state());
  const [outcome, setOutcome] = useState<EngineOutcome | undefined>(undefined);
  const [frameworkId, setFrameworkId] = useState<string | undefined>(
    () => engine.state().frameworks[0]?.sourceId,
  );
  const [fileName, setFileName] = useState(DEFAULT_POLICY_FILENAME);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const importId = useId();
  const policyTextId = useId();
  const fileNameId = useId();

  const run = useCallback(
    (call: () => EngineOutcome) => {
      setOutcome(call());
      setState(engine.state());
    },
    [engine],
  );

  const save = useCallback(
    (name: string) => {
      const file = engine.download(name);
      if (!file.ok) {
        setOutcome({ ok: false, message: file.errors.join("; ") });
        return;
      }
      host.save(file.value);
      setOutcome({ ok: true, message: `Policy download started: ${file.value.name}` });
    },
    [engine, host],
  );

  const check = useCallback(() => {
    const result = engine.check();
    const detail = [...result.errors, ...result.blockers].join("; ");
    setOutcome(
      result.ok && detail === ""
        ? { ok: true, message: "Schema and policy-grammar validation passed." }
        : { ok: result.ok, message: detail || "The policy check did not pass." },
    );
    setState(engine.state());
  }, [engine]);

  const importPolicy = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file === undefined) return;
      const read = await readImportedFile(file);
      if (!read.ok) {
        setOutcome({ ok: false, message: read.message });
        return;
      }
      run(() => engine.importPolicyText(read.text));
    },
    [engine, run],
  );

  const catalogReason = useMemo(() => {
    if (state.catalogValid) return undefined;
    const refused = engine.download();
    return refused.ok ? undefined : refused.errors.join("; ");
  }, [engine, state.catalogValid]);

  const framework =
    state.frameworks.find((entry) => entry.sourceId === frameworkId) ?? state.frameworks[0];
  const selectedTools = state.aiTools.filter((tool) => tool.selected).length;
  const blocked = !state.catalogValid;

  return (
    <div className="flex flex-col h-screen">
      <header className={HEADER}>
        <div className="flex items-center gap-2.5 shrink-0">
          <Identity door="Admin" />
          <Divider />
          <Segmented
            label="Posture"
            onChange={(value) => run(() => engine.setPosture(value))}
            options={[
              { value: "vibe", label: "Vibe" },
              { value: "enterprise", label: "Enterprise" },
            ]}
            value={state.posture}
          />
          <Divider />
          <Flyout
            description="Choose the AI tools this organization sanctions. Enterprise posture needs at least one."
            onOpenChange={setToolsOpen}
            open={toolsOpen}
            title="AI tools"
            trigger={
              <button
                className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors"
                type="button"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
                <span className="font-mono text-on-surface">
                  {selectedTools} of {state.aiTools.length}
                </span>
                <span className="text-outline">AI tools</span>
              </button>
            }
          >
            <div className="space-y-1">
              {state.aiTools.map((tool) => (
                <button
                  aria-checked={tool.selected}
                  aria-label={tool.label}
                  className="flex w-full items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-surface-container-low text-on-surface"
                  key={tool.id}
                  onClick={() => run(() => engine.toggleAiTool(tool.id))}
                  role="switch"
                  type="button"
                >
                  <span>{tool.label}</span>
                  <span className="font-mono text-[10px] text-outline">
                    {tool.selected ? "allowed" : "not allowed"}
                  </span>
                </button>
              ))}
            </div>
          </Flyout>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            className={GHOST_BUTTON}
            href={host.navigation.href("user")}
            onClick={(event) => {
              event.preventDefault();
              host.navigation.go("user");
            }}
          >
            User page
          </a>
          <Flyout
            description="The policy file exactly as it will be written, and the checks that gate it."
            onOpenChange={setReviewOpen}
            open={reviewOpen}
            title="Review changes"
            trigger={
              <button className={SECONDARY_BUTTON} type="button">
                Review Changes
              </button>
            }
          >
            <ReviewBody
              blocked={blocked}
              engine={engine}
              fileName={fileName}
              fileNameId={fileNameId}
              managedMcpOptIn={state.managedMcpOptIn}
              onDownload={() => save(fileName)}
              onFileName={setFileName}
              onManagedMcp={(next) => run(() => engine.setManagedMcpOptIn(next))}
              outcome={outcome}
              policyText={state.policyText}
              policyTextId={policyTextId}
            />
          </Flyout>
          <button className={SECONDARY_BUTTON} disabled={blocked} onClick={check} type="button">
            Check Policy
          </button>
          <button
            className={PRIMARY_BUTTON}
            disabled={blocked}
            onClick={() => save(DEFAULT_POLICY_FILENAME)}
            type="button"
          >
            Publish
          </button>
          <Divider />
          <ModeToggle label={mode.label} onToggle={mode.toggle} />
        </div>
      </header>

      <div className={SUB_HEADER}>
        <MessageStrip outcome={outcome} />
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className={RAIL}>
          <div className="p-2 space-y-1 flex-1 overflow-y-auto">
            <div className={RAIL_HEADING}>
              <span>Catalog scopes</span>
            </div>
            <div className="space-y-0.5 text-[11px]">
              {state.frameworks.map((entry) => {
                const active = entry.sourceId === framework?.sourceId;
                return (
                  <button
                    aria-pressed={active}
                    className={`flex w-full items-center justify-between px-1.5 py-1 rounded border border-surface-container-high/40 ${
                      active
                        ? "bg-surface-container-low/80 text-primary font-semibold"
                        : "bg-surface-container-low/40 hover:bg-surface-container-low/80 text-on-surface"
                    }`}
                    key={entry.sourceId}
                    onClick={() => setFrameworkId(entry.sourceId)}
                    type="button"
                  >
                    <span className="truncate text-[11.5px]">{entry.label}</span>
                    <span className="font-mono text-[10px] text-outline">
                      {entry.groups.reduce((total, group) => total + group.items.length, 0)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className={MASTHEAD}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
                Source
              </span>
              <span className="font-mono font-bold text-white text-[15px] tracking-tight truncate">
                {framework?.label ?? "No catalog source"}
              </span>
              <span className="font-mono text-[10.5px] text-outline">
                {state.selectedAssetIds.length} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className={`${SECONDARY_BUTTON} cursor-pointer`} htmlFor={importId}>
                Import policy
              </label>
              <input
                accept="application/json"
                className="sr-only"
                id={importId}
                onChange={(event) => void importPolicy(event)}
                type="file"
              />
              {host.capabilities.githubIntake ? null : (
                <UnavailableControl
                  label="Import skills from GitHub"
                  reason={GITHUB_INTAKE_REASON}
                />
              )}
            </div>
          </div>

          {catalogReason === undefined ? null : (
            <p className="px-5 py-2 text-[11.5px] text-tertiary">{catalogReason}</p>
          )}

          <div className="flex-1 overflow-y-auto p-4 bg-[#0d111a] flex flex-col gap-4">
            {framework?.groups.map((group) => (
              <section className="flex flex-col gap-2" key={group.id}>
                <h2 className="font-bold text-white text-[13px] tracking-tight">{group.label}</h2>
                <div className={CARD_GRID}>
                  {group.items.map((item) => (
                    <CatalogCard
                      item={item}
                      key={item.assetId}
                      onToggle={(next) => run(() => engine.setItemSelected(item.assetId, next))}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogCard({
  item,
  onToggle,
}: {
  readonly item: AdminCatalogItem;
  readonly onToggle: (selected: boolean) => void;
}) {
  const reasonId = useId();
  return (
    <div className={CARD} data-card-id={item.assetId}>
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={CARD_TITLE}>{item.label}</span>
          </div>
          <span className={KIND_CHIP}>{item.kind}</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2 leading-relaxed">{item.assetId}</p>
      </div>
      <div className={CARD_FOOTER}>
        <span
          className={`px-1.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 ${
            item.selected
              ? "bg-secondary-container/20 text-secondary"
              : "bg-surface-container-low border border-surface-container-high/40 text-outline"
          }`}
        >
          <span
            className={`w-1 h-1 rounded-full ${item.selected ? "bg-secondary" : "bg-outline"}`}
          />
          {item.selected ? "Selected" : "Not selected"}
        </span>
        <div className="flex items-center gap-1.5">
          {item.selectable ? null : (
            <span className="text-[10px] text-outline" id={reasonId}>
              {item.reason}
            </span>
          )}
          <button
            aria-checked={item.selected}
            aria-describedby={item.selectable ? undefined : reasonId}
            aria-disabled={item.selectable ? undefined : true}
            aria-label={item.label}
            className={`toggle-switch w-6 h-3.5 rounded-full p-0.5 flex items-center transition-colors ${
              item.selected ? "bg-primary" : "bg-surface-container-highest"
            }`}
            data-active={item.selected}
            onClick={() => {
              if (item.selectable) onToggle(!item.selected);
            }}
            role="switch"
            type="button"
          >
            <span
              className={`w-2.5 h-2.5 rounded-full bg-white transition-transform ${
                item.selected ? "translate-x-2.5" : ""
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewBody({
  engine,
  policyText,
  policyTextId,
  fileName,
  fileNameId,
  onFileName,
  onDownload,
  blocked,
  outcome,
  managedMcpOptIn,
  onManagedMcp,
}: {
  readonly engine: AdminEngine;
  readonly policyText: string;
  readonly policyTextId: string;
  readonly fileName: string;
  readonly fileNameId: string;
  readonly onFileName: (value: string) => void;
  readonly onDownload: () => void;
  readonly blocked: boolean;
  readonly outcome: EngineOutcome | undefined;
  readonly managedMcpOptIn: boolean;
  readonly onManagedMcp: (next: boolean) => void;
}) {
  const result = engine.check();
  const refused = outcome !== undefined && !outcome.ok ? outcome.message : "";
  const accepted = outcome?.ok === true ? outcome.message : "";
  const helpId = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1 text-tertiary empty:hidden" role="alert">
        {refused === "" ? null : <p>{refused}</p>}
        {[...result.errors, ...result.blockers].map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {/* The status strip lives behind this dialog, so every outcome is also
       * readable here, as text. */}
      <p className="text-secondary empty:hidden" role="status">
        {accepted}
      </p>
      {/* The prototype has no place for this setting; it belongs with the
       * checks that gate the download, in the prototype's own vocabulary. */}
      <div className="space-y-1 rounded bg-surface-container-low border border-surface-container-high/40 p-2">
        <ToggleSwitch
          checked={managedMcpOptIn}
          describedBy={helpId}
          label={MANAGED_MCP_LABEL}
          onToggle={onManagedMcp}
        />
        <p className="text-[10.5px] text-outline" id={helpId}>
          Needed when the policy selects Core MCP controls. No server is contacted from this page.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        Organization policy file
        <textarea
          className="h-56 w-full p-2 rounded bg-[#141822] border border-surface-container-high/60 font-mono text-[11px] text-on-surface normal-case tracking-normal"
          id={policyTextId}
          readOnly
          value={policyText}
        />
      </label>
      <label className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        File name
        <input
          className={`${TEXT_INPUT} w-64 normal-case tracking-normal`}
          id={fileNameId}
          onChange={(event) => onFileName(event.target.value)}
          type="text"
          value={fileName}
        />
      </label>
      <button className={PRIMARY_BUTTON} disabled={blocked} onClick={onDownload} type="button">
        Download
      </button>
    </div>
  );
}
