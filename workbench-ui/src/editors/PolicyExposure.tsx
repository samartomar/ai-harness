import type {
  AdminEngine,
  AdminExposureItemV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { FACT_ROW, FACTS } from "../chrome.js";

/**
 * Editor 19b: the policy exposure panel (`ui/catalog-inventory.ts`
 * `renderExposureOverview`, lines 1085-1387). The engine supplies every
 * sentence; this file places them as text.
 *
 * The hand-built page shows this as an inspector view. Lane A owns the
 * inspector, so this is a standalone panel; the lead moves it into an
 * inspector tab at merge.
 */

export const POLICY_EXPOSURE_TITLE = "Policy exposure";
const COUNTS_LABEL = "Catalog exposure counts";

export function PolicyExposure({ engine }: { readonly engine: AdminEngine }) {
  const exposure = engine.policyExposure();
  return (
    <section aria-label={POLICY_EXPOSURE_TITLE} className="space-y-2">
      <h3 className="font-semibold text-on-surface text-[12px] font-mono">{exposure.heading}</h3>
      <p className="text-on-surface-variant">{exposure.intro}</p>
      <p className="text-outline">{exposure.scope}</p>
      <dl aria-label={COUNTS_LABEL} className={FACTS}>
        {exposure.counts.map((count) => (
          <div className={FACT_ROW} key={count.label} title={count.help}>
            <dt className="text-on-surface-variant">{count.label}</dt>
            <dd className="text-on-surface font-semibold font-mono tabular-nums">{count.figure}</dd>
          </div>
        ))}
      </dl>
      <p className="p-2.5 rounded border border-surface-container-high/60 bg-surface-container-low text-on-surface-variant">
        {exposure.limits}
      </p>
      <Group
        empty={exposure.selectedEmpty}
        heading={exposure.selectedHeading}
        items={exposure.selected}
      />
      <Group
        empty={exposure.requestEmpty}
        heading={exposure.requestHeading}
        intro={exposure.requestIntro}
        items={exposure.requests}
      />
    </section>
  );
}

function Group({
  heading,
  intro,
  items,
  empty,
}: {
  readonly heading: string;
  readonly intro?: string;
  readonly items: readonly AdminExposureItemV1[];
  readonly empty: string | undefined;
}) {
  return (
    <section aria-label={heading} className="space-y-1.5">
      <h4 className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {heading}
      </h4>
      {intro === undefined ? null : <p className="text-outline">{intro}</p>}
      {empty === undefined ? (
        <ul className="list-none m-0 p-0 space-y-1.5">
          {items.map((item) => (
            <li
              className="p-2.5 rounded bg-surface-container-low border border-surface-container-high/60 flex flex-col gap-1"
              key={`${item.assetId}:${item.meta}`}
            >
              <p className="font-mono font-bold text-[12px] text-on-surface break-words">
                {item.label}
              </p>
              <p className="font-mono text-[10px] text-outline">{item.meta}</p>
              <p className="text-on-surface-variant">{item.access}</p>
              {/* The check state is told by its words, never by colour alone. */}
              <p className="self-start px-1.5 py-0.5 rounded bg-surface-container font-mono text-[10px] text-on-surface-variant">
                {item.checks}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-on-surface-variant">{empty}</p>
      )}
    </section>
  );
}
