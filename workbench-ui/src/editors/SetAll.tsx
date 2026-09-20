import type {
  TrimUseV1,
  UserDoorViewModelV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { DEFAULT_USE, USE_OPTIONS } from "./TrimList.js";

/**
 * "Set all N": one press sets every listed item the same way, and an option is
 * pressed only while they all already agree (`ui/user-door.ts` lines 429-464).
 */

const GROUP_LABEL = "Set every item";

export function SetAll({
  items,
  choices,
  onSetAll,
}: {
  readonly items: UserDoorViewModelV1["items"];
  readonly choices: ReadonlyMap<string, TrimUseV1>;
  readonly onSetAll: (use: TrimUseV1) => void;
}) {
  if (items.length === 0) return null;
  return (
    <fieldset className="flex items-center gap-2 border-0 p-0 m-0">
      {/* The group's name, and the head label the hand-built page shows. */}
      <legend className="sr-only">{GROUP_LABEL}</legend>
      <span className="text-[10.5px] font-mono text-outline uppercase tracking-wider">
        {`Set all ${items.length}`}
      </span>
      <div className="flex items-center bg-surface-container-lowest p-0.5 rounded border border-surface-container-high/60">
        {USE_OPTIONS.map((option) => {
          const all = items.every(
            (item) => (choices.get(item.assetId) ?? DEFAULT_USE) === option.value,
          );
          return (
            <button
              aria-pressed={all}
              className={`px-2 py-0.5 text-[10.5px] rounded transition-colors ${
                all
                  ? "bg-surface-container text-primary font-semibold shadow-xs"
                  : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
              }`}
              key={option.value}
              onClick={() => onSetAll(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
