import type { AdminScreenProps } from "./types.js";

/**
 * The "Additions" screen (`screens/admin-acme.html`). It composes editors
 * only; each editor is its own file under `src/editors/`.
 */

export const ADDITIONS_SCREEN_TITLE = "Additions";

export function AdditionsScreen(_props: AdminScreenProps) {
  return (
    <main aria-label={ADDITIONS_SCREEN_TITLE} className="flex-1 overflow-y-auto p-5 space-y-4">
      <h1 className="text-[13px] font-semibold text-on-surface">{ADDITIONS_SCREEN_TITLE}</h1>
    </main>
  );
}
