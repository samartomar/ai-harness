/**
 * Shared happy-dom harness for the Workbench shell parity tests: the legacy
 * characterization (legacy-download-characterization.test.ts) and the new
 * shell's byte-compatibility checks (new-shell-download-compat.test.ts) drive
 * the same page hooks with the same inputs.
 */
import { TextEncoder } from "node:util";
import { Window } from "happy-dom";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const windows = new Set<Window>();
export const sha = (character: string) => `sha256:${character.repeat(64)}`;

export async function closeStudios(): Promise<void> {
  await Promise.all([...windows].map((window) => window.happyDOM.close()));
  windows.clear();
}

export interface Download {
  name: string;
  text: string;
}

export interface Studio {
  window: Window;
  downloads: Download[];
}

export function studio(
  model: PolicyStudioModel = tinyStudioModel(),
  pageUrl = "http://localhost/",
): Studio {
  const window = new Window({ url: pageUrl });
  windows.add(window);
  const html = policyStudioHtml(model);
  window.document.write(html);
  Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
  Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const downloads: Download[] = [];
  const blobs = new Map<string, Blob>();
  let next = 0;
  const url = window.URL as unknown as {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(value: string): void;
  };
  url.createObjectURL = (blob: Blob) => {
    next += 1;
    const key = `blob:characterization-${next}`;
    blobs.set(key, blob);
    return key;
  };
  url.revokeObjectURL = () => undefined;
  const anchorPrototype = Object.getPrototypeOf(window.document.createElement("a")) as {
    click: () => void;
  };
  anchorPrototype.click = function (this: { download: string; href: string }): void {
    const blob = blobs.get(this.href);
    if (blob === undefined) return;
    const entry: Download = { name: this.download, text: "" };
    downloads.push(entry);
    pendingReads.push(
      blob.text().then((text) => {
        entry.text = text;
      }),
    );
  };
  const pendingReads: Promise<void>[] = [];
  (window as unknown as { __characterizationReads: Promise<void>[] }).__characterizationReads =
    pendingReads;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return { window, downloads };
}

export async function drained(studio: Studio): Promise<Download[]> {
  const reads = (studio.window as unknown as { __characterizationReads: Promise<void>[] })
    .__characterizationReads;
  await Promise.all(reads);
  return studio.downloads;
}

export function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

export function click(window: Window, id: string): void {
  const node = window.document.getElementById(id);
  if (node === null) throw new Error(`expected #${id}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

export function setValue(window: Window, id: string, entry: string): void {
  const node = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (node === null) throw new Error(`expected #${id}`);
  node.value = entry;
  node.dispatchEvent(new window.Event("input", { bubbles: true }));
  node.dispatchEvent(new window.Event("change", { bubbles: true }));
}

export function preview(window: Window): string {
  const node = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (node === null) throw new Error("expected #config-preview");
  return node.value;
}

export async function settle(window: Window, done: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the Workbench announcement");
}

export async function importFile(window: Window, inputId: string, text: string): Promise<string> {
  const input = window.document.getElementById(inputId);
  if (input === null) throw new Error(`expected #${inputId}`);
  const live = window.document.getElementById("announcement");
  if (live !== null) live.textContent = "";
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new window.File([text], "import.json", { type: "application/json" })],
  });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(window, () => announcement(window) !== "");
  return announcement(window);
}

// The policy fixtures have no DOM; pure tests import them from their own module.
export * from "./policy-fixtures.js";
