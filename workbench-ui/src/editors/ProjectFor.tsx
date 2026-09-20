import { Segmented, TEXT_INPUT } from "../chrome.js";

/** What the cut is for: its type, its name, and the AI tools that carry it. */

export type ForType = "project" | "persona" | "agent";

const FOR_LABEL = "For";
const NAME_LABEL = "Name";
const AI_TOOLS_LABEL = "AI tools";
const FOR_OPTIONS = [
  { value: "project" as const, label: "Project" },
  { value: "persona" as const, label: "Persona" },
  { value: "agent" as const, label: "Agent" },
];

export function ProjectFor({
  forType,
  onForType,
  forName,
  onForName,
  nameFieldId,
  aiTools,
  chosenTools,
  onToolChange,
}: {
  readonly forType: ForType;
  readonly onForType: (value: ForType) => void;
  readonly forName: string;
  readonly onForName: (value: string) => void;
  readonly nameFieldId: string;
  readonly aiTools: readonly string[];
  readonly chosenTools: ReadonlySet<string>;
  readonly onToolChange: (tool: string, chosen: boolean) => void;
}) {
  return (
    <div className="px-3 py-2 border-b border-surface-container-high/40 flex flex-wrap items-center gap-2.5 text-[11px] shrink-0">
      <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
        {FOR_LABEL}
      </span>
      <Segmented label={FOR_LABEL} onChange={onForType} options={FOR_OPTIONS} value={forType} />
      <label className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {NAME_LABEL}
        <input
          className={`${TEXT_INPUT} w-40 normal-case tracking-normal`}
          id={nameFieldId}
          onChange={(event) => onForName(event.target.value)}
          type="text"
          value={forName}
        />
      </label>
      <fieldset className="flex items-center gap-2 border-0 p-0 m-0">
        <legend className="sr-only">{AI_TOOLS_LABEL}</legend>
        <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
          {AI_TOOLS_LABEL}
        </span>
        {aiTools.map((tool) => (
          <label className="flex items-center gap-1 text-[11px] text-on-surface" key={tool}>
            <input
              checked={chosenTools.has(tool)}
              onChange={(event) => onToolChange(tool, event.target.checked)}
              type="checkbox"
            />
            {tool}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
