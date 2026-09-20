import type { AdminEngine, AdminState } from "../../../src/org-policy/workbench/engine/index.js";
import { Segmented } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/** The organization's posture: the header's two-option segmented control. */

const GROUP_LABEL = "Posture";
const OPTIONS = [
  { value: "vibe" as const, label: "Vibe" },
  { value: "enterprise" as const, label: "Enterprise" },
];

export function PostureSwitch({
  engine,
  posture,
  run,
}: {
  readonly engine: AdminEngine;
  readonly posture: AdminState["posture"];
  readonly run: RunEngineCall;
}) {
  return (
    <Segmented
      label={GROUP_LABEL}
      onChange={(value) => run(() => engine.setPosture(value))}
      options={OPTIONS}
      value={posture}
    />
  );
}
