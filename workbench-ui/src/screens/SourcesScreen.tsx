import { useId, useMemo, useState } from "react";
import { MASTHEAD, UnavailableControl } from "../chrome.js";
import { CatalogCards } from "../editors/CatalogCards.js";
import { CatalogScopes } from "../editors/CatalogScopes.js";
import { ClearPolicy } from "../editors/ClearPolicy.js";
import { ImportPolicy } from "../editors/ImportPolicy.js";
import type { AdminScreenProps } from "./types.js";

/**
 * The "Sources & Catalogs" screen (`screens/admin-sources.html`): the catalog
 * scopes rail, the source masthead, and the catalog cards. It composes only.
 */

const GITHUB_INTAKE_REASON = "Available on the local page opened by npx @aihq/core --ui";

export function SourcesScreen({ engine, host, state, run, importInto }: AdminScreenProps) {
  const [frameworkId, setFrameworkId] = useState<string | undefined>(
    () => engine.state().frameworks[0]?.sourceId,
  );
  const importId = useId();

  const catalogReason = useMemo(() => {
    if (state.catalogValid) return undefined;
    const refused = engine.download();
    return refused.ok ? undefined : refused.errors.join("; ");
  }, [engine, state.catalogValid]);

  const framework =
    state.frameworks.find((entry) => entry.sourceId === frameworkId) ?? state.frameworks[0];

  return (
    <div className="flex flex-1 overflow-hidden">
      <CatalogScopes
        activeSourceId={framework?.sourceId}
        frameworks={state.frameworks}
        onSelect={setFrameworkId}
      />

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
            <ImportPolicy
              inputId={importId}
              onImport={(event) => void importInto(event, engine.importPolicyText)}
            />
            <ClearPolicy engine={engine} run={run} />
            {host.capabilities.githubIntake ? null : (
              <UnavailableControl label="Import skills from GitHub" reason={GITHUB_INTAKE_REASON} />
            )}
          </div>
        </div>

        {catalogReason === undefined ? null : (
          <p className="px-5 py-2 text-[11.5px] text-tertiary">{catalogReason}</p>
        )}

        <CatalogCards engine={engine} framework={framework} run={run} />
      </div>
    </div>
  );
}
