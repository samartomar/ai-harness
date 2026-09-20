import type { ProvenanceLinesV1 } from "../../../src/org-policy/workbench/engine/index.js";

/**
 * The provenance strip (inventory row 8): the two sentences
 * `src/org-policy/provenance-lines.ts` builds — where the administrator
 * catalog came from, and where the baseline evidence came from. The hand-built
 * page prints them under its header (`studio-template.ts` lines 39-52), so
 * this strip sits under the admin page's header on every screen.
 *
 * Neither line is invented: an artifact prepared without a resolved catalog or
 * baseline shows nothing at all.
 */

export const PROVENANCE_LABEL = "Artifact provenance";

const LINE = "m-0 text-[10.5px] leading-snug text-outline [overflow-wrap:anywhere]";

export function ProvenanceStrip({ provenance }: { readonly provenance: ProvenanceLinesV1 }) {
  if (provenance.catalog === undefined && provenance.baselineEvidence === undefined) return null;
  return (
    <section
      aria-label={PROVENANCE_LABEL}
      className="px-3 py-1 bg-surface-container-lowest/90 border-b border-surface-container-high/40 shrink-0"
    >
      {provenance.catalog === undefined ? null : <p className={LINE}>{provenance.catalog}</p>}
      {provenance.baselineEvidence === undefined ? null : (
        <p className={LINE}>{provenance.baselineEvidence}</p>
      )}
    </section>
  );
}
