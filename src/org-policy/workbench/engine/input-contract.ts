/**
 * The versioned input a host hands the component page (Policy Workbench UI
 * delivery, "Real hosts"). One shape, one version, parsed strictly: the page
 * never reads an input it did not recognise, and a host that ships a newer
 * input meets a message that names both versions.
 *
 * Pure by contract, like every module under `engine/`: no DOM, no `window`, no
 * Node built-ins. `parseWorkbenchInput` never throws.
 */

import { type EngineResult, record } from "./shared.js";

export const WORKBENCH_INPUT_FORMAT = "aih-workbench-input";
export const WORKBENCH_INPUT_VERSION = 1;

export type WorkbenchInputDoor = "admin" | "user" | "chooser";

export interface WorkbenchInputV1 {
  readonly format: typeof WORKBENCH_INPUT_FORMAT;
  readonly version: 1;
  readonly door: WorkbenchInputDoor;
  /** The page model. Validated by the engine on use, never trusted here. */
  readonly model: unknown;
}

const INPUT_KEYS = ["format", "version", "door", "model"] as const;
const DOORS: readonly WorkbenchInputDoor[] = ["admin", "user", "chooser"];

function isDoor(value: unknown): value is WorkbenchInputDoor {
  return typeof value === "string" && DOORS.includes(value as WorkbenchInputDoor);
}

/** Strict: exact keys, exact format, version exactly 1, a known door, a plain model. */
export function parseWorkbenchInput(value: unknown): EngineResult<WorkbenchInputV1> {
  const input = record(value);
  if (input === undefined) {
    return { ok: false, errors: ["The page input is not a JSON object."] };
  }
  const keys = Object.keys(input).sort();
  const expected = [...INPUT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return {
      ok: false,
      errors: [`The page input must have exactly the keys ${expected.join(", ")}.`],
    };
  }
  if (input.format !== WORKBENCH_INPUT_FORMAT) {
    return {
      ok: false,
      errors: [`The page input is not ${WORKBENCH_INPUT_FORMAT}.`],
    };
  }
  if (input.version !== WORKBENCH_INPUT_VERSION) {
    return {
      ok: false,
      errors: [
        `The page input is version ${JSON.stringify(input.version)}. This page supports version ${WORKBENCH_INPUT_VERSION}.`,
      ],
    };
  }
  if (!isDoor(input.door)) {
    return {
      ok: false,
      errors: [`The page input door must be one of ${DOORS.join(", ")}.`],
    };
  }
  if (record(input.model) === undefined) {
    return { ok: false, errors: ["The page input model is not a JSON object."] };
  }
  return {
    ok: true,
    value: {
      format: WORKBENCH_INPUT_FORMAT,
      version: WORKBENCH_INPUT_VERSION,
      door: input.door,
      model: input.model,
    },
  };
}
