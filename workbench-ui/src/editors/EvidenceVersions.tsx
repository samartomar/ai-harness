import type { EvidenceDeliveryV1 } from "../../../src/org-policy/workbench/engine/index.js";
import { Flyout, SECONDARY_BUTTON } from "../chrome.js";

/**
 * The "Evidence & versions" drawer (`ui/shell/org-screen.ts` lines 426-471):
 * the rows `src/org-policy/evidence-delivery-rows.ts` computes, and its note.
 * Absent entirely when the artifact carries no delivery data, exactly as the
 * hand-built page omits the control.
 *
 * Every label and value is model text, rendered as React text, never markup.
 */

export const EVIDENCE_TITLE = "Evidence & versions";
export const EVIDENCE_DESCRIPTION =
  "The preparation inputs of this artifact. A scan does not grant organization approval.";

export function EvidenceVersions({
  delivery,
  open,
  onOpenChange,
}: {
  readonly delivery: EvidenceDeliveryV1 | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  if (delivery === undefined) return null;
  return (
    <Flyout
      description={EVIDENCE_DESCRIPTION}
      onOpenChange={onOpenChange}
      open={open}
      title={`${EVIDENCE_TITLE} · Core ${delivery.coreVersion}`}
      trigger={
        <button className={SECONDARY_BUTTON} type="button">
          {EVIDENCE_TITLE}
        </button>
      }
    >
      <dl className="m-0 flex flex-col gap-1 text-[12px]">
        {delivery.rows.map(([label, value]) => (
          <div key={`${label}-${value}`}>
            <dt className="text-on-surface">
              <strong>{label}</strong>
            </dt>
            <dd className="m-0 text-on-surface-variant [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[12px] text-on-surface-variant">{delivery.note}</p>
    </Flyout>
  );
}
