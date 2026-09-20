import type { AdoptionRoleV1 } from "../../../src/org-policy/workbench/engine/index.js";
import { Flyout, SECONDARY_BUTTON } from "../chrome.js";

/**
 * The adoption recipe drawer (`ui/shell/org-screen.ts` lines 287-394): who
 * handles each step. It is a flyout, so it opens from the keyboard, holds
 * focus, closes on Escape and returns focus to its trigger (journey J4).
 *
 * Every line is the engine's: this file only places them as text.
 */

export const ADOPTION_TITLE = "Adoption recipe";
export const ADOPTION_DESCRIPTION =
  "Use this guide to decide who handles each step. Reading it does not change your policy.";
const EMPTY = "This artifact carries no adoption recipe roles.";

export function AdoptionRecipe({
  roles,
  open,
  onOpenChange,
}: {
  readonly roles: readonly AdoptionRoleV1[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Flyout
      description={ADOPTION_DESCRIPTION}
      onOpenChange={onOpenChange}
      open={open}
      title={ADOPTION_TITLE}
      trigger={
        <button className={SECONDARY_BUTTON} type="button">
          {`${ADOPTION_TITLE} →`}
        </button>
      }
    >
      {roles.length === 0 ? (
        <p className="m-0 text-[11.5px] text-on-surface-variant">{EMPTY}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {roles.map((role) => (
            <article
              aria-label={role.label}
              className="flex flex-col gap-1 px-2.5 py-2 rounded bg-surface-container-low border border-surface-container-high/40 text-[11.5px] leading-relaxed"
              key={role.id}
            >
              <strong className="text-on-surface">{role.label}</strong>
              <p className="m-0 text-on-surface-variant">{role.guidance}</p>
              <p className="m-0 text-on-surface-variant">
                <b className="text-on-surface">Prerequisites:</b> {role.prerequisites}
              </p>
              <p className="m-0 text-on-surface-variant">
                <b className="text-on-surface">Overlap / conflict:</b> {role.conflicts}
              </p>
              <p className="m-0 text-on-surface-variant">
                <b className="text-on-surface">Next action:</b> {role.nextAction}
              </p>
              <p className="m-0 text-on-surface-variant">
                <b className="text-on-surface">Usage / coverage:</b> {role.usage}
              </p>
            </article>
          ))}
        </div>
      )}
    </Flyout>
  );
}
