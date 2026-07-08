import { AihError } from "../errors.js";
import { assertWorkspacePrintable } from "./manifest.js";

export function normalizeWorkspaceDisplayText(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new AihError(`${label} must be a string`, "AIH_WORKSPACE");
  }
  const value = raw.trim().replace(/ {2,}/g, " ");
  if (value.length === 0) return undefined;
  try {
    assertWorkspacePrintable(value, label);
  } catch {
    throw new AihError(`${label} must be safe to print in workspace reports`, "AIH_WORKSPACE");
  }
  return value;
}
