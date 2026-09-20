import type { AdminScreenProps } from "./types.js";

/**
 * The "Organization" screen (`screens/admin-org.html`). It composes editors
 * only; each editor is its own file under `src/editors/`.
 */

export const ORG_SCREEN_TITLE = "Organization";

export function OrgScreen(_props: AdminScreenProps) {
  return (
    <main aria-label={ORG_SCREEN_TITLE} className="flex-1 overflow-y-auto p-5 space-y-4">
      <h1 className="text-[13px] font-semibold text-on-surface">{ORG_SCREEN_TITLE}</h1>
    </main>
  );
}
