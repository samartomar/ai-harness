import type { PolicyStudioModel } from "./studio-model.js";
import { protectedPolicyWorkbenchMarkup } from "./studio-protected-authority.js";
import { loadWorkbenchBrowserScript } from "./workbench/browser-script.js";

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
    `Supported catalog — verified ${provenance.tier}`,
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
  return `\n  <p class="help" id="baseline-evidence-provenance">${safeHtmlAttribute([`Baseline evidence — ${provenance.tier}`, `sources ${provenance.sourceIds.join(",")}`, `schema ${String(provenance.schemaVersion)}`, `digest ${provenance.digest}`, `age ${age}`, `resolved ${provenance.resolvedAt}`].join(" · "))}</p>`;
}

/** Portable, dependency-free policy authoring surface. */
export function policyStudioHtml(model: PolicyStudioModel): string {
  const catalogProvenance = catalogProvenanceLine(model);
  const baselineEvidenceProvenance = baselineEvidenceProvenanceLine(model);
  const workbenchBrowserScript = loadWorkbenchBrowserScript();
  const workbenchModel = model;
  const protectedPolicyMarkup = protectedPolicyWorkbenchMarkup();
  return String.raw`<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIH Policy Workbench</title>
<link rel="icon" href="data:,">
<style>
:root{--motion:120ms ease-out;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
--sans:"Manrope","Segoe UI Variable","Segoe UI",system-ui,sans-serif;
--display:"EB Garamond",Georgia,"Times New Roman",serif;
--cap:10.5px;--meta:11.5px;--body:13px;--title:16px;--mast:18px;--barh:64px}
html[data-theme="light"]{color-scheme:light;
--paper:#fcfcfa;--surface:#fff;--rule:#d9dbd6;--rule-soft:#ecece8;--fill:#f7f7f4;--fill-2:#e3e4df;--fill-hover:#f0f0ec;
--ink:#16181d;--ink-2:#3d4047;--ink-3:#6a6d74;
--pass:#1a6b45;--blocked:#a3232b;--owed:#8a6d1c;
--pass-soft:#e8f3ec;--owed-soft:#f5f0dd;--blocked-soft:#faeced;--on-accent:#fcfcfa;
--s-sel:#16181d;--s-req:#16181d;--s-wait:#8a6d1c;--s-blk:#a3232b;--s-uns:#8b8e86;--s-avail:#e3e4df;
--scrim:rgba(22,24,29,.28)}
html[data-theme="dark"]{color-scheme:dark;
--paper:#1d1f23;--surface:#25282d;--rule:#4b4e54;--rule-soft:#373a40;--fill:#2d3036;--fill-2:#3a3d44;--fill-hover:#34373d;
--ink:#f5f5ef;--ink-2:#d7d8d2;--ink-3:#a7aaa4;
--pass:#8ed3aa;--blocked:#f08c94;--owed:#d8be73;
--pass-soft:#223b2c;--owed-soft:#3f3820;--blocked-soft:#452d32;--on-accent:#1d1f23;
--s-sel:#f5f5ef;--s-req:#f5f5ef;--s-wait:#d8be73;--s-blk:#f08c94;--s-uns:#a9aca5;--s-avail:#3a3d44;
--scrim:rgba(0,0,0,.45)}
*,*::before,*::after{box-sizing:border-box}
html{min-height:100%}
body{margin:0;min-height:100vh;min-height:100dvh;font:400 var(--body)/1.5 var(--sans);color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
h1,h2,h3,p{margin:0}
button{font-family:inherit;color:inherit;cursor:pointer;border:0;background:none}
code{font-family:var(--mono)}
input,select,textarea{font:inherit}
a{color:var(--ink);text-underline-offset:3px}
a:hover{color:var(--ink-2)}
[hidden]{display:none!important}
*:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
.sr,.badge,#status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px}
.skip:focus{left:.75rem;top:.75rem;z-index:999;background:var(--surface);padding:.5rem;border:1px solid var(--rule);border-radius:3px}
.hidden{display:none}
.field{display:none}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:var(--fill-2);border-radius:0}
.stage{min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto auto 1fr auto}
#side{grid-column:1;grid-row:1/-1;position:sticky;top:0;align-self:start;z-index:60;width:250px;border-right:1px solid var(--rule);background:var(--surface);padding:12px 10px;display:flex;flex-direction:column;gap:10px;transition:width var(--motion)}
body[data-rail="off"] #side{width:58px;padding:12px 7px}
.bar,.announce,.ticker,.work,.ledger{grid-column:2}
.sidehead{display:flex;align-items:center;gap:8px}
.sidehead .brand{flex:1;min-width:0}
#rail-toggle{width:24px;height:24px;border:1px solid var(--rule);border-radius:3px;color:var(--ink-3);display:grid;place-items:center;font-size:var(--body);flex:0 0 auto}
#rail-toggle:hover{color:var(--ink);background:var(--fill)}
.pi{width:18px;height:18px;display:grid;place-items:center;flex:0 0 auto;color:var(--ink-3);font-style:normal}
.pi svg{display:block}
.pop-row:hover .pi,.pop-row[aria-expanded="true"] .pi{color:var(--ink)}
.seek .ico{font-style:normal;font-size:var(--body);display:grid;place-items:center;flex:0 0 auto}
.pop-row.rowcap{margin-top:2px}
.pop-row.rowcap .pl{font:600 var(--cap)/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase}
.pop-row.rowcap .selcount{letter-spacing:0}
.brow .btn .lbl2{white-space:nowrap}
body[data-rail="off"] #side .brand-name,body[data-rail="off"] #side .seek .lbl2,body[data-rail="off"] #side .seek kbd,body[data-rail="off"] #side .cap,body[data-rail="off"] #side .pop-row .pl,body[data-rail="off"] #side .pop-row .selcount,body[data-rail="off"] #side .pop-row .pc,body[data-rail="off"] #side .brow .btn .lbl2{display:none}
body[data-rail="off"] #side .pop-row,body[data-rail="off"] #side .brow .btn{justify-content:center;padding:0}
body[data-rail="off"] #side .seek{min-width:0;justify-content:center;padding:0}
body[data-rail="off"] .sidehead{justify-content:center}
body[data-rail="off"] .sidehead .brand{display:none}
/* header: sticky, single page scroll below it */
.bar{position:sticky;top:0;z-index:120;display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:2px solid var(--ink);flex-wrap:wrap;background:var(--paper)}
.github-link{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink-2);text-decoration:none;flex:0 0 auto}
.github-link:hover{background:var(--fill-hover);color:var(--ink)}
.github-link svg{width:17px;height:17px;display:block}
.brand{display:flex;align-items:center;gap:9px;min-width:0}
.brand-mark{width:24px;height:24px;border-radius:4px;display:grid;place-items:center;flex:0 0 auto;background:var(--ink);color:var(--paper)}
.brand-mark svg{width:14px;height:14px}
.brand-name{font:700 var(--mast)/1.2 var(--display);letter-spacing:.01em;white-space:nowrap}
.brand-name span{display:none}
.tabs{display:flex;gap:2px;margin-left:10px}
.tabs button{height:32px;padding:0 13px;font:600 var(--meta)/1 var(--sans);color:var(--ink-3);border-radius:3px;transition:color var(--motion),background var(--motion)}
.tabs button:hover{color:var(--ink);background:var(--fill)}
.tabs button[aria-pressed="true"]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--ink);border-radius:3px 3px 0 0}
#side .sect{padding:6px 2px}
#side .brow{display:grid;gap:2px}
#side .brow .btn{justify-content:flex-start;gap:8px;border:0;background:transparent;color:var(--ink-3);height:32px;padding:0 8px}
#side .brow .btn:hover{background:var(--fill);color:var(--ink)}
.bar .sp{flex:1}
.seek{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px 0 11px;border-radius:3px;border:1px solid var(--rule);background:var(--surface);color:var(--ink-3);font-size:var(--meta);min-width:170px;transition:border-color var(--motion)}
.seek:hover{border-color:var(--ink)}
kbd{font:500 var(--cap)/1 var(--mono);background:var(--fill-2);border-radius:3px;padding:3px 5px}
.seek kbd{margin-left:auto}
.btn{height:30px;padding:0 12px;border-radius:3px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);font-weight:600;font-size:var(--meta);display:inline-flex;align-items:center;gap:6px;transition:background var(--motion),color var(--motion)}
.btn:hover{background:var(--fill-hover)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.btn.primary:hover{background:var(--ink);opacity:.88}
.btn.danger{color:var(--blocked);border-color:var(--blocked)}
.btn.sm{height:28px;padding:0 10px}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.pill{display:inline-flex;gap:2px;padding:2px;border-radius:3px;border:1px solid var(--rule);background:var(--surface)}
.pill button{height:24px;min-width:44px;padding:0 10px;border-radius:2px;color:var(--ink-3);font-weight:600;font-size:var(--meta)}
.pill button[aria-pressed="true"]{color:var(--ink);background:var(--fill-2)}
.announce{min-height:22px;padding:4px 16px 0;font-size:var(--meta);color:var(--ink-2);pointer-events:none}
.announce.error{color:var(--blocked)}
.ticker{display:flex;align-items:center;padding:6px 16px 0;flex-wrap:wrap}
.ticker button{height:26px;padding:0 12px;border:0;color:var(--ink-3);font:600 var(--meta)/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;display:inline-flex;align-items:center;gap:6px;transition:color var(--motion)}
.ticker button~button{border-left:1px solid var(--rule)}
.ticker button:hover{color:var(--ink)}
.ticker button[aria-pressed="true"]{color:var(--ink);text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:2px}
.ticker button b{font-family:var(--mono);font-weight:700}
.ticker [data-empty="true"]{opacity:.5}
.ticker .sep{display:none}
.ticker .soon{font:600 var(--cap)/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);opacity:.7;margin-left:auto}
/* layout: one document scroll, sticky rail */
.work{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:8px 16px 12px;align-items:start}
body[data-view="compose"] #panel-artifacts,body[data-view="compose"] #panel-author,body[data-view="compose"] #panel-imports{display:none}
body[data-view="artifacts"] .ticker,body[data-view="artifacts"] .plane:not(.pane),body[data-view="artifacts"] #panel-author,body[data-view="artifacts"] #panel-imports{display:none}
body[data-view="author"] .ticker,body[data-view="author"] .plane:not(.pane),body[data-view="author"] #panel-artifacts,body[data-view="author"] #panel-imports{display:none}
body[data-view="imports"] .ticker,body[data-view="imports"] .plane:not(.pane),body[data-view="imports"] #panel-artifacts,body[data-view="imports"] #panel-author{display:none}
.plane .ticker{padding:0 10px 2px}
.gcard{border:1px solid var(--rule);border-radius:4px;background:var(--surface)}
.rail{display:grid;gap:2px;align-content:start;padding:0}
#side .gcard{border:0;background:transparent;border-radius:0}
.sect{padding:10px 12px;display:grid;gap:8px}
.cap{font:600 var(--cap)/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);display:flex;align-items:center;gap:7px}
.cap .end{margin-left:auto;letter-spacing:0;text-transform:none;font-family:var(--sans);color:var(--ink)}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:3px;border:1px solid var(--rule);background:var(--surface);color:var(--ink-2);font-size:var(--meta);font-weight:600;transition:background var(--motion),color var(--motion)}
.chip:hover{background:var(--fill);color:var(--ink)}
.chip[aria-pressed="true"]{background:var(--fill-hover);color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.chip[aria-disabled="true"]{opacity:.55;cursor:default}
/* plane / panes */
.plane{display:flex;flex-direction:column;gap:8px;padding:2px;min-width:0}
.plane>*{flex:0 0 auto}
.pane{max-width:1060px;width:100%;margin:0 auto}
#framework-rows{display:contents}
.workbench-catalog-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.workbench-catalog-filters label{display:flex;align-items:center;gap:5px;color:var(--ink-2);font:600 var(--cap)/1 var(--sans)}
.workbench-catalog-filters select{max-width:min(100%,28rem)}
.workbench-methodology-badge{display:inline-flex;align-items:center;width:max-content;padding:3px 6px;border:1px solid var(--rule);border-radius:3px;color:var(--ink-2);background:var(--fill);font:600 var(--cap)/1.25 var(--sans)}
.workbench-inventory-rows{display:grid;gap:0}
.workbench-inventory-rows article{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--rule)}
.workbench-inventory-rows article>span:first-child{grid-column:1/-1;font-weight:700;overflow-wrap:anywhere}
.workbench-inventory-rows [data-workbench-row-detail]{grid-column:1/-1;color:var(--ink-2);overflow-wrap:anywhere}
.workbench-inventory-rows .workbench-methodology-badge{grid-column:1/-1}
.workbench-inventory-rows article>button{margin-top:2px}
.plane:not(.pane) .ticker{order:-2}
.plane:not(.pane) .planetop{order:-1}
.planetop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;position:sticky;top:var(--barh);z-index:40}
.planetop .sp{flex:1}
.planetop .n{font:500 var(--meta)/1 var(--mono);color:var(--ink-3)}
.planetop .n b{color:var(--ink);font-weight:600}
.f{height:24px;padding:0 10px;border-radius:3px;border:1px solid var(--rule);background:var(--surface);color:var(--ink-2);font-size:var(--meta);font-weight:600;display:inline-flex;align-items:center;gap:5px;transition:background var(--motion),color var(--motion)}
.f:hover{color:var(--ink);background:var(--fill)}
.f[aria-pressed="true"]{background:var(--fill-hover);color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.f[data-empty="true"]{opacity:.55}
.f b{font-family:var(--mono);font-weight:700}
#plane-empty{padding:14px;color:var(--ink-2);font-size:var(--meta)}
/* groups */
.grp{position:relative}
.grphead{border-radius:4px 4px 0 0}
.grp[data-open="0"] .grphead{border-radius:4px}
.grphead{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;text-align:left;background:var(--fill);transition:background var(--motion)}
.grphead:hover{background:var(--fill-hover)}
.grp[data-open="1"] .grphead{border-bottom:1px solid var(--rule)}
section.grp.has-tip>.grphead{padding-right:44px}
.tip-wrap.grp-tip{position:absolute;top:6px;right:10px;z-index:2;margin:0}
.grphead .tw{width:10px;color:var(--ink-3);font-size:9px;transition:transform var(--motion);flex:0 0 auto}
.grp[data-open="1"] .grphead .tw{transform:rotate(90deg)}
.grphead h2{font:600 12.5px/1.3 var(--sans);letter-spacing:.01em;white-space:nowrap}
.grphead h2.concept-heading{display:inline-flex;align-items:center;gap:7px}
.concept-icon{width:17px;height:17px;display:inline-grid;place-items:center;color:var(--ink-2);flex:0 0 auto}
.concept-icon svg{width:17px;height:17px;display:block}
.grphead .own{font:500 var(--cap)/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.grphead .ct{font:500 var(--meta)/1 var(--mono);color:var(--ink-3);margin-left:auto;flex:0 0 auto}
.meter{display:flex;height:6px;width:96px;overflow:hidden;background:var(--rule-soft);box-shadow:inset 0 0 0 1px var(--rule);flex:0 0 auto}
.meter[hidden]{display:none}
.meter i{display:block;height:100%}
.meter i[data-s="requested"]{background:var(--s-sel)}
.grp[data-open="0"] .grpbody{display:none}
.grpbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:0 18px;padding:2px 12px 10px}
.grpbody.stack{grid-template-columns:minmax(0,1fr)}
.grpbody h3{font:600 var(--meta)/1.4 var(--sans);padding-top:10px}
.mcp-catalog-subgroup{grid-column:1/-1}
.mcp-catalog-subgroup h3{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mcp-catalog-rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:0 18px}
.subcount{font:500 var(--micro)/1 var(--mono);color:var(--ink-3)}
.grpnote{padding:8px 12px 10px;font-size:var(--meta);color:var(--ink-3);line-height:1.5;max-width:88ch;border-top:1px solid var(--rule-soft)}
.grpnote code,.grpnote b{color:var(--ink-2)}
p.gcard.grpnote,section.gcard>.grpnote:first-child{border-top:0}
/* rows */
.row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;align-items:center;gap:8px;min-height:32px;padding:2px 4px;border-bottom:1px solid var(--rule-soft);transition:background var(--motion)}
.row:last-child{border-bottom:0}
.row:hover,.row.on{background:var(--fill)}
.row.evidence-linked{outline:1px solid var(--ink);outline-offset:1px;background:var(--fill)}
.row[data-vetted="blocked"]{box-shadow:inset 3px 0 0 var(--blocked)}
.rid{font:400 var(--meta)/1.3 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2);text-align:left;min-width:0;padding:5px 0}
.row.on .rid{color:var(--ink)}
.rid strong{font-weight:400}
.source-mark{display:inline-flex;margin-left:7px;padding:2px 5px;border:1px solid var(--rule);border-radius:3px;color:var(--ink-3);font:600 var(--micro)/1 var(--sans);letter-spacing:.01em;vertical-align:middle}
.rid u{text-decoration:none;color:var(--ink-3)}
.row[data-vetted="blocked"] .rid strong{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;text-decoration-color:var(--blocked)}
.tick{width:20px;height:20px;border-radius:3px;border:1.5px solid var(--rule);background:var(--surface);display:grid;place-items:center;font-size:var(--cap);color:transparent;flex:0 0 auto;transition:background var(--motion),color var(--motion)}
.row.on .tick{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.vet{font:400 var(--cap)/1 var(--mono);flex:0 0 auto;padding:4px 5px;border-radius:3px;white-space:nowrap}
.vet[data-vet="pass"]{color:var(--pass)}
.vet[data-vet="blocked"]{color:var(--blocked);border:1px solid var(--blocked);background:var(--blocked-soft)}
.row-state{display:inline-flex;align-items:center;min-height:22px;padding:0 7px;border:1px solid var(--rule);border-radius:3px;color:var(--ink-2);background:var(--surface);font:600 var(--cap)/1 var(--sans);white-space:nowrap}
.row[data-state="requested"] .row-state{color:var(--pass);border-color:var(--pass)}
.row[data-state="pending"] .row-state,.row[data-state="approval"] .row-state{color:var(--owed);border-color:var(--owed)}
.row[data-state="blocked"] .row-state{color:var(--blocked);border-color:var(--blocked)}
.more{height:24px;padding:0 7px;border-radius:3px;color:var(--ink-3);font:600 var(--cap)/1 var(--sans);display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background var(--motion),color var(--motion)}
.more:hover{color:var(--ink);background:var(--fill-2)}
.row-slot{grid-column:1/-1}
.row-slot:empty{display:none}
.row-actions{grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap;padding:2px 0 6px}
.row-actions button,[data-protected-remove],[data-protected-revoke]{height:24px;padding:0 9px;border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink-2);font-size:var(--cap);font-weight:600}
.row-actions button:hover,[data-protected-remove]:hover,[data-protected-revoke]:hover{background:var(--fill-hover);color:var(--ink)}
.row-details{grid-column:1/-1;margin:0}
.receipt-record{white-space:pre-wrap;max-width:100%;max-height:20rem;overflow:auto}
/* misc content */
.adoption-recipe{padding:12px}
.adoption-recipe h2{font-size:var(--body);font-family:var(--display);font-weight:700}
.adoption-role{padding:9px 0;border-top:1px solid var(--rule-soft)}
.adoption-role p,.hookreg p{margin:3px 0}
.adoption-route{color:var(--ink-3);font-size:var(--meta)}
.hookreg{padding:6px 0;border-top:1px solid var(--rule-soft)}
.hookreg:first-child{border-top:0}
.help{color:var(--ink-3);font-size:var(--meta);line-height:1.5;max-width:88ch}
.mono{font-family:var(--mono);font-size:var(--cap);overflow-wrap:anywhere;color:var(--ink-2)}
.error{color:var(--blocked)}
.badges{display:flex;gap:5px;flex-wrap:wrap}
.b{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:3px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);font:600 var(--cap)/1 var(--sans)}
.b.ok{color:var(--pass);border-color:var(--pass)}
.b.warn{color:var(--owed);border-color:var(--owed)}
.b.bad{color:var(--blocked);border-color:var(--blocked)}
.b.ext{border-color:var(--ink)}
.kv{display:grid;grid-template-columns:minmax(0,1fr);min-width:0}
.kv div{display:flex;justify-content:space-between;gap:14px;min-width:0;max-width:100%;padding:7px 0;border-bottom:1px solid var(--rule-soft);align-items:baseline}
.kv div:last-child{border-bottom:0}
.kv span{color:var(--ink-3);font-size:var(--cap);letter-spacing:.06em;text-transform:uppercase;flex:0 0 auto}
.kv b{font:500 var(--meta)/1.45 var(--mono);text-align:right;min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
.scroll-code{display:block;max-width:100%;overflow-x:auto;white-space:nowrap;overscroll-behavior-inline:contain;padding-bottom:2px}
.note{font-size:var(--meta);line-height:1.55;color:var(--ink-2);border-left:2px solid var(--ink);padding-left:9px}
.note.bad{border-left-color:var(--blocked)}
.note.ok{border-left-color:var(--pass)}
.note b{color:var(--ink);font-weight:600}
.journey,.journey-effective{margin:6px 0;padding:8px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);font:600 var(--meta)/1.45 var(--mono);letter-spacing:.04em;overflow-wrap:anywhere}
.journey-effective{font-weight:400;letter-spacing:0;color:var(--ink-2)}
.cmdline{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;min-width:0;max-width:100%;overflow:hidden;border:1px solid var(--rule);border-radius:3px;background:var(--fill);padding:8px 10px}
.cmdline code{display:block;width:100%;min-width:0;overflow-x:auto;overscroll-behavior-inline:contain;white-space:pre;color:var(--ink);font-size:var(--meta)}
.component-status{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.component-status .b{justify-self:start;height:26px;padding-inline:10px}
.component-status p{font-size:var(--meta);line-height:1.5;color:var(--ink-2);text-wrap:pretty}
.drawer-section{display:grid;gap:7px;min-width:0}
.source-definitions{border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.source-definitions>summary{min-height:38px;padding:7px 10px;background:var(--fill);list-style:none;gap:7px}
.source-definitions>summary::-webkit-details-marker{display:none}
.source-definitions>summary::before{content:"\25B8";font-size:9px;color:var(--ink-3);transition:transform var(--motion)}
.source-definitions[open]>summary::before{transform:rotate(90deg)}
.source-path-list{display:grid;gap:0;max-height:260px;overflow:auto;padding:4px 10px 8px;border-top:1px solid var(--rule)}
.source-path-list li{min-width:0;padding:6px 0;border-bottom:1px solid var(--rule-soft);list-style:none}
.source-path-list li:last-child{border-bottom:0}
.source-path-list code{display:block;max-width:100%;overflow-x:auto;white-space:nowrap}
.security-audit{border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.security-audit>summary{min-height:38px;padding:7px 10px;background:var(--fill);list-style:none;gap:7px}
.security-audit>summary::-webkit-details-marker{display:none}
.security-audit>summary::before{content:"\25B8";font-size:9px;color:var(--ink-3);transition:transform var(--motion)}
.security-audit[open]>summary::before{transform:rotate(90deg)}
.security-body{display:grid;grid-template-columns:minmax(0,1fr);gap:11px;min-width:0;padding:11px;border-top:1px solid var(--rule)}
.security-body>*{min-width:0;max-width:100%}
.copy{height:28px;border:1px solid var(--ink);border-radius:3px;background:var(--surface);color:var(--ink);font:700 var(--cap)/1 var(--sans);letter-spacing:.06em;padding:0 10px}
.copy:hover{background:var(--fill-hover)}
.brow{display:flex;gap:6px;flex-wrap:wrap}
/* forms */
.dform{display:grid;gap:8px}
.dform label,.form-grid label{display:grid;gap:3px;color:var(--ink-3);font-size:var(--meta)}
legend{color:var(--ink-3);font-size:var(--meta)}
fieldset>legend{display:inline-flex;align-items:center;gap:2px}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dform input,.dform select,.form-grid input,.form-grid select{border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink);font:400 12px/1.4 var(--sans);padding:0 9px;height:30px;width:100%}
.dform input:focus,.form-grid input:focus{border-color:var(--ink);outline:none}
fieldset{border:1px solid var(--rule);border-radius:4px;margin:0;padding:12px}
legend{padding:0 5px}
legend .tip-wrap{margin-left:.35rem}
[aria-invalid="true"]{border-color:var(--blocked)!important}
.field-error{display:block;color:var(--blocked);font-size:var(--cap);line-height:1.3}
textarea{width:100%;min-height:8rem;resize:vertical;border:1px solid var(--rule);border-radius:3px;background:var(--fill);color:var(--ink);font:400 var(--meta)/1.5 var(--mono);padding:8px 10px}
details{margin:0}
summary{cursor:pointer;color:var(--ink);font-size:var(--meta);font-weight:600;display:flex;align-items:center;min-height:28px}
.subsect{border-top:1px solid var(--rule-soft)}
.subsect summary{display:flex;align-items:center;gap:6px;min-height:28px;font-size:var(--meta);color:var(--ink-2);list-style:none}
.subsect summary::-webkit-details-marker{display:none}
.subsect summary::before{content:"\25B8";font-size:9px;color:var(--ink-3);transition:transform var(--motion)}
.subsect[open]>summary::before{transform:rotate(90deg)}
.subsect>div[id]{padding:2px 0 8px}
#hook-registry-rows,.hook-registry-rows,.grpbody>.subsect{grid-column:1/-1}
#hook-registry-rows,.hook-registry-rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 18px;align-items:start}
#ecc-hook-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;align-items:start;width:100%}
#hook-registry-spawns,#hook-registry-controls,#hook-registry-overlaps,.hook-registry-spawns,.hook-registry-controls,.hook-registry-overlaps{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px 18px;align-items:start}
#hook-registry-spawns>p:last-child,.hook-registry-spawns>p:last-child{grid-column:1/-1}
.governance-info{display:grid;gap:10px;min-width:0}
.governance-info>.cap{margin-top:2px}
.governance-info-button{min-width:28px;min-height:28px;font-style:italic}
#ecc-hook-controls>fieldset,#ecc-hook-controls>p,#ecc-hook-controls>.tip-wrap{grid-column:1/-1}
/* tooltips */
.tip-wrap{display:inline-flex;position:relative;vertical-align:middle;margin-left:.3rem}
.help-button{min-width:20px;min-height:20px;padding:0;border-radius:999px;font-weight:700;line-height:1;font-size:var(--cap);background:var(--fill-2);color:var(--ink-2)}
.help-button:hover{color:var(--ink)}
.tooltip{display:none;position:fixed;z-index:900;max-width:min(430px,calc(100vw - 2rem));padding:.55rem .65rem;border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink);font-size:var(--meta);line-height:1.45;font-weight:400;text-align:left}
.tip-wrap .tooltip[data-open="true"]{display:block}
.tooltip .grpnote,.tooltip .help{border:0;padding:0;margin:0;color:inherit;max-width:none;font-size:var(--meta)}
.tooltip p{margin:0}
.tooltip p+p{margin-top:6px}
/* compact controls */
.ctlrow{display:flex;align-items:center;gap:6px}
.ctlrow select{flex:1;width:auto;min-width:0}
.sect select{height:30px;border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink);padding:0 8px;font-size:var(--meta);width:100%}
.lbl{font-size:var(--meta);color:var(--ink-3);min-width:52px;flex:0 0 auto}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:3px;background:var(--surface);padding:2px;gap:2px;flex:1}
.seg button{flex:1;height:24px;padding:0 10px;border-radius:2px;font:600 var(--meta)/1 var(--sans);color:var(--ink-3);transition:background var(--motion),color var(--motion)}
.seg button:hover{color:var(--ink)}
.seg button[aria-pressed="true"]{background:var(--fill-2);color:var(--ink)}
.poplist{display:grid}
.pop-row{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;min-height:32px;padding:0 4px;text-align:left;border-top:1px solid var(--rule-soft);font:600 var(--meta)/1 var(--sans);color:var(--ink-2);transition:background var(--motion),color var(--motion)}
.pop-row:first-child{border-top:0}
.pop-row .pl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.pop-row:hover{background:var(--fill);color:var(--ink)}
.pop-row[aria-expanded="true"]{color:var(--ink);background:var(--fill)}
.pop-row .selcount{margin-left:auto;font:600 var(--cap)/1 var(--mono);color:var(--ink)}
.pop-row .pc{color:var(--ink-3);font-size:var(--body)}
.pop{display:none;position:fixed;z-index:700;min-width:320px;max-width:calc(100vw - 24px);border:1px solid var(--ink);border-radius:4px;background:var(--surface);padding:12px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.pop[data-open="true"]{display:grid;gap:8px;align-content:start}
#side .pop .sect,.pop .sect{padding:0;border:0;background:transparent}
.pop .sect>.cap{display:none}
.cli-usage-list{display:grid;gap:10px}
.cli-usage-list article{display:grid;gap:5px;padding-top:9px;border-top:1px solid var(--rule-soft)}
.cli-usage-list article:first-of-type{padding-top:0;border-top:0}
.cli-usage-list h3{font:600 var(--meta)/1.35 var(--sans)}
.cli-usage-list .help{margin:0}
.recipehead{display:flex;align-items:center;gap:6px;margin-bottom:4px}
/* hook rows */
.hookline{display:flex;align-items:center;gap:6px;font-size:var(--meta);flex-wrap:wrap}
.hookline b{font:600 var(--meta)/1.3 var(--mono)}
.hookopt{display:flex;align-items:center;gap:8px;min-height:30px;font-size:var(--meta);color:var(--ink-2)}
.hookopt input[type="checkbox"]{accent-color:var(--ink);width:15px;height:15px;margin:0;flex:0 0 auto}
.hookopt .hid{font:600 var(--meta)/1.3 var(--mono);color:var(--ink)}
.hookopt .ev{font:400 var(--cap)/1.3 var(--mono);color:var(--ink-3)}
.hookopt input:disabled~.hid{color:var(--ink-3)}
fieldset .hookprofiles{display:flex;gap:12px;flex-wrap:wrap}
.ecc-hook-group{border:1px solid var(--rule);border-radius:4px;background:var(--surface);overflow:hidden}
.ecc-hook-group summary{list-style:none;gap:7px;min-height:36px;padding:6px 9px;background:var(--fill);color:var(--ink);font:700 var(--meta)/1.35 var(--sans)}
.ecc-hook-group summary::-webkit-details-marker{display:none}
.ecc-hook-group summary::before{content:"\25B8";font-size:9px;color:var(--ink-3);transition:transform var(--motion)}
.ecc-hook-group[open]>summary{border-bottom:1px solid var(--rule)}
.ecc-hook-group[open]>summary::before{transform:rotate(90deg)}
.ecc-hook-group [data-ecc-hook-group-label]{min-width:0}
.ecc-hook-group [data-ecc-hook-group-count]{margin-left:auto;color:var(--ink-3);font:600 var(--cap)/1 var(--mono)}
.ecc-hook-group>p.help{margin:0;padding:7px 9px 4px}
.ecc-hook-group .hookreg{padding-left:9px;padding-right:9px}
.ecc-hook-group .hookreg:first-of-type{border-top:0}
/* drawers */
.scrim{position:fixed;inset:0;z-index:800;background:var(--scrim);opacity:0;pointer-events:none;transition:opacity var(--motion)}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:810;width:min(480px,94vw);overflow-y:auto;overflow-x:hidden;background:var(--surface);border-left:1px solid var(--rule);padding:16px 18px 28px;display:grid;gap:12px;align-content:start;transform:translateX(24px);opacity:0;transition:transform var(--motion),opacity var(--motion)}
.drawer>*,#drawer-detail,#drawer-detail>*{min-width:0;max-width:100%}
.drawer p,.drawer pre,.drawer .note,.drawer .journey,.drawer .journey-effective{overflow-wrap:anywhere;word-break:break-word;white-space:normal}
.drawer .cmdline code,.drawer .scroll-code{overflow-wrap:normal;word-break:normal;white-space:nowrap}
.scanner-findings{display:grid;gap:8px}
.scanner-finding{border:1px solid var(--rule);border-radius:3px;padding:9px;display:grid;gap:4px;background:var(--fill)}
.scanner-finding h3{font:600 var(--meta)/1.35 var(--sans)}
.scanner-finding p{font-size:var(--meta);line-height:1.5;color:var(--ink-2)}
.scanner-detail{border-top:1px solid var(--rule);padding-top:5px}
.scanner-detail pre{margin:0;padding:9px;border:1px solid var(--rule);background:var(--fill);font:400 var(--cap)/1.5 var(--mono)}
.scrim.open+.drawer{transform:none;opacity:1}
.dhead{display:flex;align-items:flex-start;gap:10px}
.dhead h2{font:600 var(--title)/1.25 var(--mono);overflow-wrap:anywhere}
.dhead .x{margin-left:auto;color:var(--ink-3);font-size:var(--title);width:30px;height:30px;display:grid;place-items:center;border-radius:3px;flex:0 0 auto}
.dhead .x:hover{background:var(--fill-2);color:var(--ink)}
/* footer ledger */
.ledger{position:sticky;bottom:0;z-index:90;display:flex;align-items:center;gap:14px;padding:6px 16px;font-size:var(--meta);flex-wrap:wrap;border-top:1px solid var(--rule);background:var(--surface)}
.ledger i{font-style:normal;color:var(--ink-3)}
.ledger b{font-weight:700;font-family:var(--mono)}
.l-req b{color:var(--ink)}.l-wait b{color:var(--owed)}.l-blk b{color:var(--blocked)}.l-ext b{color:var(--ink-2)}
.ledger .sp{flex:1}
.ledger .eff{color:var(--ink-3)}
/* sheet */
.sheet{position:fixed;inset:auto 0 0 0;z-index:850;height:min(70vh,560px);display:none;flex-direction:column;background:var(--surface);border-top:2px solid var(--ink)}
.sheet.open{display:flex}
.sheet header{display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid var(--rule)}
.sheet h3{font:600 var(--title)/1.2 var(--sans)}
.sheet .sub{font-size:var(--meta);color:var(--ink-3)}
.sheet .sbody{flex:1;margin:0;overflow:auto;padding:13px 16px;display:grid;gap:10px;align-content:start}
.sheet textarea{min-height:16rem}
.importbar{padding:12px;display:grid;gap:8px}
/* removed: header rail toggle rules (toggle lives in the sidebar) */
@media(min-width:1200px){.form-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:920px){
.bar{padding:8px}
.stage{grid-template-columns:minmax(0,1fr);grid-template-rows:none}
#side{grid-column:1;grid-row:auto;position:static;width:100%!important;border-right:0;border-bottom:2px solid var(--ink);padding:10px 12px}
.bar,.announce,.ticker,.work,.ledger{grid-column:1}
#rail-toggle{display:none}
#side .rail{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:2px 26px;align-items:start}
body[data-rail="off"] #side .brand-name,body[data-rail="off"] #side .seek .lbl2,body[data-rail="off"] #side .seek kbd,body[data-rail="off"] #side .cap,body[data-rail="off"] #side .pop-row .pl,body[data-rail="off"] #side .pop-row .selcount,body[data-rail="off"] #side .pop-row .pc{display:revert}
body[data-rail="off"] #side .pop-row{justify-content:flex-start;padding:0 4px}
body[data-rail="off"] .sidehead{justify-content:flex-start}
body[data-rail="off"] .sidehead .brand{display:flex}
.form-grid{grid-template-columns:1fr}
.grpbody{grid-template-columns:minmax(0,1fr)}
#ecc-hook-controls{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:560px){
.grphead{gap:7px}
.grphead h2{white-space:normal}
.meter{display:none}
.row{gap:6px}
.pop{min-width:0}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
</style>
</head>
<body>
<a class="skip" href="#workbench">Skip to policy workbench</a>
<div class="field" aria-hidden="true"></div>

<div class="stage">
  <header class="bar" aria-label="Policy workbench toolbar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-opacity=".92" stroke-width="1.7"/><circle cx="12" cy="12" r="2.7" fill="currentColor"/><circle cx="17.3" cy="6.7" r="2.1" fill="currentColor"/></svg></span>
      <h1 class="brand-name">Policy Workbench <span>&middot; no repository required</span></h1>
    </span>
    <span class="sp"></span>
    <span id="status">Ready - no repository is required.</span>
    <label>Posture <select id="posture"><option value="vibe">Vibe</option><option value="enterprise">Enterprise</option></select></label>
    <span class="pill" role="group" aria-label="Theme">
      <button type="button" data-theme-set="light" aria-pressed="true">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
    </span>
    <button type="button" class="btn" id="clear-policy">Clear</button>
    <button type="button" class="btn" id="import-policy">Import policy (replaces current)</button>
    <button type="button" class="btn" id="import-evidence">Import evidence (non-destructive preflight)</button>
    <button type="button" class="btn" id="import-decision">Import decision (inspection only)</button>
    <button type="button" class="btn" id="validate">Validate</button>
    <button type="button" class="btn" id="download">Download</button>
    <a class="github-link" href="https://github.com/samartomar/ai-harness" target="_blank" rel="noopener noreferrer" aria-label="Open AIH on GitHub" title="Open AIH on GitHub"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.4a9.8 9.8 0 0 0-3.1 19.1c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.1-4.7-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.4 4.6-4.7 4.9.4.3.7 1 .7 1.9V21c0 .3.2.6.7.5A9.8 9.8 0 0 0 12 2.4Z"/></svg></a>
    <button type="button" class="btn primary" id="export">Policy JSON</button>
    <input class="hidden" id="policy-file" type="file" accept="application/json">
    <input class="hidden" id="evidence-file" type="file" accept="application/json">
    <input class="hidden" id="decision-file" type="file" accept="application/json">
  </header>

  <p id="announcement" class="announce" aria-live="polite"></p>${catalogProvenance}${baselineEvidenceProvenance}

  <div class="work">
    <main class="plane" id="workbench" tabindex="-1">
      <section class="gcard adoption-recipe" id="adoption-recipe" aria-labelledby="adoption-recipe-title">
        <h2 id="adoption-recipe-title">Adoption recipe</h2>
        <p class="help">One bounded owner per question. This guidance is inert: it does not select, approve, install, or export anything.</p>
        <div id="adoption-recipe-roles"></div>
      </section>

      <p class="gcard grpnote" id="plane-empty" hidden></p>
      <div id="framework-rows"></div>

      <section class="gcard sect" id="policy-settings" aria-labelledby="policy-settings-title">
        <h2 id="policy-settings-title">Policy settings</h2>
        <div><div class="cap">Allowed CLI <span class="end" id="supported-cli-count"></span></div><div class="chips" id="supported-cli-hosts"></div><p class="help" id="supported-cli-note"></p></div>
        <div class="brow"><button type="button" class="btn sm" id="open-ecc-mcp">Approve ECC MCP</button><button type="button" class="btn sm" id="open-artifacts">Organization artifacts</button><button type="button" class="btn sm" id="open-custom-hook-info" data-detail="AIH Governance &amp; Telemetry Hooks information">Why custom Hooks are unavailable</button></div>
      </section>


      <section class="gcard grp group" id="surface-ecc-hooks" data-open="0" data-owner="ECC" data-groupcard>
        <button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC hook controls</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button>
        <div class="grpbody stack"><div id="ecc-hook-controls"></div><p class="grpnote">AIH records supported Claude environment intent. ECC executes hooks; this form does not install, run, or verify them.</p></div>
      </section>
      <section class="gcard grp group" data-open="0" data-owner="You" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Your sources</h2><span class="own">You</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="custom-rows"></div><p class="grpnote">Custom MCP can only be authored as a fully pinned pending candidate. It has no activation affordance until supported scanning, evidence and projection exist.</p></section>

${protectedPolicyMarkup}

      <section class="gcard grp group" data-open="0" data-owner="ECC Superpowers" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC / Superpowers curation</h2><span class="own">recorded</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="curation-rows"></div><p class="grpnote">AIH preserves audited curation intent for agents, skills and commands. It does not install, project or enforce those external assets. A selection becomes curation once it carries an audit record and digest.</p></section>

      <section class="gcard grp group" data-open="0" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Approval / evidence</h2><span class="own">preflight</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="approval-rows"></div><div class="grpnote"><p id="receipt-state" class="help">No authority receipt imported.</p><p><button type="button" class="btn sm" id="copy-approvals" disabled>Preserve approval subjects in policy (not effective)</button></p><h3>Imported governance decision</h3><p id="decision-state" class="help">No standalone decision imported.</p><pre id="decision-rows" class="mono"></pre><pre id="decision-export" class="mono"></pre><p><button type="button" class="btn sm" id="download-decision" disabled>Download canonical decision</button></p><details><summary>Finding model: 8 administrator-dispositionable, 6 hard blockers</summary><p class="help">A completed scan reports these 8. The accountable administrator decides each one, because a detector label is evidence and not a verdict. They stay visible and authorable; this workbench does not dispose of them.</p><p id="dispositionable-findings" class="mono"></p><p class="help">These 6 are missing or untrustworthy prerequisites rather than detector findings. No approval substitutes for one, and this workbench cannot waive, approve or downgrade them.</p><p id="hard-blockers" class="mono"></p></details></div></section>
    </main>
  </div>

  <div class="ledger" aria-label="Policy tally">
    <span class="l-req"><i>selected</i> <b id="t-req">0</b></span>
    <span class="l-wait"><i>awaiting</i> <b id="t-wait">0</b></span>
    <span class="l-blk"><i>blocked</i> <b id="t-blk">0</b></span>
    <span class="l-ext"><i>selectable</i> <b id="t-ext">0</b></span>
    <span class="sp"></span>
    <span class="eff">effective: not evaluated &mdash; needs a target repository</span>
  </div>
</div>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" hidden aria-label="Item detail">
  <div id="drawer-detail"></div>
</aside>

<div class="scrim" id="authoring-scrim"></div>
<aside class="drawer" id="authoring-sidebar" hidden aria-label="Policy authoring">
  <div class="dhead"><h2 id="authoring-title">Policy authoring</h2><button type="button" class="x" id="authoring-close" aria-label="Close policy authoring">&#10005;</button></div>
  <div id="authoring-forms">
    <details id="curation-editor"><summary>Add external source</summary>
      <div class="dform" style="margin-top:8px">
        <p class="help" id="curation-purpose">Add audited ECC or Superpowers guidance. This is framework curation, not an organization-owned source and not MCP. AIH records report-only policy intent and does not install, run, or enforce the source.</p>
        <div class="form-grid">
          <label><span id="curation-framework-label">External framework owner</span> <select id="curation-framework"></select></label>
          <label>Catalog prefill (optional) <select id="curation-asset"></select></label>
          <label>Item kind <select id="curation-kind"><option value="agent">Agent</option><option value="skill">Skill</option><option value="command">Command</option></select></label>
          <label>Item identifier <input id="curation-id" required></label>
          <label>Accountable owner email <input id="curation-owner" type="email" autocomplete="email" placeholder="name@company.example" required></label>
          <label>Source repository <input id="curation-repository" placeholder="owner/repository" required></label>
          <label>Source commit <input id="curation-commit" placeholder="40-character commit" required></label>
          <label>Source path <input id="curation-path" placeholder="relative/path" required></label>
          <label>Audit record <input id="audit-record" value="external-audit" required></label>
          <label>Audit digest <input id="audit-digest" value="sha256:0000000000000000000000000000000000000000000000000000000000000000" required></label>
          <label>Admin clarification <input id="curation-note"></label>
        </div>
        <div class="brow"><button type="button" class="btn sm primary" id="add-curation">Add external curation intent</button><button type="button" class="btn sm" id="cancel-curation-edit" hidden>Cancel curation edit</button></div>
      </div>
    </details>
    <details id="custom-editor"><summary>Add organization MCP</summary>
      <form id="custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Pinned custom source</legend>
          <p class="help">Register a pinned organization MCP package and the person accountable for its evidence. The email is an audit identity, not an approval or credential. The candidate stays blocked; next, scan this exact package and bind the completed evidence record to the same pin.</p>
          <section class="governance-info" aria-labelledby="custom-source-guide-title">
            <h3 id="custom-source-guide-title">Find the exact MCP source</h3>
            <p class="help">Directories, READMEs, and documentation pages are discovery only. Use them to locate the publisher's canonical npm package or GitHub repository; never enter a listing or README URL as an MCP endpoint or treat an advertised install command as evidence.</p>
            <div class="brow">
              <a class="btn sm" data-mcp-source-search href="https://mcpmarket.com/" target="_blank" rel="noopener noreferrer">Search MCP directories</a>
              <a class="btn sm" data-mcp-source-search href="https://www.npmjs.com/search?q=mcp" target="_blank" rel="noopener noreferrer">Search npm</a>
              <a class="btn sm" data-mcp-source-search href="https://github.com/search?q=mcp+server&amp;type=repositories" target="_blank" rel="noopener noreferrer">Search GitHub</a>
            </div>
            <p class="help">Found an npm package? Copy its exact <code>name</code> from the publisher's install or <code>npx</code> command, npm page, or repository <code>package.json</code>. A directory title, publisher scope, SDK package, or SDK version may not identify the runnable MCP server. Found a GitHub repository or README? Use the exact-source route. Found a real hosted MCP endpoint? Use the separate pending remote MCP form.</p>
            <div class="brow"><button type="button" class="btn sm" id="open-protected-mcp">Use exact GitHub / README source</button></div>
            <p class="help mono" id="custom-scan-guide">Enter a canonical npm package and exact version to see the metadata and scan commands.</p>
          </section>
          <div class="form-grid">
            <label>Identifier <input id="custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>Accountable owner email <input id="custom-owner" type="email" autocomplete="email" placeholder="name@company.example" required></label>
            <label>Exact npm package name <input id="custom-package" placeholder="mcp-package or @scope/package" aria-describedby="custom-package-help" required></label>
            <label>Exact version <input id="custom-version" placeholder="1.2.3" required></label>
            <label>Integrity digest <input id="custom-integrity" placeholder="sha256:..." required></label>
            <label>Evidence record <input id="custom-evidence" required></label>
            <label>Clarification <input id="custom-note"></label>
          </div>
          <p class="help" id="custom-package-help">Use an unscoped package name or the complete <code>@scope/package</code>. A scope such as <code>@publisher</code> is not a package.</p>
          <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Add pending custom MCP</button></div>
        </fieldset>
      </form>
    </details>
    <details id="remote-custom-editor"><summary>Record a pending remote custom MCP</summary>
      <form id="remote-custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Fenced remote endpoint</legend>
          <p class="help">AIH records the exact HTTPS origin and administrator-managed availability. Enter the approving person's email so the policy identifies the human decision-maker; it is an audit identity, not a credential. AIH does not contact or content-scan the endpoint, which remains non-projectable.</p>
          <div class="form-grid">
            <label>Identifier <input id="remote-custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>HTTPS origin <input id="remote-custom-origin" placeholder="https://mcp.example.com" required></label>
            <label>Approver email <input id="remote-custom-approved-by" type="email" autocomplete="email" placeholder="name@company.example" required></label>
            <label>Authentication mode <input id="remote-custom-authentication-mode" placeholder="oauth" required></label>
            <label>Allowed data classes <input id="remote-custom-data-classes" placeholder="design-metadata, issue-metadata" required></label>
            <label>Administrative status <select id="remote-custom-administrative-status"><option value="approved">approved</option><option value="revoked">revoked</option></select></label>
            <label>Evidence record <input id="remote-custom-evidence" required></label>
            <label>Clarification <input id="remote-custom-note"></label>
          </div>
          <p class="help">Content scan: none. This recorded identity is fenced until later remote-endpoint machinery.</p>
          <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Record pending remote MCP</button></div>
        </fieldset>
      </form>
    </details>
  </div>
</aside>

<div class="scrim" id="ecc-mcp-scrim"></div>
<aside class="drawer" id="ecc-mcp-sidebar" hidden aria-label="ECC MCP approval authoring">
  <div class="dhead"><h2>Add MCP</h2><button type="button" class="x" id="ecc-mcp-close" aria-label="Close Add MCP">&#10005;</button></div>
  <section id="ecc-mcp-editor" class="dform">
    <p class="help">Approval records permission for this pinned ECC MCP. Enter the approving person's email so the policy identifies the human decision-maker; it is an audit identity, not a credential. Only <code>https-configurable</code> entries can use later explicit Add; manual entries remain approval-only/manual. For an eligible entry, the seat operator explicitly chooses one client with <code>aih ecc mcp add &lt;id&gt; --cli &lt;client&gt;</code>; no policy field chooses it. This panel does not install, contact, scan, attest, or claim reachability or a tool surface.</p>
    <div class="form-grid">
      <label>ECC MCP <select id="ecc-mcp-id"></select></label>
      <label>Administrative status <select id="ecc-mcp-state"><option value="approved">approved</option><option value="revoked">revoked</option></select></label>
      <label>Approver email <input id="ecc-mcp-approved-by" type="email" autocomplete="email" placeholder="name@company.example" required></label>
      <label>Authentication mode <input id="ecc-mcp-authentication-mode" placeholder="oauth" required></label>
      <label>Allowed data classes <input id="ecc-mcp-data-classes" placeholder="issue-metadata, design-metadata" required></label>
    </div>
    <div class="brow" style="margin-top:8px"><button type="button" class="btn sm primary" id="save-ecc-mcp-approval">Save MCP approval</button></div>
    <div id="ecc-mcp-approval-rows"></div>
  </section>
</aside>

<section class="sheet" id="sheet" aria-label="Authored policy and evaluated report">
  <header><h3>Authored policy</h3><span class="sub">exact schema fields</span><span class="sp" style="flex:1"></span><button type="button" class="btn sm" id="sheet-close">Close</button></header>
  <div class="sbody">
    <label for="config-preview" class="help">Authored policy &mdash; actual schema fields</label>
    <textarea id="config-preview" readonly aria-label="Authored policy actual schema fields"></textarea>
    <label for="report-preview" class="help">Evaluated report &mdash; unavailable without target evaluation</label>
    <textarea id="report-preview" readonly aria-label="Evaluated report unavailable without target evaluation"></textarea>
    <p class="help">Author portable intent without repository access. Imported audit and authority data is preserved/preflight-only here; AIH engine evaluation in a target repository is the only source of effective state.</p>
  </div>
</section>
<script>window.__aihWorkbenchModel=__AIH_DATA__;</script>
<script>${workbenchBrowserScript}</script>
</body>
</html>`.replace("__AIH_DATA__", () => safeScriptJson(workbenchModel));
}
