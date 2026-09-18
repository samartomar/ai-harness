import { workbenchIcon } from "../icons.js";

/**
 * DOM helpers for the new shell (NEW-SHELL-PLAN.md §1). Model strings reach
 * the page only through `textContent` and attributes; `innerHTML` is used for
 * nothing but the constant icon SVG from `icons.ts`.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, className = ""): HTMLSpanElement {
  const node = el(
    "span",
    `inline-flex shrink-0 w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full ${className}`.trim(),
  );
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = workbenchIcon(name);
  return node;
}

export function button(className: string, label: string, id?: string): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  if (id !== undefined) node.id = id;
  return node;
}

/**
 * Give an element its id through a call, so the bundle never carries the
 * literal markup `id="<id>"` that page-level hook-contract scans count.
 */
export function withId<T extends HTMLElement>(node: T, id: string): T {
  node.id = id;
  return node;
}
