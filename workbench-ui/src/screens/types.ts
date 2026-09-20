import type { ChangeEvent } from "react";
import type {
  AdminEngine,
  AdminState,
  EngineOutcome,
} from "../../../src/org-policy/workbench/engine/index.js";
import type { RunEngineCall } from "../editors/types.js";
import type { WorkbenchHost } from "../host.js";

/** The admin page's screens, in the prototype's order. */
export type AdminScreenId = "sources" | "org" | "additions";

/**
 * What the admin page hands every screen. A screen composes editors; it owns
 * only the state that is local to it (which source is open, which tab).
 */
export interface AdminScreenProps {
  readonly engine: AdminEngine;
  readonly host: WorkbenchHost;
  readonly state: AdminState;
  /** Run an engine call, show its outcome, re-read the engine's state. */
  readonly run: RunEngineCall;
  /** Show an outcome that did not come from an engine call (a host refusal). */
  readonly setOutcome: (outcome: EngineOutcome) => void;
  /** Every file import: the host reads the file, the engine judges the text. */
  readonly importInto: (
    event: ChangeEvent<HTMLInputElement>,
    call: (text: string) => EngineOutcome,
  ) => Promise<void>;
}
