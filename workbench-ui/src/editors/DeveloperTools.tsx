import type {
  AdminEngine,
  DeveloperToolActionV1,
  DeveloperToolsV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Developer tool setup (inventory row 13): `ui/developer-tool-selection.ts`
 * with `mountDeveloperTools` of `ui/main.ts` behind it. It records authoring
 * intent only; it never claims a tool is installed, configured, or verified.
 *
 * Every sentence — the summary, the status, each row's state — comes from the
 * engine. Each row's state is spelled out in words beside it, so no row is
 * distinguished by colour.
 */

export const DEVELOPER_TOOLS_TITLE = "Developer tool setup";
const HELP =
  "Choose the default developer tools for later setup. This authoring view records selection intent only; it does not claim a tool is installed, configured, or verified.";

const ACTION_LABEL: Readonly<Record<DeveloperToolActionV1, string>> = {
  include: "Include",
  remove: "Remove",
  exclude: "Exclude",
};

function actionName(action: DeveloperToolActionV1, label: string): string {
  if (action === "include") return `Include ${label} in setup`;
  if (action === "remove") return `Remove ${label} from selection`;
  return `Exclude ${label} from setup`;
}

export function DeveloperTools({
  engine,
  developerTools,
  run,
}: {
  readonly engine: AdminEngine;
  readonly developerTools: DeveloperToolsV1;
  readonly run: RunEngineCall;
}) {
  return (
    <section
      aria-label={DEVELOPER_TOOLS_TITLE}
      className="flex flex-col gap-2 px-3.5 py-3 rounded border border-surface-container-high/60 bg-surface-container-lowest min-w-0"
    >
      <h2 className="m-0 font-bold text-on-surface text-[13.5px]">{DEVELOPER_TOOLS_TITLE}</h2>
      <p className="m-0 text-[10.5px] leading-snug text-outline">{HELP}</p>
      <p className="m-0 text-[11.5px] font-semibold text-on-surface">{developerTools.summary}</p>
      <p
        aria-live="polite"
        className={`m-0 text-[10.5px] leading-snug ${
          developerTools.blocked ? "text-tertiary" : "text-outline"
        }`}
        role="status"
      >
        {developerTools.status}
      </p>
      <div className="flex flex-col gap-1.5 min-w-0">
        {developerTools.rows.map((row) => (
          <article
            aria-label={row.label}
            className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2 rounded bg-surface-container-low border border-surface-container-high/40 min-w-0"
            key={row.id}
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <h3 className="m-0 text-[12px] font-semibold text-on-surface">{row.label}</h3>
              <p className="m-0 text-[10.5px] text-outline leading-snug">{row.detail}</p>
              <p className="m-0 text-[10.5px] text-on-surface-variant">{row.stateText}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {row.actions.map((action) => (
                <button
                  aria-label={actionName(action, row.label)}
                  className={SECONDARY_BUTTON}
                  key={action}
                  onClick={() => run(() => engine.setDeveloperTool(row.id, action))}
                  type="button"
                >
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
