import type {
  TrimUseV1,
  UserDoorTrimItemV1,
  UserDoorViewModelV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { CARD, CARD_FOOTER, CARD_GRID, CARD_TITLE, KIND_CHIP, Segmented } from "../chrome.js";

/** The items the project may carry, and the use each one is set to. */

export const USE_OPTIONS: readonly { value: TrimUseV1; label: string }[] = [
  { value: "required", label: "Required" },
  { value: "optional", label: "Optional" },
  { value: "skip", label: "Skip" },
];

/** The view's own default when a person has not chosen (`user-door.ts` line 183). */
export const DEFAULT_USE: TrimUseV1 = "optional";

const AMBIGUOUS_HEADING = "Not offered: listed under more than one origin";

export function TrimList({
  items,
  choices,
  onChoose,
}: {
  readonly items: UserDoorViewModelV1["items"];
  readonly choices: ReadonlyMap<string, TrimUseV1>;
  readonly onChoose: (assetId: string, use: TrimUseV1) => void;
}) {
  return (
    <div className={CARD_GRID}>
      {items.map((item) => (
        <TrimCard
          item={item}
          key={item.assetId}
          onChange={(use) => onChoose(item.assetId, use)}
          use={choices.get(item.assetId) ?? DEFAULT_USE}
        />
      ))}
    </div>
  );
}

export function AmbiguousItems({ assetIds }: { readonly assetIds: readonly string[] }) {
  if (assetIds.length === 0) return null;
  return (
    <section className="space-y-1">
      <h2 className="font-bold text-white text-[13px] tracking-tight">{AMBIGUOUS_HEADING}</h2>
      <ul className="text-[11px] font-mono text-outline list-disc pl-5">
        {assetIds.map((assetId) => (
          <li key={assetId}>{assetId}</li>
        ))}
      </ul>
    </section>
  );
}

function TrimCard({
  item,
  use,
  onChange,
}: {
  readonly item: UserDoorTrimItemV1;
  readonly use: TrimUseV1;
  readonly onChange: (use: TrimUseV1) => void;
}) {
  const title = item.label ?? item.assetId;
  return (
    <div className={CARD} data-card-id={item.assetId}>
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className={CARD_TITLE}>{title}</span>
          <span className={KIND_CHIP}>{item.kind ?? "item"}</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2 leading-relaxed">{item.assetId}</p>
      </div>
      <div className={CARD_FOOTER}>
        <span className="font-mono text-outline">{item.origin.kind}</span>
        <Segmented label={title} onChange={onChange} options={USE_OPTIONS} size="sm" value={use} />
      </div>
    </div>
  );
}
