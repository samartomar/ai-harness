import { type ReactNode, useId, useState } from "react";
import type { ItemInspectionV1 } from "../../../src/org-policy/workbench/engine/index.js";
import { FACT_ROW, FACTS, GHOST_BUTTON, PANEL_HEADING } from "../chrome.js";

/**
 * Inventory row 12: the item inspector of the hand-built page, in the
 * inspector rail's three tabs (`ui/shell/admin-shell.ts` `INSPECTOR_TABS`:
 * Details, Security Scan, Policy JSON) over `assetDetailsPresentation` and
 * `assetEvidencePresentation`.
 *
 * ADDING A TAB IS ONE LINE: another lane's panel ("Draft review", "Policy
 * exposure") passes an `InspectorTab` through `extraTabs`; it needs nothing
 * from this file but the shape.
 */

/** One inspector tab: its id, the label on the tab, and what the panel shows. */
export interface InspectorTab {
  readonly id: string;
  readonly label: string;
  readonly render: () => ReactNode;
}

const RAIL_LABEL = "Inspector";
const TABS_LABEL = "Inspector views";
const CLOSE = "Close inspector";
const IDLE = "Select an item to inspect it.";
const DETAILS = "Details";
const SECURITY = "Security Scan";
const POLICY_JSON = "Policy JSON";
const SCOPE_HEADING = "Covered paths";
const NO_FINDINGS = "No findings are listed in this report.";
const NO_SCOPE = "No covered paths are declared.";

export function ItemInspector({
  item,
  onClose,
  extraTabs = [],
}: {
  readonly item: ItemInspectionV1 | undefined;
  readonly onClose: () => void;
  /** Further tabs, each one line at the call site. */
  readonly extraTabs?: readonly InspectorTab[];
}) {
  const panelId = useId();
  const [active, setActive] = useState(DETAILS);
  const tabs: readonly InspectorTab[] =
    item === undefined
      ? []
      : [
          { id: DETAILS, label: DETAILS, render: () => <DetailsPanel item={item} /> },
          { id: SECURITY, label: SECURITY, render: () => <SecurityPanel item={item} /> },
          {
            id: POLICY_JSON,
            label: POLICY_JSON,
            render: () => (
              <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[10.5px] text-on-surface-variant">
                {item.policyJson}
              </pre>
            ),
          },
          ...extraTabs,
        ];
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <aside
      aria-label={RAIL_LABEL}
      className="shrink-0 w-[390px] bg-[#0e131d] border-l border-surface-container-high/60 flex flex-col overflow-hidden"
    >
      <div className="p-2.5 border-b border-surface-container-high/40 flex items-center gap-2 shrink-0">
        <div
          aria-label={TABS_LABEL}
          className="flex items-center flex-1 min-w-0 gap-0.5 text-[11px]"
          role="tablist"
        >
          {tabs.map((tab) => (
            <button
              aria-controls={panelId}
              aria-selected={tab.id === current?.id}
              className={`flex-1 py-1 px-1 rounded text-center transition-colors ${
                tab.id === current?.id
                  ? "bg-surface-container text-primary font-semibold"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
              key={tab.id}
              onClick={() => setActive(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button className={GHOST_BUTTON} onClick={onClose} type="button">
          {CLOSE}
        </button>
      </div>
      <div
        aria-label={RAIL_LABEL}
        className="flex-1 overflow-y-auto p-3 text-[12px] text-on-surface-variant space-y-2"
        id={panelId}
        role="tabpanel"
      >
        {current === undefined ? <p>{IDLE}</p> : current.render()}
      </div>
    </aside>
  );
}

function DetailsPanel({ item }: { readonly item: ItemInspectionV1 }) {
  return (
    <div className="space-y-2">
      <h2 className={PANEL_HEADING}>{item.title}</h2>
      <p className="[overflow-wrap:anywhere]">{item.summary}</p>
      <dl className={FACTS}>
        {item.facts.map((fact) => (
          <div className={FACT_ROW} key={`${fact.label}:${fact.value}`}>
            <dt className="text-outline shrink-0">{fact.label}</dt>
            <dd className="m-0 text-right whitespace-pre-wrap [overflow-wrap:anywhere]">
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SecurityPanel({ item }: { readonly item: ItemInspectionV1 }) {
  const security = item.security;
  const rows: readonly { label: string; value: string }[] = [
    { label: "Security review", value: security.statusLabel },
    ...(security.reportedResult === undefined
      ? []
      : [{ label: "Reported result", value: security.reportedResult }]),
    { label: "Binding", value: security.binding },
    { label: "Coverage", value: security.coverage },
    { label: "Catalog qualification", value: security.qualification },
    { label: "Report validity", value: security.freshness },
    { label: "Next step", value: security.nextStep },
    { label: "What a scan does not say", value: security.limitation },
  ];
  return (
    <div className="space-y-2">
      <dl className={FACTS}>
        {rows.map((row) => (
          <div className={FACT_ROW} key={row.label}>
            <dt className="text-outline shrink-0">{row.label}</dt>
            <dd className="m-0 text-right whitespace-pre-wrap [overflow-wrap:anywhere]">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <section aria-label={security.findingsLabel} className="space-y-1">
        <h3 className={PANEL_HEADING}>{security.findingsLabel}</h3>
        {security.findings.length === 0 ? (
          <p>{NO_FINDINGS}</p>
        ) : (
          <ul className="list-disc pl-4 space-y-1">
            {security.findings.map((finding) => (
              <li className="[overflow-wrap:anywhere]" key={finding}>
                {finding}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={SCOPE_HEADING} className="space-y-1">
        <h3 className={PANEL_HEADING}>{SCOPE_HEADING}</h3>
        {security.scopePaths.length === 0 ? (
          <p>{NO_SCOPE}</p>
        ) : (
          <ul className="list-disc pl-4 space-y-1">
            {security.scopePaths.map((path) => (
              <li className="font-mono [overflow-wrap:anywhere]" key={path}>
                {path}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
