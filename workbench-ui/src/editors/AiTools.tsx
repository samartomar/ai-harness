import type { AdminEngine, AdminState } from "../../../src/org-policy/workbench/engine/index.js";
import { Flyout } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/** The AI tools this organization sanctions: the header flyout and its switches. */

const TITLE = "AI tools";
const DESCRIPTION =
  "Choose the AI tools this organization sanctions. Enterprise posture needs at least one.";
const ALLOWED = "allowed";
const NOT_ALLOWED = "not allowed";

export function AiTools({
  engine,
  tools,
  open,
  onOpenChange,
  run,
}: {
  readonly engine: AdminEngine;
  readonly tools: AdminState["aiTools"];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly run: RunEngineCall;
}) {
  const selected = tools.filter((tool) => tool.selected).length;
  return (
    <Flyout
      description={DESCRIPTION}
      onOpenChange={onOpenChange}
      open={open}
      title={TITLE}
      trigger={
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors"
          type="button"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
          <span className="font-mono text-on-surface">
            {selected} of {tools.length}
          </span>
          <span className="text-outline">{TITLE}</span>
        </button>
      }
    >
      <div className="space-y-1">
        {tools.map((tool) => (
          <button
            aria-checked={tool.selected}
            aria-label={tool.label}
            className="flex w-full items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-surface-container-low text-on-surface"
            key={tool.id}
            onClick={() => run(() => engine.toggleAiTool(tool.id))}
            role="switch"
            type="button"
          >
            <span>{tool.label}</span>
            <span className="font-mono text-[10px] text-outline">
              {tool.selected ? ALLOWED : NOT_ALLOWED}
            </span>
          </button>
        ))}
      </div>
    </Flyout>
  );
}
