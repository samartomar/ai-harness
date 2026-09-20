import {
  parseWorkbenchInput,
  type WorkbenchInputV1,
} from "../../src/org-policy/workbench/engine/index.js";

/** What both production hosts do the same way: digest, download, read the input. */

/** SHA-256, lower-case hex, of exactly these bytes. Never of re-serialized JSON. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hand a finished file to the person, offline, as a download. */
export function save(file: { readonly name: string; readonly text: string }): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}

/** The engine's message, rendered as text. Never as markup, whatever it says. */
export function showInputFailure(target: Document, message: string): undefined {
  const root = target.getElementById("root");
  if (root !== null) root.textContent = message;
  return undefined;
}

/**
 * The embedded input of the offline file: one JSON script element, parsed and
 * then checked against the versioned contract. Any failure renders the
 * engine's message as text and mounts nothing.
 */
export function readEmbeddedInput(target: Document): WorkbenchInputV1 | undefined {
  const element = target.getElementById("aih-workbench-input");
  if (element === null) {
    return showInputFailure(target, "This page carries no Workbench input.");
  }
  let value: unknown;
  try {
    value = JSON.parse(element.textContent ?? "");
  } catch {
    return showInputFailure(target, "The Workbench input on this page is not strict JSON.");
  }
  const parsed = parseWorkbenchInput(value);
  if (!parsed.ok) return showInputFailure(target, parsed.errors.join(" "));
  return parsed.value;
}
