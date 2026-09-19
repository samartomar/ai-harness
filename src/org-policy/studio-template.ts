import { EVIDENCE_DELIVERY_NOTE, evidenceDeliveryRows } from "./evidence-delivery-rows.js";
import { customMcpFormsMarkup } from "./studio-custom-mcp.js";
import type { PolicyStudioModel } from "./studio-model.js";
import { protectedPolicyWorkbenchMarkup } from "./studio-protected-authority.js";
import { loadWorkbenchBrowserScript } from "./workbench/browser-script.js";
import { loadWorkbenchCss } from "./workbench/css.js";
import { workbenchIcon } from "./workbench/ui/icons.js";

/**
 * Escape the model for embedding inside an inline script. Angle brackets go to
 * unicode escapes so no model string can close the tag. This is only half the
 * job: the caller must also splice it in through a FUNCTION replacer, or
 * String.replace interprets `$'`, `$&`, `$\`` and `$$` in these bytes and
 * copies the template's own tail into the page.
 */
function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function safeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

/**
 * The one catalog line the workbench shows: verified tier, source, and age.
 * Absent entirely when no administrator catalog was resolved, so the portable
 * authoring artifact is unchanged. Locators, paths, tokens, signatures, raw
 * attestations, signer identities, and roots are not representable here — the
 * model carries none of them.
 */
function catalogProvenanceLine(model: PolicyStudioModel): string {
  const provenance = model.catalogProvenance;
  if (provenance === undefined) return "";
  const age =
    provenance.ageSeconds === null
      ? "packaged fallback (no download age)"
      : `${String(provenance.ageSeconds)}s since download`;
  const detail = [
    `Supported catalog · verified ${provenance.tier}`,
    `source ${provenance.sourceId} (${provenance.channel})`,
    `resolved ${provenance.resolvedAt}`,
    age,
    `bootstrap ${provenance.bootstrapProvenance}`,
  ].join(" · ");
  return `\n  <p class="help" id="catalog-provenance">${safeHtmlAttribute(detail)}</p>`;
}
function baselineEvidenceProvenanceLine(model: PolicyStudioModel): string {
  const provenance = model.baselineEvidenceProvenance;
  if (provenance === undefined) return "";
  const age =
    provenance.ageSeconds === null ? "packaged fallback" : `${String(provenance.ageSeconds)}s`;
  return `\n  <p class="help" id="baseline-evidence-provenance">${safeHtmlAttribute([`Baseline evidence · ${provenance.tier}`, `sources ${provenance.sourceIds.join(",")}`, `schema ${String(provenance.schemaVersion)}`, `digest ${provenance.digest}`, `age ${age}`, `resolved ${provenance.resolvedAt}`].join(" · "))}</p>`;
}

/** Portable, dependency-free policy authoring surface. */
/**
 * The user door (P5b). Static markup only: the browser bundle renders the
 * trim list from the model, writing every model-derived string as text.
 */
function userDoorHtml(model: PolicyStudioModel): string {
  const workbenchBrowserScript = loadWorkbenchBrowserScript();
  const workbenchCss = loadWorkbenchCss();
  return String.raw`<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIH Project Selection</title>
<link rel="icon" href="data:,">
<style>
*,*::before,*::after{box-sizing:border-box}
html[data-theme="light"]{color-scheme:light}
html[data-theme="dark"]{color-scheme:dark}
body{margin:0;min-height:100vh;font:400 13px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,p{margin:0}
button,input,select{font:inherit}
button{cursor:pointer;border:0;background:none;color:inherit}
[hidden]{display:none!important}
*:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:3px}
</style>
<style id="wb-styles">${workbenchCss}</style>
</head>
<body class="bg-background text-on-surface flex flex-col">
<header class="wb-header flex flex-wrap items-center gap-2.5 min-h-14 px-3 py-2 border-0 border-b border-solid border-outline-variant bg-surface-container-lowest text-on-surface" aria-label="Project selection toolbar">
  <span class="flex items-center gap-2 min-w-0">
    <span class="w-6 h-6 rounded bg-primary text-on-primary grid place-items-center shrink-0 [&>svg]:w-4 [&>svg]:h-4" aria-hidden="true">${workbenchIcon("shield_with_house")}</span>
    <h1 class="font-semibold text-[13px] tracking-tight text-on-surface">Project selection</h1>
    <span class="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium">User</span>
  </span>
  <span class="flex-1"></span>
  <button type="button" class="p-1.5 rounded bg-surface-container-low hover:bg-surface-container border border-solid border-outline-variant text-on-surface-variant hover:text-on-surface transition-colors shrink-0 w-8 h-8 grid place-items-center [&>svg]:w-4 [&>svg]:h-4" id="theme-toggle" aria-label="Switch to dark theme" title="Switch to dark theme">${workbenchIcon("dark_mode")}</button>
</header>
<main id="user-door" class="user-door flex-1" tabindex="-1"></main>
<script>window.__aihWorkbenchModel=__AIH_DATA__;</script>
<script>${workbenchBrowserScript}</script>
</body>
</html>`.replace("__AIH_DATA__", () => safeScriptJson(model));
}

/**
 * S6: the organization screen's "Evidence & versions" rows, computed here as
 * for the legacy page and embedded as inert JSON data (never executed), so
 * the page carries them only when the model has evidence delivery.
 */
function newShellEvidenceDelivery(model: PolicyStudioModel): string {
  const rows = evidenceDeliveryRows(model);
  const delivery = model.evidenceDelivery;
  if (rows === undefined || delivery === undefined) return "";
  return `
<script type="application/json" id="wb-evidence-delivery">${safeScriptJson({ coreVersion: delivery.coreVersion, rows, note: EVIDENCE_DELIVERY_NOTE })}</script>`;
}

/**
 * The catalog and baseline evidence provenance lines, escaped here exactly as
 * the legacy page did, as inert markup the shell clones into its provenance
 * strip. Absent when the model has neither.
 */
function newShellProvenance(model: PolicyStudioModel): string {
  const lines = `${catalogProvenanceLine(model)}${baselineEvidenceProvenanceLine(model)}`;
  return lines === ""
    ? ""
    : `
<template id="wb-provenance">${lines}
</template>`;
}

/**
 * The new admin shell (NEW-SHELL-PLAN.md S1). Head, one root and the model:
 * the browser bundle builds every element, writing model strings as text.
 */
function newShellHtml(model: PolicyStudioModel): string {
  const workbenchBrowserScript = loadWorkbenchBrowserScript();
  const workbenchCss = loadWorkbenchCss();
  return String.raw`<!doctype html>
<html lang="en" data-theme="light" data-wb-shell="new">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIH Policy Workbench</title>
<link rel="icon" href="data:,">
<style id="wb-styles">${workbenchCss}</style>
</head>
<body>
<a class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[999] focus:p-2 focus:rounded focus:border focus:border-solid focus:border-outline-variant focus:bg-surface-container-lowest focus:text-on-surface" href="#wb-main">Skip to policy workbench</a>
<div id="wb-root" data-wb-shell="new"></div>
<template id="wb-protected-policy">${protectedPolicyWorkbenchMarkup()}</template>
<template id="wb-custom-mcp">${customMcpFormsMarkup()}</template>${newShellProvenance(model)}
<script>window.__aihWorkbenchModel=__AIH_DATA__;</script>${newShellEvidenceDelivery(model)}
<script>${workbenchBrowserScript}</script>
</body>
</html>`.replace("__AIH_DATA__", () => safeScriptJson(model));
}

export function policyStudioHtml(model: PolicyStudioModel): string {
  if (model.door === "user") return userDoorHtml(model);
  return newShellHtml(model);
}
