import type { EngineOutcome } from "../../../src/org-policy/workbench/engine/index.js";

/**
 * The one shared props shape of the editors: how an editor asks the page to
 * run an engine call, show its outcome and re-read the engine's state.
 */
export type RunEngineCall = (call: () => EngineOutcome) => void;
