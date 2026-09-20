import { useId, useMemo, useState } from "react";
import type { CatalogFiltersV1 } from "../../../src/org-policy/workbench/engine/index.js";
import { MASTHEAD, UnavailableControl } from "../chrome.js";
import { CatalogBrowse } from "../editors/CatalogBrowse.js";
import { CatalogScopes } from "../editors/CatalogScopes.js";
import { ClearPolicy } from "../editors/ClearPolicy.js";
import { ImportPolicy } from "../editors/ImportPolicy.js";
import { ItemInspector } from "../editors/ItemInspector.js";
import { KindLedger } from "../editors/KindLedger.js";
import type { AdminScreenProps } from "./types.js";

/**
 * The "Sources & Catalogs" screen (`screens/admin-sources.html`): the kind
 * ledger, the catalog scopes rail, the source masthead, the catalog browse and
 * the item inspector. It composes only.
 */

const GITHUB_INTAKE_REASON = "Available on the local page opened by npx @aihq/core --ui";
const TOGGLE_SCOPES = "Toggle navigation";
const TOGGLE_INSPECTOR = "Toggle inspector";
const NO_SOURCE = "No catalog source";

export function SourcesScreen({ engine, host, state, run, importInto }: AdminScreenProps) {
  const [filters, setFilters] = useState<CatalogFiltersV1>(() => ({
    sourceId: engine.state().frameworks[0]?.sourceId,
    page: 0,
  }));
  const [openAssetId, setOpenAssetId] = useState<string | undefined>(undefined);
  const [scopesOpen, setScopesOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const importId = useId();

  const catalogReason = useMemo(() => {
    if (state.catalogValid) return undefined;
    const refused = engine.download();
    return refused.ok ? undefined : refused.errors.join("; ");
  }, [engine, state.catalogValid]);

  // A fresh read per render: `state` changes whenever an engine call ran.
  const view = engine.browseCatalog(filters);
  const ledger = engine.kindLedger();
  const item = openAssetId === undefined ? undefined : engine.inspectItem(openAssetId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <KindLedger entries={ledger} />

      <div className="flex flex-1 overflow-hidden">
        {scopesOpen ? (
          <CatalogScopes
            activeSourceId={filters.sourceId}
            frameworks={state.frameworks}
            onSelect={(sourceId) => setFilters({ ...filters, sourceId, page: 0 })}
          />
        ) : null}

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className={MASTHEAD}>
            <div className="flex items-center gap-2 min-w-0">
              <button
                aria-expanded={scopesOpen}
                className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold"
                onClick={() => setScopesOpen(!scopesOpen)}
                type="button"
              >
                {TOGGLE_SCOPES}
              </button>
              {/* The hand-built masthead's own `h3` (`catalog-inventory.ts` 2768). */}
              <h2 className="m-0 font-mono font-bold text-white text-[15px] tracking-tight truncate">
                {view.sourceLabel === "" ? NO_SOURCE : view.sourceLabel}
              </h2>
              <span className="font-mono text-[10.5px] text-outline">
                {state.selectedAssetIds.length} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ImportPolicy
                inputId={importId}
                onImport={(event) => void importInto(event, engine.importPolicyText)}
              />
              <ClearPolicy engine={engine} run={run} />
              <button
                aria-expanded={inspectorOpen}
                className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold"
                onClick={() => setInspectorOpen(!inspectorOpen)}
                type="button"
              >
                {TOGGLE_INSPECTOR}
              </button>
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

          <CatalogBrowse
            engine={engine}
            filters={filters}
            onFilters={setFilters}
            onOpen={(assetId) => {
              setOpenAssetId(assetId);
              setInspectorOpen(true);
            }}
            run={run}
            view={view}
          />
        </div>

        {/* ADDING AN INSPECTOR TAB: one `InspectorTab` in `extraTabs`. */}
        {inspectorOpen ? (
          <ItemInspector item={item} onClose={() => setInspectorOpen(false)} />
        ) : null}
      </div>
    </div>
  );
}
