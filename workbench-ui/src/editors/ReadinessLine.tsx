/**
 * The deployment readiness line (`ui/shell/org-screen.ts` lines 557-562 and
 * 851-880): what the draft still owes before a download, announced politely so
 * a change is read without moving focus. The sentence is the engine's.
 */

export const READINESS_LABEL = "Deployment readiness";

export function ReadinessLine({ readiness }: { readonly readiness: string }) {
  return (
    <p
      aria-label={READINESS_LABEL}
      aria-live="polite"
      className="m-0 text-[11px] leading-snug text-on-surface-variant [overflow-wrap:anywhere]"
      role="status"
    >
      {readiness}
    </p>
  );
}
