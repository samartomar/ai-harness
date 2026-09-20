import type { AdminScreenId } from "../screens/types.js";

/** The admin page's screen nav (the prototype's "WORKBENCH" view selector). */

const SCREENS: readonly { readonly id: AdminScreenId; readonly label: string }[] = [
  { id: "sources", label: "Sources & Catalogs" },
  { id: "org", label: "Organization" },
  { id: "additions", label: "Additions" },
];

export function ScreenNav({
  screen,
  onScreen,
}: {
  readonly screen: AdminScreenId;
  readonly onScreen: (screen: AdminScreenId) => void;
}) {
  return (
    <nav aria-label="Workbench" className="flex items-center gap-0.5 text-[11px]">
      {SCREENS.map((entry) => (
        <button
          aria-current={entry.id === screen ? "page" : undefined}
          className={`px-2 py-1 rounded transition-colors ${
            entry.id === screen
              ? "bg-surface-container text-primary font-semibold"
              : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low"
          }`}
          key={entry.id}
          onClick={() => onScreen(entry.id)}
          type="button"
        >
          {entry.label}
        </button>
      ))}
    </nav>
  );
}
