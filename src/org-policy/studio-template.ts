import { artifactIntakeWorkbenchScript } from "./studio-artifact-intake.js";
import type { PolicyStudioModel } from "./studio-model.js";
import {
  protectedPolicyWorkbenchMarkup,
  protectedPolicyWorkbenchScript,
} from "./studio-protected-authority.js";

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
  const artifactIntakeScript = artifactIntakeWorkbenchScript();
  const protectedPolicyMarkup = protectedPolicyWorkbenchMarkup();
  const protectedPolicyScript = protectedPolicyWorkbenchScript();
  const aihMcpDeclarations = model.catalog.eccMcpInventory.filter((item) => item.owner === "aih");
  const aihMcpControlIds = new Set(model.catalog.mcp.map((item) => item.id));
  const sharedAihMcpCount = aihMcpDeclarations.filter((item) =>
    aihMcpControlIds.has(item.id),
  ).length;
  const aihMcpIdentityCount = new Set([
    ...aihMcpControlIds,
    ...aihMcpDeclarations.map((item) => item.id),
  ]).size;
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
.announce{min-height:22px;padding:4px 16px 0;font-size:var(--meta);color:var(--ink-2)}
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
.row[data-state="availability"] .row-state{color:var(--ink-3)}
.more{height:24px;padding:0 7px;border-radius:3px;color:var(--ink-3);font:600 var(--cap)/1 var(--sans);display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background var(--motion),color var(--motion)}
.more:hover{color:var(--ink);background:var(--fill-2)}
.row-slot{grid-column:1/-1}
.row-slot:empty{display:none}
.row-actions{grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap;padding:2px 0 6px}
.row-actions button,[data-protected-remove],[data-protected-revoke],[data-composition-add]{height:24px;padding:0 9px;border:1px solid var(--rule);border-radius:3px;background:var(--surface);color:var(--ink-2);font-size:var(--cap);font-weight:600}
.row-actions button:hover,[data-protected-remove]:hover,[data-protected-revoke]:hover,[data-composition-add]:hover{background:var(--fill-hover);color:var(--ink)}
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
/* spotlight */
.spot-bd{position:fixed;inset:0;z-index:900;background:var(--scrim);display:grid;place-items:start center;padding:10vh 24px 24px;opacity:0;pointer-events:none;transition:opacity var(--motion)}
.spot-bd.open{opacity:1;pointer-events:auto}
.spot{width:min(100%,620px);border-radius:4px;border:1px solid var(--rule);background:var(--surface);padding:16px;display:grid;gap:11px;transform:translateY(10px);opacity:0;transition:transform var(--motion),opacity var(--motion)}
.spot-bd.open .spot{transform:none;opacity:1}
.spot input{border:0;background:transparent;color:var(--ink);font:400 var(--title)/1.5 var(--sans);outline:none;width:100%;border-bottom:1px solid var(--rule);padding-bottom:10px}
.hits{display:grid;gap:2px;max-height:46vh;overflow:auto}
.hit{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:3px;text-align:left;min-height:30px;transition:background var(--motion)}
.hit:hover,.hit.sel{background:var(--fill-hover)}
.hit .hid{font:400 var(--meta)/1 var(--mono);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hit .hg{font-size:var(--cap);color:var(--ink-3);flex:0 0 auto}
.spot-foot{display:flex;gap:11px;color:var(--ink-3);font-size:var(--meta);flex-wrap:wrap}
.spot-foot .sp{flex:1}
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
    <button type="button" class="seek" id="seek">Find any item&hellip; <kbd>/</kbd></button>
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

  <nav class="ticker" id="owner-ticker" aria-label="Focus one surface"></nav>

  <div class="work">
    <aside class="rail" aria-label="Presets and quick selection">
      <section class="gcard sect">
        <div class="cap">Preset <span class="end" id="rail-posture">Custom</span></div>
        <div id="presets" style="display:grid;gap:4px"></div>
        <p class="help" id="rail-composition-note"></p>
      </section>
      <section class="gcard sect" data-owner="ECC"><div class="cap">Languages</div><div class="chips" id="rail-langs"></div></section>
      <section class="gcard sect" data-owner="ECC"><div class="cap">Frameworks</div><div class="chips" id="rail-frameworks"></div></section>
      <section class="gcard sect" data-owner="ECC"><div class="cap">Capabilities</div><div class="chips" id="rail-caps"></div></section>
      <section class="gcard sect" data-owner="ECC"><div class="cap">ECC modules</div><div class="chips" id="rail-modules"></div></section>
      <section class="gcard sect">
        <div class="cap">Allowed CLI <span class="end" id="rail-host-count"></span></div>
        <div class="chips" id="rail-hosts"></div>
        <p class="help" id="rail-host-note"></p>
      </section>
      <section class="gcard sect">
        <div class="cap">MCP approvals</div>
        <button type="button" class="btn sm" id="open-ecc-mcp" style="justify-content:center">Approve ECC MCP</button>
      </section>
      <section class="gcard sect">
        <div class="cap">Your sources</div>
        <button type="button" class="btn sm" id="open-artifacts" style="justify-content:center">Organization artifacts</button>
        <button type="button" class="btn sm" id="open-custom-hook-info" data-detail="AIH Governance &amp; Telemetry Hooks information" style="justify-content:center">Why custom Hooks are unavailable</button>
      </section>
    </aside>

    <main class="plane" id="workbench" tabindex="-1">
      <div class="gcard planetop" role="group" aria-label="Filter inventory">
        <button type="button" class="f" data-filter="all" data-label="All" aria-pressed="true">All</button>
        <button type="button" class="f" data-filter="requested" data-label="Selected" aria-pressed="false">Selected</button>
        <button type="button" class="f" data-filter="external" data-label="Selectable" aria-pressed="false">Selectable</button>
        <button type="button" class="f" data-filter="approval" data-label="Approval authoring" aria-pressed="false">Approval authoring</button>
        <button type="button" class="f" data-filter="availability" data-label="Availability only" aria-pressed="false">Availability only</button>
        <button type="button" class="f" data-filter="pending" data-label="Awaiting" aria-pressed="false">Awaiting</button>
        <button type="button" class="f" data-filter="blocked" data-label="Blocked" aria-pressed="false">Blocked</button>
        <!-- A separate axis from the four selection states, and named apart from
             them: a component the scanners blocked is still selectable, so
             folding it into "Blocked" would claim aih withheld it. -->
        <button type="button" class="f" data-filter="vet-blocked" data-label="Vet blocked" aria-pressed="false">Vet blocked</button>
        <span class="sp"></span>
        <button type="button" class="f" id="toggle-groups">Expand all</button>
        <span class="n"><b id="c-shown">0</b> / <b id="c-total">0</b></span>
      </div>

      <section class="gcard adoption-recipe" id="adoption-recipe" aria-labelledby="adoption-recipe-title">
        <h2 id="adoption-recipe-title">Adoption recipe</h2>
        <p class="help">One bounded owner per question. This guidance is inert: it does not select, approve, install, or export anything.</p>
        <div id="adoption-recipe-roles"></div>
      </section>

      <section class="gcard grp group" id="surface-aih-skills" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH Skills</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="aih-skill-rows"></div><p class="grpnote">First-party skills shipped by AIH. Select the skills you want; AIH binds their package source automatically. Exact lock, promotion evidence, and custody remain required before a skill becomes effective.</p></section>
      <section class="gcard grp group" id="surface-aih-agents" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH Agents</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="aih-agent-rows"></div><p class="grpnote">First-party workflows designed for an isolated worker. Selection records governed package intent; this Workbench does not launch an agent. Exact lock, promotion evidence, custody, and a supported host execution route remain required.</p></section>

      <section class="gcard grp group" id="surface-aih-mcp-servers" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH MCP servers</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody"><section class="mcp-catalog-subgroup" aria-labelledby="aih-mcp-servers-heading"><h3 id="aih-mcp-servers-heading">Unique MCP identities <span class="subcount">${String(aihMcpIdentityCount)}</span></h3><p class="help">${String(model.catalog.mcp.length)} selectable AIH controls; ${String(sharedAihMcpCount)} are also declared by ECC; ${String(aihMcpDeclarations.length - sharedAihMcpCount)} remain ECC availability only.</p><div class="mcp-catalog-rows" id="mcp-rows"></div></section></div><p class="grpnote">Each MCP identity appears once. A shared row keeps the AIH selection control and carries ECC source provenance; an ECC-only row remains read-only. A requested control still needs target-repository identity, evidence, authority, safety, ownership and a supported projector before it can become effective. ECC-owned declarations remain in the <b>ECC MCP catalog</b>.</p></section>

      <section class="gcard grp group" id="surface-ecc-mcp-catalog" data-open="0" data-owner="ECC" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC MCP catalog</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody"><section class="mcp-catalog-subgroup" aria-labelledby="ecc-mcp-declarations-heading"><h3 id="ecc-mcp-declarations-heading">Selectable ECC MCP declarations <span class="subcount">${String(model.catalog.frameworks.find((framework) => framework.id === "ecc")?.assets.filter((asset) => asset.kind === "mcp").length ?? 0)}</span></h3><div class="mcp-catalog-rows" id="ecc-mcp-declaration-rows"></div></section><section class="mcp-catalog-subgroup" aria-labelledby="ecc-mcp-approvals-heading"><h3 id="ecc-mcp-approvals-heading">Approval catalog entries <span class="subcount">${String(model.catalog.externalMcp.length)}</span></h3><div class="mcp-catalog-rows" id="ecc-mcp-rows"></div></section></div><p class="grpnote">Selectable declarations preserve pinned ECC source intent; ECC remains the installer and runtime owner. Approval entries author separate organization approval only. Neither path makes an AIH control, installation, scan, attestation, or reachability claim.</p></section>

      <section class="gcard grp group has-tip" id="surface-aih-governance" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH-Governance &amp; Telemetry Hooks</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="hook-rows"></div><span class="tip-wrap grp-tip"><button type="button" class="help-button governance-info-button" aria-label="AIH Governance &amp; Telemetry Hooks information" data-governance-information data-detail="AIH Governance &amp; Telemetry Hooks information"><i aria-hidden="true">i</i></button></span></section>
      <section class="gcard grp group" id="surface-ecc-hooks" data-open="0" data-owner="ECC" data-static-count="41" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC-Guardrails &amp; Safety Hooks</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack"><div id="ecc-hook-controls"></div></div><p class="grpnote">ECC owns and executes these 41 pinned hooks. AIH records the supported profile and disabled-hook list, then projects that intent through the supported Claude settings environment. This surface does not claim AIH execution or enforcement.</p></section>
      <div id="hook-registry-source" hidden><p>AIH is the sole registrar of hook entries in a client's native configuration; third-party runtimes stay the executors. Every entry below is emitted and revocable by AIH. A third-party command is written byte-for-byte as its source declares it — AIH does not interpret, wrap, or run it. This is a read-only projection view: registrations are authored in the policy document (<code>governance.hookRegistrations</code>) and hook components on their own inventory rows, never here.</p><div id="hook-registry-rows"></div><div id="hook-registry-controls"></div><div id="hook-registry-overlaps"></div><div id="hook-registry-spawns"></div></div>

      <p class="gcard grpnote" id="plane-empty" hidden></p>
      <div id="framework-rows"></div>

      <section class="gcard grp group" data-open="0" data-owner="ECC" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC skills</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="ecc-skill-rows"></div><p class="grpnote">This is the complete source-locked <code>skills/&lt;name&gt;/SKILL.md</code> inventory. Only rows already represented by an individually governable policy component can be selected; availability-only rows do not author policy or claim installation, materialization, evidence, or support.</p></section>

      <section class="gcard grp group" data-open="0" data-owner="ECC" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Enterprise composition</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="composition-parts"></div></section>

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

<div class="spot-bd" id="spot-bd" role="dialog" aria-modal="true" aria-label="Find item">
  <div class="spot">
    <input id="spot-q" placeholder="Find any item across the whole inventory&hellip;" autocomplete="off">
    <div class="hits" id="hits"></div>
    <div class="spot-foot"><span><kbd>esc</kbd> close</span><span><kbd>&#8629;</kbd> open</span><span class="sp"></span><span id="spot-count"></span></div>
  </div>
</div>

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
<script>
const model=__AIH_DATA__;
const state={policy:structuredClone(model.initialPolicy),receipt:null,decision:null};
let decisionSelection=0;
const byId=function(id){return document.getElementById(id)};
const esc=function(value){return String(value).replace(/[&<>"']/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]})};
const decisionOrdinal=function(left,right){return left<right?-1:left>right?1:0};
const decisionStableJson=function(value){if(Array.isArray(value)){return "["+value.map(decisionStableJson).join(",")+"]"}if(value!==null&&typeof value==="object"){return "{"+Object.entries(value).sort(function(left,right){return decisionOrdinal(left[0],right[0])}).map(function(entry){return JSON.stringify(entry[0])+":"+decisionStableJson(entry[1])}).join(",")+"}"}return JSON.stringify(value)};
const decisionTimestamp=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
const decisionDays=function(year,month){return month===2?(year%4===0&&(year%100!==0||year%400===0)?29:28):(month===4||month===6||month===9||month===11?30:31)};
const decisionValidTimestamp=function(value){const match=typeof value==="string"?decisionTimestamp.exec(value):null;if(!match){return false}const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),offsetHour=match[8]===undefined?0:Number(match[8]),offsetMinute=match[9]===undefined?0:Number(match[9]);return month>=1&&month<=12&&day>=1&&day<=decisionDays(year,month)&&hour<=23&&minute<=59&&second<=59&&offsetHour<=23&&offsetMinute<=59&&Number.isFinite(Date.parse(value))};
const decisionSorted=function(values){return Array.isArray(values)&&values.every(function(value,index){return typeof value==="string"&&(index===0||decisionOrdinal(values[index-1],value)<0)})};
const decisionProblems=function(value){const problems=schemaErrors(model.decisionSchema,value,"decision");if(!value||typeof value!=="object"||Array.isArray(value)){return problems.length?problems:["decision: must be an object"]}const decision=value;const validText=function(item){return typeof item==="string"&&item.length>0&&item.length<=500&&item===item.trim()&&!/[\p{C}]/u.test(item)};const validId=function(item){return typeof item==="string"&&/^[a-z][a-z0-9-]{0,63}$/.test(item)};const validDigest=function(item){return typeof item==="string"&&/^sha256:[0-9a-f]{64}$/.test(item)};const validSet=function(items,min,max,check){return Array.isArray(items)&&items.length>=min&&items.length<=max&&items.every(check)&&decisionSorted(items)};const timestamps=[decision.issuedAt,decision.notBefore,decision.expiresAt];if(!timestamps.every(decisionValidTimestamp)){problems.push("decision: timestamps must be calendar-valid offset-qualified values")}else{const issued=Date.parse(decision.issuedAt),notBefore=Date.parse(decision.notBefore),expires=Date.parse(decision.expiresAt);if(notBefore<issued||expires<=notBefore||expires-issued>7776000000){problems.push("decision: validity window is invalid")}}if(![decision.candidate,decision.kind,decision.issuer,decision.actor].every(validId)||!/^decision-[a-z0-9-]{0,55}$/.test(decision.id)||![decision.sourceDigest,decision.evidenceDigest,decision.reviewedControlDigest].every(validDigest)||![decision.policyVersion,decision.reason].every(validText)){problems.push("decision: identity or text is invalid")}if(!validSet(decision.targets,1,64,validId)||!validSet(decision.effects,1,64,validId)||!validSet(decision.acceptedFindings,0,64,validId)||!validSet(decision.acceptedGaps,0,64,validId)||!validSet(decision.conditions,0,32,validText)){problems.push("decision: bounded collections must be ordinal-sorted and unique")}if(decision.disposition==="accepted-with-conditions"){if(!decisionValidTimestamp(decision.reviewBy)||!validSet(decision.conditions,1,32,validText)||decision.acceptedFindings.length+decision.acceptedGaps.length===0||decision.acceptedFindings.some(function(item){return decision.acceptedGaps.includes(item)})||Date.parse(decision.reviewBy)<Date.parse(decision.notBefore)||Date.parse(decision.reviewBy)>Date.parse(decision.expiresAt)){problems.push("decision: accepted-with-conditions semantics are invalid")}}return Array.from(new Set(problems))};
let helpSequence=0;
const help=function(label,detail){const id="tooltip-"+(++helpSequence);return '<span class="tip-wrap"><button type="button" class="help-button" aria-label="About '+esc(label)+'" aria-describedby="'+id+'" aria-expanded="false" data-tooltip-button="'+id+'">?</button><span id="'+id+'" class="tooltip" role="tooltip" data-open="false">'+esc(detail)+'</span></span>'};
const announce=function(message,error){const node=byId("announcement");node.textContent=message;node.className="announce"+(error?" error":"");byId("status").textContent=message};
const emptyGovernance=function(){return {policyVersion:"1",catalog:{reviewed:[],custom:[]},activations:[],authority:{approvals:[]},externalCuration:[],externalSelections:[]}};
const governance=function(){const value=state.policy.governance;return value&&value.policyVersion?value:Object.assign(emptyGovernance(),value||{})};
const ensureGovernance=function(){state.policy.governance=governance();return state.policy.governance};
const policyText=function(){return JSON.stringify(state.policy,null,2)+"\n"};
const validationError=function(path,message){return (path||"policy")+": "+message};
const schemaErrors=function(schema,value,path){
  const errors=[];const location=path||"policy";
  if(schema&&typeof schema==="object"&&Array.isArray(schema.oneOf)){const matches=schema.oneOf.filter(function(option){return schemaErrors(option,value,path).length===0}).length;if(matches!==1){errors.push(validationError(location,"must match exactly one schema variant"))}return errors}if(schema&&typeof schema==="object"&&Array.isArray(schema.anyOf)){const matches=schema.anyOf.filter(function(option){return schemaErrors(option,value,path).length===0}).length;if(matches===0){errors.push(validationError(location,"must match a schema variant"))}return errors}
  if(schema&&typeof schema==="object"&&Object.prototype.hasOwnProperty.call(schema,"const")&&value!==schema.const){errors.push(validationError(location,"must equal the required constant"));return errors}
  if(schema&&typeof schema==="object"&&Array.isArray(schema.enum)&&!schema.enum.includes(value)){errors.push(validationError(location,"must be one of "+schema.enum.join(", ")));return errors}
  if(!schema||typeof schema!=="object"||!schema.type){return errors}
  if(schema.type==="string"){if(typeof value!=="string"){errors.push(validationError(location,"must be a string"));return errors}if(schema.minLength!==undefined&&value.length<schema.minLength){errors.push(validationError(location,"is too short"))}if(schema.maxLength!==undefined&&value.length>schema.maxLength){errors.push(validationError(location,"is too long"))}if(schema.pattern!==undefined&&!new RegExp(schema.pattern,"u").test(value)){errors.push(validationError(location,"does not match its required pattern"))}return errors}
  if(schema.type==="number"){if(typeof value!=="number"||!Number.isFinite(value)){errors.push(validationError(location,"must be a finite number"))}return errors}
  if(schema.type==="boolean"){if(typeof value!=="boolean"){errors.push(validationError(location,"must be a boolean"))}return errors}
  if(schema.type==="array"){if(!Array.isArray(value)){errors.push(validationError(location,"must be an array"));return errors}if(schema.minItems!==undefined&&value.length<schema.minItems){errors.push(validationError(location,"has too few items"))}if(schema.maxItems!==undefined&&value.length>schema.maxItems){errors.push(validationError(location,"has too many items"))}if(schema.items){value.forEach(function(item,index){errors.push.apply(errors,schemaErrors(schema.items,item,location+"["+index+"]"))})}return errors}
  if(schema.type==="object"){if(!value||typeof value!=="object"||Array.isArray(value)){errors.push(validationError(location,"must be an object"));return errors}const object=value;const properties=schema.properties||{};(schema.required||[]).forEach(function(key){if(!Object.prototype.hasOwnProperty.call(object,key)){errors.push(validationError(location+"."+key,"is required"))}});Object.keys(object).forEach(function(key){const childPath=location+"."+key;if(schema.propertyNames){errors.push.apply(errors,schemaErrors(schema.propertyNames,key,childPath+" name"))}if(Object.prototype.hasOwnProperty.call(properties,key)){errors.push.apply(errors,schemaErrors(properties[key],object[key],childPath))}else if(schema.additionalProperties&&typeof schema.additionalProperties==="object"){errors.push.apply(errors,schemaErrors(schema.additionalProperties,object[key],childPath))}else{errors.push(validationError(childPath,"is not allowed"))}});return errors}
  return errors;
};
const safePolicyText=function(value,path,errors){if(typeof value!=="string"||value!==value.trim()||value.length<1||value.length>500||!/\S/u.test(value)||/\p{C}/u.test(value)){errors.push(validationError(path,"must be visible single-line text without hidden Unicode or surrounding whitespace"))}};
const safePath=function(value,path,errors){if(typeof value!=="string"||!value||value.startsWith("/")||value.startsWith("./")||value.includes("\\")||value.includes("//")||value.split("/").some(function(part){return !part||part==="."||part===".."})){errors.push(validationError(path,"must be a safe repo-relative POSIX path"))}};
const isoTime=function(value,path,errors){if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value))){errors.push(validationError(path,"must be an ISO-8601 timestamp"))}};
const sourceSemantics=function(source,path,errors){if(!source||typeof source!=="object"){return}if(source.type==="command"){(source.args||[]).forEach(function(argument,index){if(typeof argument!=="string"||argument.startsWith("/")||argument.startsWith("\\")||argument.includes("..")||/[\/;|&$<>\p{C}]/u.test(argument)||argument.includes(String.fromCharCode(96))){errors.push(validationError(path+".args["+index+"]","must be a safe relative argument"))}})}};
const candidateSemantics=function(candidate,path,collection,errors){if(!candidate||typeof candidate!=="object"){return}safePolicyText(candidate.description,path+".description",errors);(candidate.capabilities||[]).forEach(function(value,index){safePolicyText(value,path+".capabilities["+index+"]",errors)});(candidate.risks||[]).forEach(function(value,index){safePolicyText(value,path+".risks["+index+"]",errors)});if(candidate.clarification!==undefined){safePolicyText(candidate.clarification,path+".clarification",errors)}if(candidate.annotation!==undefined){safePolicyText(candidate.annotation,path+".annotation",errors)}const source=candidate.source||{};sourceSemantics(source,path+".source",errors);if(candidate.kind==="mcp"&&(source.type!=="mcp"&&source.type!=="stdio"&&source.type!=="remote")){errors.push(validationError(path+".source","MCP candidates require exact catalog, pinned stdio, or fenced remote identity"))}if(candidate.kind==="mcp"&&source.type==="mcp"&&candidate.id!==source.server){errors.push(validationError(path+".id","must match built-in MCP source.server"))}if(candidate.kind==="mcp"&&Array.isArray(candidate.targets)&&candidate.targets.some(function(target){return target!=="claude"&&target!=="kiro"})){errors.push(validationError(path+".targets","MCP candidates support Claude managed settings and Kiro workspace distribution only"))}if(candidate.kind==="hook"&&source.type!=="hook"){errors.push(validationError(path+".source","hook candidates require an AIH-owned hook identity"))}if(candidate.kind==="hook"&&source.type==="hook"&&candidate.id!==source.handler){errors.push(validationError(path+".id","must match AIH hook handler"))}if(candidate.kind==="framework"&&!candidate.framework){errors.push(validationError(path+".framework","is required for framework candidates"))}if(candidate.kind!=="framework"&&candidate.framework!==undefined){errors.push(validationError(path+".framework","is only valid for framework candidates"))}if(candidate.kind==="framework"&&(candidate.projector!=="framework-contract"||candidate.autoExecute||!Array.isArray(candidate.targets)||candidate.targets.length!==1||candidate.targets[0]!=="claude")){errors.push(validationError(path,"framework candidates must be Claude-only, non-autoexecuting framework-contract records"))}if(collection==="reviewed"&&source.type!=="mcp"&&source.type!=="hook"){errors.push(validationError(path+".source","reviewed candidates must reference AIH-shipped MCP or hook identities"))}if(collection==="custom"&&candidate.kind==="mcp"&&source.type!=="stdio"&&source.type!=="remote"){errors.push(validationError(path+".source","custom MCP candidates must use pinned stdio or fenced remote identity"))}if(collection==="custom"&&candidate.kind==="hook"){errors.push(validationError(path,"custom hooks are unsupported"))}};
const kiroTransportSemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}const catalog=governanceValue.catalog||{};["reviewed","custom"].forEach(function(collection){(catalog[collection]||[]).forEach(function(candidate,index){if(candidate&&candidate.kind==="mcp"&&candidate.source&&candidate.source.type==="remote"&&Array.isArray(candidate.targets)&&candidate.targets.includes("kiro")){errors.push(validationError("policy.governance.catalog."+collection+"["+index+"].targets","Kiro MCP projection supports stdio catalog entries only"))}})});return errors};
const policySemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;const registryIds=(model.catalog.hosts||[]).map(function(host){return host.id});if(policy&&policy.minimumPosture==="enterprise"&&(!governanceValue||typeof governanceValue!=="object"||!Array.isArray(governanceValue.supportedClis)||governanceValue.supportedClis.length===0)){errors.push(validationError("policy.governance.supportedClis","enterprise posture requires a non-empty explicit allow-list; current registry ids: "+registryIds.join(", ")+". Paste every id to sanction all supported CLIs; wildcard sentinels are not supported"))}if(!governanceValue||typeof governanceValue!=="object"){return errors}const supportedClis=Array.isArray(governanceValue.supportedClis)?governanceValue.supportedClis:[];if(new Set(supportedClis).size!==supportedClis.length){errors.push(validationError("policy.governance.supportedClis","supported CLI entries must be unique"))}const catalog=governanceValue.catalog||{};const reviewed=Array.isArray(catalog.reviewed)?catalog.reviewed:[];const custom=Array.isArray(catalog.custom)?catalog.custom:[];reviewed.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.reviewed["+index+"]","reviewed",errors)});custom.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.custom["+index+"]","custom",errors)});const candidates=reviewed.concat(custom);const ids=candidates.map(function(item){return item.id});if(new Set(ids).size!==ids.length){errors.push(validationError("policy.governance.catalog","candidate identifiers must be unique"))}const activations=Array.isArray(governanceValue.activations)?governanceValue.activations:[];const activeIds=activations.map(function(item){return item.candidate});if(new Set(activeIds).size!==activeIds.length){errors.push(validationError("policy.governance.activations","candidate decisions must be unique"))}activations.forEach(function(activation,index){const candidate=candidates.find(function(item){return item.id===activation.candidate});if(!candidate){errors.push(validationError("policy.governance.activations["+index+"]","references an unknown candidate"))}else if(Array.isArray(activation.targets)&&activation.targets.some(function(target){return !candidate.targets.includes(target)})){errors.push(validationError("policy.governance.activations["+index+"]","targets exceed candidate support"))}});const frameworks=activations.filter(function(activation){return activation.state==="active"&&candidates.some(function(candidate){return candidate.id===activation.candidate&&candidate.kind==="framework"})});if(frameworks.length>1){errors.push(validationError("policy.governance.activations","only one framework intent may be active"))}const approvals=governanceValue.authority&&Array.isArray(governanceValue.authority.approvals)?governanceValue.authority.approvals:[];if(new Set(approvals.map(function(item){return item.id})).size!==approvals.length){errors.push(validationError("policy.governance.authority.approvals","approval identifiers must be unique"))}approvals.forEach(function(approval,index){sourceSemantics(approval.source,"policy.governance.authority.approvals["+index+"].source",errors);isoTime(approval.notBefore,"policy.governance.authority.approvals["+index+"].notBefore",errors);isoTime(approval.expiresAt,"policy.governance.authority.approvals["+index+"].expiresAt",errors)});const curation=Array.isArray(governanceValue.externalCuration)?governanceValue.externalCuration:[];if(new Set(curation.map(function(item){return item.framework})).size!==curation.length){errors.push(validationError("policy.governance.externalCuration","framework records must be unique"))}curation.forEach(function(group,groupIndex){const itemKeys=(group.items||[]).map(function(item){safePolicyText(item.id,"policy.governance.externalCuration["+groupIndex+"].items id",errors);safePath(item.source&&item.source.path,"policy.governance.externalCuration["+groupIndex+"].items path",errors);safePolicyText(item.audit&&item.audit.record,"policy.governance.externalCuration["+groupIndex+"].items audit record",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.externalCuration["+groupIndex+"].items clarification",errors)}return item.kind+"\\u0000"+item.id});if(new Set(itemKeys).size!==itemKeys.length){errors.push(validationError("policy.governance.externalCuration["+groupIndex+"].items","kind/id pairs must be unique"))}});(policy.trust&&Array.isArray(policy.trust.baselineOverrides)?policy.trust.baselineOverrides:[]).forEach(function(item,index){safePath(item.bundle,"policy.trust.baselineOverrides["+index+"].bundle",errors);isoTime(item.approvedAt,"policy.trust.baselineOverrides["+index+"].approvedAt",errors)});return errors};
const policyTextSemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}if(governanceValue.policyVersion!==undefined){safePolicyText(governanceValue.policyVersion,"policy.governance.policyVersion",errors)}(governanceValue.activations||[]).forEach(function(item,index){if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.activations["+index+"].clarification",errors)}});const approvals=governanceValue.authority&&governanceValue.authority.approvals||[];approvals.forEach(function(item,index){safePolicyText(item.policyVersion,"policy.governance.authority.approvals["+index+"].policyVersion",errors);safePolicyText(item.reason,"policy.governance.authority.approvals["+index+"].reason",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.authority.approvals["+index+"].clarification",errors)}safePolicyText(item.github&&item.github.attestationId,"policy.governance.authority.approvals["+index+"].github.attestationId",errors)});return errors};
const policyProblems=function(){return schemaErrors(model.schema,state.policy,"").concat(policySemantics(state.policy),kiroTransportSemantics(state.policy),policyTextSemantics(state.policy))};
let policyValidator=policyProblems;
const commitPolicy=function(previous,message){const problems=policyValidator();if(problems.length){state.policy=previous;announce("Policy change rejected: "+problems.slice(0,3).join("; "),true);render();return false}announce(message);render();return true};
const candidateStatus=function(candidate){if(candidate.kind==="mcp"&&candidate.source&&candidate.source.type==="stdio"){return ["Blocked - evidence owed at this pin","blocked"]}const activation=governance().activations.find(function(item){return item.candidate===candidate.id});return activation&&activation.state==="active"?["Requested intent - runtime evaluation required","requested"]:["Disabled","pending"]};
/* The note sits inside the first cell so the status badge stays the row's first
   .badge, which is what the inventory contract reads as a row's status. */
/* The compact row keeps the selection control, exact identity, written state,
   and an explicit details action visible. No icon strip stands in for status:
   administrators should not have to learn a private visual legend. */
const compactState=function(kind,status){if(kind==="requested"){return "Selected"}if(kind==="blocked"){return "Blocked"}if(kind==="approval"){return "Approval"}if(kind==="availability"){return "Available"}if(kind==="pending"){return status.indexOf("Disabled")===0?"Disabled":"Awaiting"}if(kind==="external"){return status.indexOf("Selectable")===0?"Selectable":"External"}return "External"};
/* The visible label is the component id alone with its namespace dimmed: the
   group card already states the framework and the owner, so repeating them on
   every row is noise. The full title stays the drawer key and the accessible
   name. */
/* ECC's catalog carries no per-component description - a component is
   {id, paths, skillContent} and nothing else - so a per-name tooltip would have
   to be invented. These are kind-level and true of every member, which is the
   most that can be said without making prose up. Recorded as ECC_PR_01. */
const KIND_HELP={agent:"Source-authored agent metadata is required for this component.",
  skill:"Source-authored skill metadata is required for this component.",
  baseline:"A baseline component group the framework installs as a unit.",
  module:"An upstream ECC module. Any profile listing it includes it; selectable on its own.",
  lang:"A declarable language. ECC may declare reviewer and build-resolver agents alongside it.",
  framework:"A declarable framework. ECC may declare reviewer and web agents alongside it.",
  capability:"A capability bundle grouping related ECC components.",
  mcp:"ECC's declaration of an MCP server. Selecting AIH's own server is what makes one effective.",
  runtime:"A framework runtime surface: installer, plugin or steering directory."};
const ridLabel=function(label){const cut=String(label).indexOf(":");
  return cut===-1?esc(label):'<u>'+esc(String(label).slice(0,cut+1))+'</u>'+esc(String(label).slice(cut+1))};
/* The vet flag is deliberately not a second status badge. Selection state and
   scan verdict are different axes: a component AIH's analyzers blocked is still
   selectable, because the framework installs it and the governance decision is
   the administrator's to take. What changed is that they now take it knowing. */
const vetFlag=function(vet){if(!vet||vet.verdict!=="blocked")return "";
  const first=vet.findings[0];
  /* Not every analyzer reports an occurrence count, so the tally covers only the
     findings that carry one; inventing the rest would overstate the evidence. */
  const total=vet.findings.reduce(function(sum,f){return sum+(typeof f.count==="number"?f.count:0)},0);
  return '<span class="vet" data-vet="blocked" title="'+esc(first?first.detail:"")+'">'+esc(first?first.code:"blocked")+(total>1?"&#183;"+total:"")+'</span>'};
/* Read aloud, a blocked row must say what failed and who said so; the visual
   flag alone is a state assistive technology cannot reach. */
const vetNote=function(vet){if(!vet||vet.verdict!=="blocked")return "";
  return " Vet: blocked by "+vet.analyzers.map(function(a){return a.name}).join(", ")+" - "+
    vet.findings.map(function(f){return f.code+(typeof f.count==="number"?" ("+f.count+")":"")+": "+f.detail}).join("; ")+
    " Selecting it records intent; the finding is yours to accept or reject."};
/* The fulfillment consequence is a third axis layered on selection and vet
   verdict - what a governed projection would do with this exact component.
   Callers gate this on selection; an unselected row has nothing to state
   about materialization yet, and its existing "Selectable" status stays
   exactly as true as it always was (annotate, never duplicate; no new row,
   no new authoring path).
   MUST hold, checked on every edit here: asset.vet is AIH's own BUILD-TIME
   pin, produced once against a fixed tree hash. The materialization engine
   authorizes a component from the TARGET REPOSITORY's own RUNTIME evidence
   (src/ecc/materialization-selection.ts), which can and does diverge from the
   pin - a component this pin marks blocked is authorized there exactly like
   a plain pass once the target repository accepts the finding (with
   conditions); a component absent from the target's evidence excludes
   fail-closed regardless of what this pin says. Because the browser can never
   read that runtime state, EVERY branch below states only what the pin shows
   and defers the actual outcome to "the target repository's own engine
   evaluation" - never a fixed claim that something will or will not
   materialize. */
const FULFILLMENT_MATERIALIZES="materializes",FULFILLMENT_VET_BLOCKED="vetBlocked",FULFILLMENT_EVIDENCE_OWED="evidenceOwed";
/* One classifier, two callers (this note and the fulfillment tally below) -
   so an unexpected vet shape cannot render two different claims about the
   same component. Un-recognized input fails closed to evidenceOwed, the
   weakest claim, never to materializes; verdict is "pass" or "blocked"
   today, but the engine's own runtime outcome already has five, so nothing
   here may assume the pin's two values are exhaustive. */
const classifyFulfillment=function(vet){
  if(!vet)return FULFILLMENT_EVIDENCE_OWED;
  if(vet.verdict==="blocked")return FULFILLMENT_VET_BLOCKED;
  if(vet.verdict==="pass")return FULFILLMENT_MATERIALIZES;
  return FULFILLMENT_EVIDENCE_OWED;
};
const fulfillmentNote=function(framework,vet){
  const classification=classifyFulfillment(vet);
  if(classification===FULFILLMENT_VET_BLOCKED)return "Fulfillment: blocked at this pin - whether it materializes depends on the target repository's own engine evaluation of its evidence; accepting the finding is the path that can change it.";
  if(classification===FULFILLMENT_MATERIALIZES)return "Fulfillment: on aih policy project in a governed repository, AIH materializes this component directly, per-component and receipt-bound, and "+framework.id+" runs no installer for it - conditional on the target repository's own engine evaluation of its evidence.";
  return "Fulfillment: evidence is still owed at this pin - whether it materializes depends on the target repository's own engine evaluation of its evidence, once evidence exists to evaluate.";
};
const row=function(title,detail,status,kind,action,note,label,vet,attributes,sourceMark){
  const visibleLabel=label||title;const compact=compactState(kind,status);const compactMarkup=["Selected","Selectable","Disabled","Available"].indexOf(compact)!==-1?"":'<span class="row-state" title="'+esc(status)+'">'+esc(compact)+'</span>';
  return '<div class="row'+(kind==="requested"?" on":"")+'" data-state="'+esc(kind)+'"'+(vet?' data-vetted="'+esc(vet.verdict)+'"':"")+' data-row="'+esc(title)+'"'+(attributes||"")+'>'+
    (action||'<span class="tick" aria-hidden="true"></span>')+
    '<button type="button" class="rid" data-detail="'+esc(title)+'" aria-label="'+esc(visibleLabel+(sourceMark?" "+sourceMark:""))+'" title="'+esc(detail)+'"><strong>'+ridLabel(visibleLabel)+'</strong>'+(sourceMark?'<span class="source-mark">'+esc(sourceMark)+'</span>':"")+'</button>'+
    vetFlag(vet)+
    compactMarkup+
    '<button type="button" class="more" data-detail="'+esc(title)+'" aria-label="Details for '+esc(visibleLabel)+'"><span>Details</span></button>'+
    '<span class="badge '+kind+'">'+esc(status)+'</span>'+
    (note?'<p class="mono sr">'+esc(note)+'</p>':"")+
    '<span class="sr">'+esc(detail)+'</span>'+
    /* A full-width slot the enhancement block can append disclosures into. It
       used to append to the row's first element child, which is the tick in
       the compact row, so receipt detail landed inside a 24px button. */
    '<div class="row-slot"></div>'+
    '</div>'};
const PROVENANCE_PREFIX="Requested by: ";
/* Every origin that declared a control is kept, not just the first. An
   administrator who removes one reason must be able to see that another still
   holds the selection in place. */
const activationOrigins=function(activation){const text=String(activation&&activation.clarification||"");return text.indexOf(PROVENANCE_PREFIX)===0?text.slice(PROVENANCE_PREFIX.length).split(", ").filter(Boolean):[]};
const recordOrigin=function(activation,origin){const origins=activationOrigins(activation);if(origins.indexOf(origin)===-1){origins.push(origin)}activation.clarification=PROVENANCE_PREFIX+origins.join(", ")};
const controlProvenance=function(id){const activation=governance().activations.find(function(item){return item.candidate===id});const text=activation&&activation.clarification;return typeof text==="string"&&text.indexOf(PROVENANCE_PREFIX)===0?text:""};
const aihControls=function(){return [].concat(model.catalog.mcp.map(function(item){return item.control}),model.catalog.hooks.map(function(item){return item.control}))};
/* Hooks are AIH-owned and custom hooks are unsupported, so knowing exactly what
   runs is the administrator's whole affordance here. */
const hookDisclosure=function(hook){return "Fires on "+hook.behaviour.trigger+"; records "+hook.behaviour.records+" to "+hook.behaviour.artifact+". "+hook.behaviour.failureMode+". Projector "+hook.control.projector+", targets "+hook.control.targets.join(" and ")+", pinned script "+hook.control.source.scriptDigest+"."};
const frameworkAssetCount=function(){return model.catalog.frameworks.reduce(function(total,framework){return total+framework.assets.length},0)};
/* Returns false when the control is already authored, so callers stay idempotent
   instead of authoring the duplicate candidate ids the grammar rejects. */
const requestControl=function(g,control,origin){if(g.catalog.reviewed.some(function(item){return item.id===control.id})){const activation=g.activations.find(function(item){return item.candidate===control.id});if(activation){recordOrigin(activation,origin)}return false}g.catalog.reviewed.push({id:control.id,kind:control.kind,description:"AIH-provided governed control",capabilities:[],risks:[],source:control.source,targets:control.targets,projector:control.projector,lifecycle:control.lifecycle,evidence:{record:"aih-"+control.id}});g.activations.push({candidate:control.id,state:"active",targets:control.targets,clarification:PROVENANCE_PREFIX+origin});return true};
const toggleReviewed=function(id){const control=aihControls().find(function(item){return item.id===id});if(!control){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(activePreset==="vibe"||activePreset==="enterprise"){activePreset="custom"}const existing=g.catalog.reviewed.some(function(item){return item.id===id});if(!existing){requestControl(g,control,"administrator");commitPolicy(previous,"Requested intent added; it is not active until runtime evaluation.");return}const activation=g.activations.find(function(item){return item.candidate===id});const origins=activationOrigins(activation);const administrator=origins.indexOf("administrator");if(activation&&administrator!==-1&&origins.length>1){origins.splice(administrator,1);activation.clarification=PROVENANCE_PREFIX+origins.join(", ");commitPolicy(previous,"Administrator request removed; "+id+" remains requested by "+origins.join(", ")+".");return}g.catalog.reviewed=g.catalog.reviewed.filter(function(item){return item.id!==id});g.activations=g.activations.filter(function(item){return item.candidate!==id});commitPolicy(previous,"Requested intent removed; the exported policy no longer records "+id+".")};
/* Vibe selects every individually governable catalog component: every AIH
   control is requested and every framework-owned component is selected as requested
   intent. A selection carries the component's pinned source and no audit
   fields, so composing one invents no evidence - which is what kept this
   profile from offering the catalog while third-party rows were unselectable.
   External curation still needs an audit record and a digest, and no preset may
   author one. */
const composeVibeProfile=function(){const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const controls=aihControls();controls.forEach(function(control){requestControl(g,control,"vibe profile")});/* Bounded by the one-framework rule: Vibe composes every individually governable component in the framework
   already in play, or ECC when nothing is selected yet, and states what that
   leaves out rather than dropping it silently. */
const chosen=model.catalog.frameworks.find(function(item){return item.id===(activeSelectionFramework(g)||"ecc")})||model.catalog.frameworks[0];
  chosen.assets.forEach(function(asset){selectFrameworkAsset(g,chosen,asset)});
  const excluded=model.catalog.frameworks.filter(function(item){return item.id!==chosen.id}).reduce(function(total,item){return total+item.assets.length},0);
  state.policy.minimumPosture="vibe";
/* Report the resulting selection, never the delta: composing over an existing
   selection adds nothing for what is already held, and a delta reads as though
   the rest were left out. */
const selected=g.externalSelections.reduce(function(total,group){return total+group.items.length},0);commitPolicy(previous,"Vibe composed: "+controls.length+" AIH control(s) requested and "+selected+" of "+chosen.assets.length+" "+chosen.id+" component(s) selected as requested intent with their pinned sources - "+chosen.id+" installs and runs them, AIH records them. A policy selects from only one framework at a time, so "+excluded+" component(s) in the other framework stay listed and unselected. No audit evidence was authored; each selection still owes its own. "+g.catalog.custom.length+" custom candidate(s) stay blocked. Requested intent is not effective until runtime evaluation in a target repository.")};
/* Enterprise requests the same enforceable set Vibe does - that set is the whole
   of what AIH projects - and selects ECC Core. Its language and security parts
   are deliberately left unselected: the contract says Enterprise exposes Core
   "and additive choices", and its acceptance journey has the administrator
   select languages and add security, which is only demonstrable if the posture
   does not pre-select them. */
const compositionPartIds=function(selection){return model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection===selection}).reduce(function(total,part){return total+part.componentIds.length},0)};
const eccFramework=function(){return model.catalog.frameworks.find(function(item){return item.id===model.catalog.enterpriseComposition.framework})};
/* Selecting a named component authors the identical record a row click does,
   through the one shared function, so a composition can never author a shape
   the inventory cannot also produce or reverse. */
const selectCompositionPart=function(g,part){const framework=eccFramework();if(!framework){return 0}let added=0;part.componentIds.forEach(function(id){const asset=framework.assets.find(function(item){return item.id===id});if(asset&&selectFrameworkAsset(g,framework,asset)){added++}});return added};
const composeEnterpriseProfile=function(){const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}g.supportedClis=(model.catalog.hosts||[]).map(function(host){return host.id});const controls=aihControls();controls.forEach(function(control){requestControl(g,control,"enterprise profile")});const composed=model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection==="composed"});composed.forEach(function(part){selectCompositionPart(g,part)});state.policy.minimumPosture="enterprise";const core=composed.reduce(function(total,part){return total+partSelectedCount(part)},0);const additive=model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection==="additive"});commitPolicy(previous,"Enterprise composed: "+controls.length+" AIH control(s) requested and "+core+" ECC Core component(s) selected as requested intent. "+compositionPartIds("additive")+" further component(s) are offered as additive choices ("+additive.map(function(part){return part.label+" "+part.componentIds.length}).join(", ")+") and are yours to add. "+(frameworkAssetCount()-compositionNamedCount())+" further framework-owned component(s) stay selectable in the inventory. ECC installs and runs all of them; AIH records them. No audit evidence was authored. All "+g.supportedClis.length+" registry CLIs are explicitly sanctioned; requested intent is not effective until runtime evaluation in a target repository.")};
/* Every argument comes off the row itself: evidence vet-baseline takes an
   owner/repo source, an exact 40-character pin, a catalog id and component ids,
   and the pinned catalog supplies all four. Deriving it is what keeps this from
   being the fabricated next action row 16 ruled against. */
const evidenceCommand=function(framework,asset){return "aih evidence vet-baseline "+framework.repository+" --pin "+framework.commit+" --catalog "+framework.id+" --components "+asset.id+" --apply"};
const frameworkAsset=function(frameworkId,id){const framework=model.catalog.frameworks.find(function(item){return item.id===frameworkId});if(!framework){return null}const asset=framework.assets.find(function(item){return item.id===id});return asset?{framework:framework,asset:asset}:null};
/* A valid policy document may omit this array, because the grammar defaults it
   and this surface validates against the JSON Schema instead of running Zod, so
   an imported document arrives exactly as written. Reading through an accessor
   honours that default rather than crashing on a legitimate import. */
const externalSelectionGroups=function(){const groups=governance().externalSelections;return Array.isArray(groups)?groups:[]};
const selectedItems=function(frameworkId){const group=externalSelectionGroups().find(function(item){return item.framework===frameworkId});return group?group.items:[]};
const isFrameworkSelected=function(frameworkId,id){return selectedItems(frameworkId).some(function(item){return item.id===id})};
/* isFrameworkSelected() matches on id alone - the same matching the existing
   tick and badge already use, and changing that shared, widely-used
   semantics is out of this row's scope. The fulfillment layer needs one more
   bit before it may name a consequence: whether the selected entry's OWN
   kind agrees with the catalog's kind for that id. A selection whose kind
   and id disagree is exactly what the materialization engine refuses as
   malformed (src/ecc/materialization-selection.ts, "selection kind ...
   does not match component id ..."), so this layer states none of the three
   fulfillment claims for it - asserting any one of them would overstate what
   is actually true. */
const selectedAssetAuthorizable=function(frameworkId,asset){
  const item=selectedItems(frameworkId).find(function(entry){return entry.id===asset.id});
  return item!==undefined&&item.kind===asset.kind;
};
/* Ownership annotates a row; it never disables one. Selecting records requested
   intent with the component's pinned source as provenance - ECC and Superpowers
   install and run these, and AIH only records that they were asked for. Evidence
   is the separate axis, which is why every kind is selectable while only three
   are expressible as curation items. */
const curatedFrameworkIds=function(g,frameworkId){const group=g.externalCuration.find(function(item){return item.framework===frameworkId});return group?group.items.map(function(item){return item.id}):[]};
/* Returns false when the component is already selected or already carries
   curation evidence, so the click path and a preset author the identical record
   and neither downgrades a curated component to a bare selection. A curated
   component already holds its audit record and digest; the grammar rejects a
   component that sits in both. */
/* A policy holds one framework at a time. The grammar already says so for
   framework activations; selections are the same choice one level down, and a
   surface that let you pick from both would author a policy the grammar
   rejects. The other framework stays fully listed - this bounds selection, it
   never hides inventory. */
const activeSelectionFramework=function(g){const group=(g.externalSelections||[]).find(function(item){return item.items.length});return group?group.framework:null};
const selectionConflict=function(g,frameworkId){const active=activeSelectionFramework(g);return active&&active!==frameworkId?active:null};
const selectFrameworkAsset=function(g,framework,asset){if(selectionConflict(g,framework.id)){return false}if(curatedFrameworkIds(g,framework.id).indexOf(asset.id)!==-1){return false}let group=g.externalSelections.find(function(item){return item.framework===framework.id});if(group&&group.items.some(function(item){return item.id===asset.id})){return false}if(!group){group={framework:framework.id,items:[]};g.externalSelections.push(group)}group.items.push({kind:asset.kind,id:asset.id,source:{repository:asset.source.repository,commit:asset.source.commit,path:asset.source.path}});return true};
const selectedDeclarationRequires=function(group,framework,riderId,excludedId){return Boolean(group&&group.items.some(function(item){if(item.id===excludedId){return false}const asset=framework.assets.find(function(candidate){return candidate.id===item.id});return Boolean(asset&&asset.riders&&asset.riders.indexOf(riderId)!==-1)}))};
const enterpriseCoreComplete=function(){const composition=model.catalog.enterpriseComposition;return composition.parts.filter(function(part){return part.selection==="composed"}).every(function(part){return partSelectedCount(part)===part.componentIds.length})};
const manualCompositionChange=function(){const wasCoreComplete=enterpriseCoreComplete();if(activePreset==="vibe"||activePreset==="enterprise"){activePreset="custom"}return wasCoreComplete};
const compositionBreakNotice=function(wasCoreComplete){return wasCoreComplete&&!enterpriseCoreComplete()?" ECC Core is incomplete and no longer matches the Enterprise preset; dependent Core behavior will not work until Core is restored.":""};
const toggleFrameworkSelection=function(key){const parts=String(key).split("|");const found=frameworkAsset(parts[0],parts[2]);if(!found){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const group=g.externalSelections.find(function(item){return item.framework===found.framework.id});if(group&&group.items.some(function(item){return item.id===found.asset.id})){const requiredBy=group.items.find(function(item){if(item.id===found.asset.id){return false}const asset=found.framework.assets.find(function(candidate){return candidate.id===item.id});return Boolean(asset&&asset.riders&&asset.riders.indexOf(found.asset.id)!==-1)});if(requiredBy){announce(found.asset.id+" cannot be deselected while "+requiredBy.id+" requires it. Deselect the declaration first.",true);render();return}const wasEnterpriseComplete=manualCompositionChange();const riders=found.asset.riders||[];explicitFrameworkSelections.delete(frameworkSelectionIntentKey(found.framework.id,found.asset.id));group.items=group.items.filter(function(item){const declaredHere=riders.indexOf(item.id)!==-1;const independent=explicitFrameworkSelections.has(frameworkSelectionIntentKey(found.framework.id,item.id));return item.id!==found.asset.id&&!(declaredHere&&!independent&&!selectedDeclarationRequires(group,found.framework,item.id,found.asset.id))});if(!group.items.length){g.externalSelections=g.externalSelections.filter(function(item){return item.framework!==found.framework.id})}const removedRiders=riders.filter(function(id){return !isFrameworkSelected(found.framework.id,id)});removedRiders.forEach(function(id){explicitFrameworkSelections.delete(frameworkSelectionIntentKey(found.framework.id,id))});commitPolicy(previous,"Deselected "+found.asset.id+" and "+removedRiders.length+" declared rider(s); the exported policy no longer records them. General ECC skills and modules are independent and unchanged."+compositionBreakNotice(wasEnterpriseComplete));return}const conflict=selectionConflict(g,found.framework.id);
  if(conflict){state.policy=previous;announce("A policy selects from only one framework at a time, and "+conflict+" is already selected. Clear the policy, or deselect the "+conflict+" items, before selecting from "+found.framework.id+".",true);render();return}
  const previousPreset=activePreset;const wasEnterpriseComplete=manualCompositionChange();if(!selectFrameworkAsset(g,found.framework,found.asset)){state.policy=previous;activePreset=previousPreset;announce(found.asset.id+" already carries curation evidence; remove that record first to hold it as a bare selection.",true);render();return}let added=0;let blockedRider=null;(found.asset.riders||[]).some(function(id){const rider=frameworkAsset(found.framework.id,id);if(!rider){blockedRider=id;return true}if(isFrameworkSelected(rider.framework.id,rider.asset.id)){return false}if(!selectFrameworkAsset(g,rider.framework,rider.asset)){blockedRider=id;return true}added++;return false});if(blockedRider){state.policy=previous;activePreset=previousPreset;announce("Selection blocked: declared rider "+blockedRider+" cannot be authored alongside its existing curation or framework state; nothing changed.",true);render();return}explicitFrameworkSelections.add(frameworkSelectionIntentKey(found.framework.id,found.asset.id));commitPolicy(previous,"Selected "+found.asset.id+" with "+added+" declared rider(s): requested intent recorded with pinned sources. General ECC skills and modules are independent and unchanged."+compositionBreakNotice(wasEnterpriseComplete))};
/* The inventory is grouped by the catalog's own namespaces, the way the accepted
   artifact groups it, so 151 components read as a structure rather than a list. */
const GROUP_LABEL={lang:"Languages",framework:"Frameworks",capability:"Capabilities",
  module:"ECC modules",baseline:"ECC baselines",agent:"ECC agents",skill:"ECC skills",
  runtime:"ECC runtime"};
/* Lucide static 1.37.0 icons, ISC. Inlined so the generated Workbench stays standalone. */
const CONCEPT_ICONS={
  mcp:'<svg class="lucide lucide-plug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/></svg>',
  hook:'<svg class="lucide lucide-anchor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v16"/><path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/><path d="M9 11h6"/><circle cx="12" cy="4" r="2"/></svg>',
  skill:'<svg class="lucide lucide-blocks" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/></svg>',
  agent:'<svg class="lucide lucide-bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  runtime:'<svg class="lucide lucide-zap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.914 4a1.5 1.5 0 0 0-2.474-1.561l-9 9A1.5 1.5 0 0 0 5.5 14h4.002a.5.5 0 0 1 .471.666L8.086 20a1.5 1.5 0 0 0 2.475 1.56l9-9A1.5 1.5 0 0 0 18.5 10h-3.997a.5.5 0 0 1-.472-.667z"/></svg>',
  core:'<svg class="lucide lucide-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>'};
const conceptForGroup=function(label){const text=String(label||"").trim().toLowerCase();if(text.indexOf("mcp")!==-1){return "mcp"}if(text.indexOf("hook")!==-1){return "hook"}if(text.indexOf("skill")!==-1){return "skill"}if(text.indexOf("agent")!==-1){return "agent"}if(text==="ecc runtime"){return "runtime"}if(text==="ecc baselines"){return "core"}return null};
const decorateConceptHeaders=function(){document.querySelectorAll("section.grp > .grphead h2").forEach(function(heading){const concept=conceptForGroup(heading.textContent);const existing=heading.querySelector(".concept-icon");if(!concept){if(existing){existing.remove()}heading.classList.remove("concept-heading");return}if(existing&&existing.getAttribute("data-concept")===concept){return}if(existing){existing.remove()}heading.classList.add("concept-heading");heading.insertAdjacentHTML("afterbegin",'<span class="concept-icon" data-concept="'+concept+'" aria-hidden="true">'+CONCEPT_ICONS[concept]+"</span>")})};
const assetGroup=function(framework,asset){return framework.id==="superpowers"?"Superpowers":(GROUP_LABEL[asset.kind]||asset.kind)};
const openGroups={};
const frameworkSelectionRowId=function(key){return "framework-row-"+encodeURIComponent(String(key)).replace(/%/g,"_")};
/* The line break after button is intentional: older row rendering tries to
   inject disabled by replacing the literal "<button ". A selected control
   must remain its own inverse, so no rendered tick exposes that match. */
const tick=function(attr,key,selected,label){return '<button\n type="button" class="tick" '+attr+'="'+esc(key)+'" aria-pressed="'+(selected?"true":"false")+'" aria-label="'+(selected?"Deselect ":"Select ")+esc(label)+'">&#10003;</button>'};
const frameworkGroups=function(){const groups=[];const index={};
  model.catalog.frameworks.forEach(function(framework){framework.assets.forEach(function(asset){
    if(framework.id==="ecc"&&(asset.kind==="skill"||asset.kind==="mcp")){return}
    const label=assetGroup(framework,asset);
    if(!index[label]){index[label]={label:label,framework:framework.id,owner:framework.id==="superpowers"?"Superpowers":"ECC",rows:[]};groups.push(index[label])}
    index[label].rows.push({framework:framework,asset:asset})})});
  return groups};
const frameworkInventoryRow=function(framework,asset,attributes){
  const selectionKey=framework.id+"|"+asset.kind+"|"+asset.id;
  const selected=isFrameworkSelected(framework.id,asset.id);
  const purpose=asset.metadata?asset.metadata.summary:(KIND_HELP[asset.kind]||"A framework-owned component.");
  /* Fulfillment is stated only once selected, and only when the selected
     entry's own kind agrees with the catalog's kind for this id. */
  const fulfillment=selected&&selectedAssetAuthorizable(framework.id,asset)?fulfillmentNote(framework,asset.vet):"";
  return row(framework.id+" / "+asset.kind+": "+asset.id,
    purpose+" By default, "+framework.id+" installs and runs it; AIH records the selection with its pinned source."+(asset.riders&&asset.riders.length?" Declares "+asset.riders.length+" rider(s): "+asset.riders.join(", ")+".":""),
    selected?"Selected - requested intent recorded":"Selectable - "+framework.id+" installs and runs it",
    selected?"requested":"external",
    tick("data-framework-select",selectionKey,selected,asset.id),
    "Owned by "+framework.repository+" at "+framework.commit+", source "+asset.source.path+"."+(asset.riders&&asset.riders.length?" Also brings in "+asset.riders.join(", ")+".":"")+" Evidence: "+evidenceCommand(framework,asset)+(asset.vet?" Already vetted at this pin by "+asset.vet.analyzers.map(function(a){return a.name+" "+a.version}).join(", ")+"; tree "+asset.vet.treeSha256.slice(0,12)+".":"")+vetNote(asset.vet)+(fulfillment?" "+fulfillment:""),
    asset.id,asset.vet,' id="'+esc(frameworkSelectionRowId(selectionKey))+'" data-framework-selection-row="'+esc(selectionKey)+'"'+(attributes||""))};
/* Once a framework is chosen the other one's groups come out of the plane: a
   policy that cannot select them should not present them as inventory to work
   through. Nothing is lost silently - the count and the way back are stated,
   and Clear restores the full catalog. */
const frameworkInventoryRows=function(){const active=activeSelectionFramework(governance());
  const all=frameworkGroups();const shown=all.filter(function(group){return !active||group.framework===active});
  const hiddenMcp=active&&active!=="ecc"?(eccFramework()?eccFramework().assets.filter(function(asset){return asset.kind==="mcp"}).length:0):0;
  const hidden=all.length-shown.length+(hiddenMcp?1:0);
  const hiddenRows=all.filter(function(group){return active&&group.framework!==active}).reduce(function(total,group){return total+group.rows.length},0)+hiddenMcp;
  const notice=hidden?'<section class="gcard" data-framework-notice><p class="grpnote">A policy selects from one framework at a time, and <b>'+esc(active)+'</b> is selected. The other framework’s <b>'+hiddenRows+'</b> component(s) in '+hidden+' group(s) are not shown while it is. Use <b>Clear</b> to start over and choose the other one.</p></section>':"";
  return shown.map(function(group){
  const open=openGroups[group.label]?1:0;
  const rows=group.rows.map(function(entry){return frameworkInventoryRow(entry.framework,entry.asset)}).join("");
  return '<section class="gcard grp group" data-owner="'+esc(group.owner)+'" data-open="'+open+'" data-groupcard><button type="button" class="grphead" data-group aria-expanded="'+(open?"true":"false")+'"><span class="tw" aria-hidden="true">&#9654;</span><h2>'+esc(group.label)+'</h2><span class="own">'+esc(group.owner)+'</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody">'+rows+'</div></section>'}).join("")+notice};
/* A pinned custom candidate must name the published package it actually vets.
   The tarball is the exact content pin; a source checkout cannot stand in for it. */
const customNextAction=function(item){const source=item.source||{};return "Next: save this policy as aih-org-policy.json in the target repository, then run aih trust scan "+source.package+String.fromCharCode(64)+source.version+". AIH fetches and scans that pinned npm tarball, verifies "+source.integrity+", and emits preflight evidence record "+item.evidence.record+" bound to candidate "+item.id+". The current fence is mandatory-detector-failed; it remains blocked until an independently attested authority receipt carries that exact record."};
const hookRegistryRowsMarkup=function(){const reg=model.catalog.hookRegistry;return reg.entries.map(function(e){const label=e.owner==="aih"?"AIH-owned":"Third party - owned by "+e.ownerLabel;const enforce=e.enforcement==="aih-enforced"?"AIH-enforced":"Not AIH-enforced - the source installs and runs it; AIH registers and revokes the entry";return "<div class=\"hookreg\"><p><b>"+esc(e.id)+"</b> &mdash; "+esc(label)+"</p>"+"<p class=\"help\">"+esc(e.description)+"</p>"+"<p class=\"help\">Source: "+esc(e.source)+"</p>"+"<p class=\"help\">"+esc(enforce)+".</p><p class=\"help\">Counted under "+esc(e.ownerLabel)+" on its own inventory row. Authored there, not here — this information view is read-only.</p></div>"}).join("")};
const hookRegistryControlsMarkup=function(){const controls=model.catalog.hookRegistry.declaredControls;return controls.length?controls.map(function(c){return "<p class=\"help\"><code>"+esc(c.name)+"</code> (declared by "+esc(c.owner)+", not owned by AIH): "+esc(c.detail)+"</p>"}).join(""):"<p class=\"help\">No third-party hook controls declared.</p>"};
const hookRegistryOverlapsMarkup=function(){const overlaps=model.catalog.hookRegistry.overlaps;return overlaps.length?overlaps.map(function(o){return "<p class=\"help\">Overlap on <code>"+esc(o.event)+"</code> / <code>"+esc(o.functionTag)+"</code> between "+esc(o.owners.join(" and "))+". AIH reports it and does not resolve it; you decide.</p>"}).join(""):"<p class=\"help\">No overlap between the selected hooks. AIH never merges an overlap on your behalf: silent merging causes capability loss that cannot be diagnosed from the resulting configuration.</p>"};
const hookRegistrySpawnsMarkup=function(){const reg=model.catalog.hookRegistry;return reg.spawnProjection.events.map(function(ev){return "<p class=\"help\"><code>"+esc(ev.event)+"</code>: "+ev.entries+" entries, "+ev.spawns+" expected process spawns (nested launcher spawns included).</p>"}).join("")+"<p class=\"help\">Total: "+reg.spawnProjection.totalEntries+" entries, "+reg.spawnProjection.totalSpawns+" process spawns per full firing. A hook a source reports as disabled still spawns a process: that control is read inside the launcher, after the process exists ("+reg.spawnProjection.sourceDisabledSpawns+" spawns here)."+(reg.entries.some(function(e){return e.owner!=="aih"})?" The pinned catalog carries third-party hook components with provenance but no per-hook registration table, so these counts cover only the registrations recorded here — a small number is not a complete one.":"")+"</p>"};
const hookRegistryInformationMarkup=function(){return '<div class="governance-info"><div class="cap">Hook registration and runtime information</div><p class="note">Only AIH-owned governance and telemetry identities are authorable here. Custom hooks are not supported. AIH registers and revokes hook entries in client-native configuration; each named owner remains the executor. Third-party commands are preserved byte-for-byte and are never interpreted or run by this Workbench. Registrations are authored in <code>governance.hookRegistrations</code>, not in this information view.</p><div class="cap">Registered entries</div><div class="hook-registry-rows">'+hookRegistryRowsMarkup()+'</div><details class="subsect"><summary>Third-party controls, recorded read-only</summary><div class="hook-registry-controls">'+hookRegistryControlsMarkup()+'</div></details><details class="subsect"><summary>Overlaps</summary><div class="hook-registry-overlaps">'+hookRegistryOverlapsMarkup()+'</div></details><details class="subsect"><summary>Entries and process spawns</summary><div class="hook-registry-spawns">'+hookRegistrySpawnsMarkup()+'</div></details></div>'};
const renderHookRegistry=function(){byId("hook-registry-rows").innerHTML=hookRegistryRowsMarkup();byId("hook-registry-controls").innerHTML=hookRegistryControlsMarkup();byId("hook-registry-overlaps").innerHTML=hookRegistryOverlapsMarkup();byId("hook-registry-spawns").innerHTML=hookRegistrySpawnsMarkup()};
const eccMcpInventoryRow=function(item){const approval=item.owner==="ecc";const hasAihControl=model.catalog.mcp.some(function(control){return control.id===item.id});const detail=item.description+" Transport "+item.transport+", supply "+item.supply+", addability "+item.addability+". This row does not install, contact, scan, attest, or claim reachability.";return row("ECC MCP: "+item.id,detail,approval?"Approval authoring available — not installed":hasAihControl?"Available — represented by the shared AIH control":"Available — no AIH control in this build",approval?"approval":"availability",approval?'<button type="button" class="btn sm" data-ecc-mcp-approval="'+esc(item.id)+'">Open approval</button>':"",approval?"ECC declares this at its pinned source; AIH records only a separately authored approval.":"ECC assigns this entry to AIH. This source view does not create an AIH control.",item.id,undefined,' data-ecc-mcp-availability="'+esc(item.id)+'" data-ecc-mcp-provenance="only"',approval?"":"ECC availability only")};
const aihMcpInventoryRows=function(g){const controls=model.catalog.mcp.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];const declaration=model.catalog.eccMcpInventory.find(function(candidate){return candidate.owner==="aih"&&candidate.id===item.id});const detail=item.description+(declaration?" ECC also declares this identity with transport "+declaration.transport+", supply "+declaration.supply+", and addability "+declaration.addability+".":"");const provenance=controlProvenance(item.id)+(declaration?(controlProvenance(item.id)?" ":"")+"ECC source provenance is preserved on this shared row; it does not create a second control.":"");const attributes=declaration?' data-ecc-mcp-availability="'+esc(item.id)+'" data-ecc-mcp-provenance="shared"':"";return row(item.id,detail,status[0],status[1],tick("data-reviewed",item.id,Boolean(existing),item.id).replace("<button ",existing?"<button disabled ":"<button "),provenance,undefined,undefined,attributes,declaration?"Also declared by ECC":"")});const availabilityOnly=model.catalog.eccMcpInventory.filter(function(item){return item.owner==="aih"&&!model.catalog.mcp.some(function(control){return control.id===item.id})}).map(eccMcpInventoryRow);return controls.concat(availabilityOnly).join("")};
const renderEccMcpInventory=function(){const framework=eccFramework();const active=activeSelectionFramework(governance());const declarations=framework?framework.assets.filter(function(asset){return asset.kind==="mcp"}):[];byId("ecc-mcp-declaration-rows").innerHTML=active&&active!=="ecc"?'<p class="help">ECC declarations are unavailable while '+esc(active)+' is selected. Clear the policy to choose ECC instead.</p>':declarations.map(function(asset){return frameworkInventoryRow(framework,asset)}).join("");byId("ecc-mcp-rows").innerHTML=model.catalog.eccMcpInventory.filter(function(item){return item.owner==="ecc"}).map(eccMcpInventoryRow).join("")};
const renderEccSkillInventory=function(){const framework=eccFramework(),host=byId("ecc-skill-rows"),existing=[].slice.call(host.querySelectorAll("[data-ecc-skill-availability]"));if(existing.length===model.catalog.eccSkills.length){model.catalog.eccSkills.forEach(function(skill){if(!skill.governable){return}const asset=framework&&framework.assets.find(function(candidate){return candidate.id==="skill:"+skill.id});const node=existing.find(function(candidate){return candidate.getAttribute("data-ecc-skill-availability")===skill.id});if(!asset||!node){throw new Error("governable ECC skill row is malformed: "+skill.id)}node.outerHTML=frameworkInventoryRow(framework,asset,' data-ecc-skill-availability="'+esc(skill.id)+'"')});return}host.innerHTML=model.catalog.eccSkills.map(function(skill){const asset=framework&&framework.assets.find(function(candidate){return candidate.id==="skill:"+skill.id});if(skill.governable&&!asset){throw new Error("governable ECC skill is absent from the policy catalog: "+skill.id)}if(skill.governable&&asset){return frameworkInventoryRow(framework,asset,' data-ecc-skill-availability="'+esc(skill.id)+'"')}return row("ECC skill: "+skill.id,skill.summary+" Usage context: "+skill.usageContext+" Source: "+skill.path+". It is not an individually governable policy component.","Available — not individually governable","availability","","Availability only: this row cannot author policy and makes no installation, materialization, evidence, or support claim.","skill:"+skill.id,undefined,' data-ecc-skill-availability="'+esc(skill.id)+'"')}).join("")};
const capabilityPackageRoots=function(){const selection=state.policy.capabilityPackages;return selection&&Array.isArray(selection.roots)?selection.roots:[]};
const renderAihCapabilities=function(){const roots=capabilityPackageRoots();const render=function(items,kind){return items.map(function(item){const selected=roots.indexOf(item.id)!==-1;const execution=kind==="Agent"?"Isolated worker required; selection does not launch it.":"Runs with the active task context.";const display=item.skills.join(", ");return row(item.skills.join(", "),item.description+" Pack: "+item.pack+". "+execution,selected?"Selected — target authority required":"Selectable — package intent only",selected?"requested":"external",tick("data-aih-capability-package",item.id,selected,display),"Capability package root "+item.id+". AIH manages its first-party package source; exact lock, promotion evidence, and custody are still required.",display)}).join("")};byId("aih-skill-rows").innerHTML=render(model.catalog.aihSkills,"Skill");byId("aih-agent-rows").innerHTML=render(model.catalog.aihAgents,"Agent")};
const renderRows=function(){const g=governance();renderAihCapabilities();byId("mcp-rows").innerHTML=aihMcpInventoryRows(g);byId("hook-rows").innerHTML=model.catalog.hooks.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];const provenance=controlProvenance(item.id);return row(item.id,item.description,status[0],status[1],tick("data-reviewed",item.id,Boolean(existing),item.id).replace("<button ",existing?"<button disabled ":"<button "),hookDisclosure(item)+(provenance?" "+provenance:""))}).join("");byId("custom-rows").innerHTML=g.catalog.custom.length?g.catalog.custom.map(function(item){const status=candidateStatus(item);return row(item.id,"Pinned custom source - no activation affordance",status[0],status[1],"",customNextAction(item))}).join(""):"<p class=\"help\">No custom candidates.</p>";byId("curation-rows").innerHTML=g.externalCuration.length?g.externalCuration.flatMap(function(group){return group.items.map(function(item){return row(group.framework+": "+item.kind+" / "+item.id,"Audit "+item.audit.record+" - report-only", "External guidance - not enforced","external")})}).join(""):"<p class=\"help\">No external curation intent.</p>";byId("framework-rows").innerHTML=frameworkInventoryRows();renderEccMcpInventory();renderEccSkillInventory();renderHookRegistry()};
const compositionNamedCount=function(){return model.catalog.enterpriseComposition.parts.reduce(function(total,part){return total+part.componentIds.length},0)};
const partSelectedCount=function(part){const ids=selectedItems(model.catalog.enterpriseComposition.framework).map(function(item){return item.id});return part.componentIds.filter(function(id){return ids.indexOf(id)!==-1}).length};
const renderEccMcpApprovals=function(){const entries=model.catalog.externalMcp||[];const g=governance();const approvals=Array.isArray(g.eccMcpApprovals)?g.eccMcpApprovals:[];const select=byId("ecc-mcp-id");const prior=select.value;select.innerHTML='<option value="">Choose pinned ECC MCP</option>'+entries.map(function(item){return '<option value="'+esc(item.id)+'">'+esc(item.id+' — '+item.addability)+'</option>'}).join("");select.value=entries.some(function(item){return item.id===prior})?prior:"";byId("ecc-mcp-approval-rows").innerHTML=approvals.length?approvals.map(function(item){return '<p class="help"><code>'+esc(item.id)+'</code> — '+esc(item.state)+'; '+esc(item.authenticationMode)+'. <button type="button" class="btn sm" data-ecc-mcp-approval-remove="'+esc(item.id)+'">Remove approval</button></p>'}).join(""):"<p class=\"help\">No ECC MCP approvals recorded.</p>"};
const adoptionRouteText=function(route){if(route.kind==="workbench-row"){return "Existing Workbench row: "+route.candidate}if(route.kind==="ecc-mcp-approval"){return "ECC MCP approval for "+route.id+", then configure its "+route.addability+" entry"}if(route.kind==="aih-ecc-profile-lifecycle"){return "AIH ECC profile lifecycle: "+route.command}return "No route"};
const renderAdoptionRecipe=function(){const recipe=model.adoptionRecipe;byId("adoption-recipe-roles").innerHTML=recipe.roles.map(function(role){const usage=role.usage.kind==="mcp-server-event"?"MCP server event: "+role.usage.serverId:"none captured";return '<article class="adoption-role" data-adoption-role="'+esc(role.id)+'"><strong>'+esc(role.label)+'</strong><p>'+esc(role.guidance)+'</p><p class="adoption-route"><b>Prerequisites:</b> '+esc(role.prerequisites.join("; "))+'</p><p class="adoption-route"><b>Overlap / conflict:</b> '+esc(role.conflicts.join("; "))+'</p><p class="adoption-route"><b>Next action:</b> '+esc(adoptionRouteText(role.route))+'</p><p class="adoption-route"><b>Usage / coverage:</b> '+esc(usage)+'</p></article>'}).join("")};
const renderComposition=function(){const composition=model.catalog.enterpriseComposition;byId("composition-parts").innerHTML='<p class="help">Every component below is owned by '+esc(composition.framework)+', which installs and runs it; AIH records the selection with its pinned source. Choosing Enterprise selects the Core parts. The additive parts are yours to add, here or from any inventory row.</p>'+composition.parts.map(function(part){const selected=partSelectedCount(part);const complete=selected===part.componentIds.length;const action=part.selection==="additive"?'<button type="button" data-composition-add="'+esc(part.id)+'">'+(complete?"Remove these":"Add these")+'</button>':"";return '<div class="row"><div><strong>'+esc(part.label)+'</strong><p>Derived from '+esc(part.rule)+'.</p><p class="mono">'+esc(part.componentIds.join(" "))+'</p></div><span class="badge '+(complete?"requested":"external")+'">'+esc(selected+" of "+part.componentIds.length+" selected"+(part.selection==="additive"?" - additive":" - Core"))+'</span>'+action+'</div>'}).join("")};
const renderReceipt=function(){const receipt=state.receipt;const rows=[];if(receipt&&Array.isArray(receipt.approvals)){receipt.approvals.forEach(function(item){rows.push(row(item.id||"approval",(item.issuer||"unknown issuer")+" — preserved/preflight-only", "Not verified / not effective","pending"))})}if(receipt&&Array.isArray(receipt.evidence)){receipt.evidence.forEach(function(item){rows.push(row(item.id||"evidence",(item.state||"unknown")+" evidence — preserved/preflight-only", "Not verified / not effective","pending"))})}byId("approval-rows").innerHTML=rows.length?rows.join(""):"<p class=\"help\">Import an authority receipt to preserve and inspect its subjects; target-repository verification decides authority.</p>";byId("receipt-state").textContent=receipt?"Receipt preserved for preflight only; this browser does not verify it or create effective approval.":"No authority receipt imported.";byId("copy-approvals").disabled=!(receipt&&Array.isArray(receipt.approvals))};
const renderDecision=function(){const decision=state.decision;if(!decision){byId("decision-state").textContent="No standalone decision imported.";byId("decision-rows").textContent="";byId("decision-export").textContent="";byId("download-decision").disabled=true;return}byId("decision-state").textContent="Decision imported for inspection only: unverified and not effective. It does not change policy, receipt, or authority state.";byId("decision-rows").textContent=["id: "+decision.id,"candidate: "+decision.candidate,"kind: "+decision.kind,"disposition: "+decision.disposition,"targets: "+decision.targets.join(","),"effects: "+decision.effects.join(","),"issuer: "+decision.issuer,"actor: "+decision.actor,"policyVersion: "+decision.policyVersion,"issuedAt: "+decision.issuedAt,"notBefore: "+decision.notBefore,"expiresAt: "+decision.expiresAt,"reviewBy: "+(decision.reviewBy||"none"),"acceptedFindings: "+decision.acceptedFindings.join(","),"acceptedGaps: "+decision.acceptedGaps.join(","),"conditions: "+decision.conditions.join(" | "),"reason: "+decision.reason].join("\n");byId("decision-export").textContent=decisionStableJson(decision);byId("download-decision").disabled=false};
const renderEccHookControls=function(){
  const controls=model.catalog.eccHookControls;
  const current=governance().eccHookControls||{};
  const profile=current.profile||"";
  const disabled=Array.isArray(current.disabledIds)?current.disabledIds:[];
  const host=byId("ecc-hook-controls");
  const priorGroups=Array.from(host.querySelectorAll("details[data-ecc-hook-group]"));
  const preserveOpen=priorGroups.length>0;
  const openIds=new Set(priorGroups.filter(function(group){return group.open}).map(function(group){return group.getAttribute("data-ecc-hook-group")}));
  const radios=controls.profiles.map(function(item){return '<label><input type="radio" name="ecc-hook-profile" value="'+esc(item.id)+'" data-ecc-hook-profile="'+esc(item.id)+'"'+(profile===item.id?" checked":"")+'> '+esc(item.label)+'</label>'}).join(" ");
  const rowFor=function(hook){const active=Boolean(profile)&&hook.profiles.indexOf(profile)!==-1;const canDisable=hook.disableEligible&&active;const isDisabled=disabled.indexOf(hook.id)!==-1;const action=hook.disableEligible?'<button type="button" class="btn sm" data-ecc-hook-disable="'+esc(hook.id)+'"'+(canDisable?"":" disabled")+'>'+esc(isDisabled?"Re-enable":"Disable")+'</button>':'<span class="help">Required wrapper; no individual disabled setting.</span>';return '<div class="hookreg" data-ecc-hook-id="'+esc(hook.id)+'"><p><b>'+esc(hook.id)+'</b> &mdash; '+esc(hook.event)+'</p><p class="help">Eligible profiles: '+esc(hook.profiles.join(", "))+'. '+(hook.disableEligible?"":"This wrapper remains enabled.")+'</p>'+action+'</div>'};
  const exactIds=new Set(["pre:bash:block-no-verify","pre:config-protection","pre:edit-write:gateguard-fact-force","post:quality-gate"]);
  const groups=[{id:"pre-tool-guardrails",label:"Pre-tool Guardrails",description:"Critical controls that prevent unverified Bash execution or accidental overwrites of baseline configuration.",ids:["pre:bash:block-no-verify","pre:config-protection"]},{id:"gate-checks",label:"Gate Checks",description:"Validation gates before high-risk edits and after code changes.",ids:["pre:edit-write:gateguard-fact-force","post:quality-gate"]},{id:"additional-pre-tool",label:"Additional Pre-tool Controls",description:"Other pinned PreToolUse controls from ECC's exact inventory.",select:function(hook){return hook.event==="PreToolUse"&&!exactIds.has(hook.id)}},{id:"session-lifecycle",label:"Session & Lifecycle",description:"Pinned session-start, compaction, stop, and session-end lifecycle controls.",select:function(hook){return ["SessionStart","PreCompact","Stop","SessionEnd"].indexOf(hook.event)!==-1}},{id:"post-tool-feedback",label:"Post-tool Observability & Feedback",description:"Remaining pinned PostToolUse and PostToolUseFailure observations, audit signals, and feedback controls.",select:function(hook){return ["PostToolUse","PostToolUseFailure"].indexOf(hook.event)!==-1&&!exactIds.has(hook.id)}}];
  let rendered=0;
  const grouped=groups.map(function(group,index){const hooks=group.ids?group.ids.map(function(id){return controls.hooks.find(function(hook){return hook.id===id})}).filter(Boolean):controls.hooks.filter(group.select);const isOpen=preserveOpen?openIds.has(group.id):index<2;rendered+=hooks.length;return '<details class="ecc-hook-group" data-ecc-hook-group="'+esc(group.id)+'"'+(isOpen?' open':'')+'><summary><span data-ecc-hook-group-label>'+esc(group.label)+'</span><b data-ecc-hook-group-count>'+hooks.length+'</b></summary><p class="help">'+esc(group.description)+'</p>'+hooks.map(rowFor).join("")+'</details>'}).join("");
  if(rendered!==controls.hooks.length){throw new Error("ECC hook grouping must render every pinned hook exactly once")}
  host.innerHTML='<p class="help">ECC executes hooks; AIH configures the supported profile and disabled-hook list through receipt-owned Claude <code>settings.json</code> environment keys. Disabling affects ECC execution after process spawn; it is not AIH enforcement.</p><fieldset><legend>Profile</legend>'+radios+'</fieldset><p class="help">'+esc(controls.disabledHooks.detail)+'</p>'+grouped;
};
/* The report preview's fulfillment summary walks selected catalog assets,
   including the four namespaces whose selection controls live in the rail.
   It recognizes only a selected asset that still matches the pinned catalog
   and policy kind; unknown, malformed, or stale selections stay honestly
   separate rather than being counted as evidence owed.
   Anything selected in the raw policy this pass does not recognize is never
   folded into "evidence owed", which the engine reserves for a component the
   pin DOES carry - it gets its own, honestly-named count instead. */
const fulfillmentCounts=function(){
  const counts={materializes:0,vetBlocked:0,evidenceOwed:0,notShownAsRow:0};
  const recognized=new Set();
  externalSelectionGroups().forEach(function(group){group.items.forEach(function(selection){
      const found=frameworkAsset(group.framework,selection.id);
      if(!found||!selectedAssetAuthorizable(found.framework.id,found.asset))return;
      recognized.add(found.framework.id+"|"+found.asset.id);
      const classification=classifyFulfillment(found.asset.vet);
      if(classification===FULFILLMENT_VET_BLOCKED){counts.vetBlocked++}
      else if(classification===FULFILLMENT_MATERIALIZES){counts.materializes++}
      else{counts.evidenceOwed++}
    })});
  externalSelectionGroups().forEach(function(group){group.items.forEach(function(item){
    if(!recognized.has(group.framework+"|"+item.id)){counts.notShownAsRow++}
  })});
  return counts};
const renderPreview=function(){byId("config-preview").value=policyText();const g=governance();const requested=g.activations.filter(function(item){return item.state==="active"}).map(function(item){return item.candidate});const custom=g.catalog.custom.map(function(item){return item.id+": Blocked - custom MCP has no supported projector/scanning/evidence"});const fulfillment=fulfillmentCounts();const capabilityRoots=capabilityPackageRoots();byId("report-preview").value=["Policy Workbench preview", "", "Requested intent: "+(requested.join(", ")||"none"),"AIH capabilities: "+capabilityRoots.length+" capability-package root(s) requested; target catalog, exact lock, promotion evidence, and custody still required.", "Effective: not evaluated - import this policy into a target repository for engine verification.", "", "External selections: "+externalSelectionGroups().reduce(function(total,item){return total+item.items.length},0)+" requested item(s), audit evidence still owed.","External curation: "+g.externalCuration.reduce(function(total,item){return total+item.items.length},0)+" report-only item(s).", "", "Fulfillment summary (governed projection, engine-evaluated): "+fulfillment.materializes+" would materialize directly, "+fulfillment.vetBlocked+" vet-blocked and recorded as intent only, "+fulfillment.evidenceOwed+" with evidence still owed, "+fulfillment.notShownAsRow+" selected but not shown as a row at this pin.", "", "Hard blocked:",].concat(custom.length?custom:["none"]).join("\n")};
const selectedFramework=function(){return model.catalog.frameworks.find(function(item){return item.id===byId("curation-framework").value})||model.catalog.frameworks[0]};
const curatableAssets=function(framework){return framework?framework.assets.filter(function(item){return item.curationKind}):[]};
const prefillCurationAsset=function(){const framework=selectedFramework();const key=byId("curation-asset").value.split("|");const asset=curatableAssets(framework).find(function(item){return item.curationKind===key[0]&&item.id===key[1]});if(!asset){return}byId("curation-kind").value=asset.curationKind;byId("curation-id").value=asset.id;byId("curation-repository").value=asset.source.repository;byId("curation-commit").value=asset.source.commit;byId("curation-path").value=asset.source.path};
const syncFrameworkSelect=function(){const framework=byId("curation-framework");const prior=framework.value;framework.innerHTML=model.catalog.frameworks.map(function(item){return '<option value="'+item.id+'">'+item.id.toUpperCase()+" - external guidance"+'</option>'}).join("");framework.value=prior||model.catalog.frameworks[0].id;const current=selectedFramework();byId("curation-asset").innerHTML='<option value="">Manual item</option>'+curatableAssets(current).map(function(item){return '<option value="'+esc(item.curationKind+"|"+item.id)+'">'+esc(item.curationKind+": "+item.id)+'</option>'}).join("")};
/* ── shell: rail, group cards, filter, ledger ────────────────────────────── */
const ROW_STATES=["requested","pending","blocked","external","approval","availability"];
let planeFilter="all";
/* The owner ticker. One surface at a time, so an administrator can look at what
   AIH owns without ECC's 136 components in the way.

   OWNERS is the whole contract: a new surface is one entry here plus group
   cards carrying its data-owner, and nothing about the layout changes. That is
   where Voice lands when it arrives - it is an AIH-owned capability surface,
   so it sits after AIH and before the third-party
   frameworks, which keeps the ticker ordered first-party then third-party.
   UPCOMING renders it as declared-but-not-yet-shipped rather than leaving the
   administrator to wonder whether the surface exists and is empty. */
const OWNERS=[["all","All"],["AIH","AIH"],["ECC","ECC"],["Superpowers","Superpowers"],["You","Your sources"]];
const UPCOMING=["Voice"];
let ownerFocus="all";
let activePreset="custom";
const explicitFrameworkSelections=new Set();
const frameworkSelectionIntentKey=function(frameworkId,id){return frameworkId+"|"+id};
const rememberCurrentSelectionsAsExplicit=function(){explicitFrameworkSelections.clear();externalSelectionGroups().forEach(function(group){group.items.forEach(function(item){explicitFrameworkSelections.add(frameworkSelectionIntentKey(group.framework,item.id))})})};
const PRESETS=[["custom","Custom","Start empty, then select only the components you intend to request."],
  ["vibe","Vibe","Selects every individually governable component from the active framework and every AIH control; availability-only inventory stays unchanged."],
  ["enterprise","Enterprise","Selects ECC Core; languages and security remain additive choices."]];
const railKinds=["lang","framework","capability","module"];
const isRailOwnedAsset=function(framework,asset){return framework.id==="ecc"&&railKinds.indexOf(asset.kind)!==-1};
const railSections=[["rail-langs","lang"],["rail-frameworks","framework"],["rail-caps","capability"],["rail-modules","module"]];
const buildRail=function(){const framework=eccFramework();if(!framework){return}railSections.forEach(function(entry){const host=byId(entry[0]);if(!host){return}host.innerHTML=framework.assets.filter(function(asset){return asset.kind===entry[1]}).map(function(asset){const key=framework.id+"|"+asset.kind+"|"+asset.id;return '<button type="button" class="chip" data-framework-select="'+esc(key)+'" aria-controls="'+esc(frameworkSelectionRowId(key))+'" aria-pressed="false">'+esc(asset.id.slice(asset.id.indexOf(":")+1))+'</button>'}).join("")})};
const revealRailSelectionGroup=function(key){const parts=String(key).split("|");const found=frameworkAsset(parts[0],parts[2]);if(found){openGroups[assetGroup(found.framework,found.asset)]=true}};
const syncRail=function(){const framework=eccFramework();if(!framework){return}const chosen=selectedItems(framework.id).map(function(item){return item.id});document.querySelectorAll(".chip[data-framework-select]").forEach(function(chip){const id=String(chip.getAttribute("data-framework-select")).split("|")[2];chip.setAttribute("aria-pressed",chosen.indexOf(id)===-1?"false":"true")});const posture=byId("rail-posture");if(posture){posture.textContent=(activePreset||"custom").replace(/^./,function(letter){return letter.toUpperCase()})}const composition=byId("rail-composition-note");if(composition){const core=model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection==="composed"});const selected=core.reduce(function(total,part){return total+partSelectedCount(part)},0);const total=core.reduce(function(count,part){return count+part.componentIds.length},0);composition.textContent=selected===0?"ECC Core not selected. Choose Enterprise for Core, or select components manually.":selected===total?"ECC Core complete: "+selected+" of "+total+" selected.":"Warning: ECC Core incomplete: "+selected+" of "+total+" selected; this composition does not match Enterprise."}
  document.querySelectorAll("[data-preset]").forEach(function(node){node.setAttribute("aria-pressed",node.getAttribute("data-preset")===activePreset?"true":"false")})};
/* One pass over the rendered rows: it applies the filter, counts each group,
   paints its meter, and totals the ledger. Reading the DOM keeps the tally
   honest about what an administrator can actually see. */
const paintShell=function(){const totals={requested:0,pending:0,blocked:0,external:0,approval:0,availability:0};let shown=0,total=0,vetBlocked=0;
  document.querySelectorAll(".grp").forEach(function(group){const counts={requested:0,pending:0,blocked:0,external:0,approval:0,availability:0};let rows=0,visible=0;
    group.querySelectorAll(".row[data-state]").forEach(function(node){const kindState=node.getAttribute("data-state");rows++;if(counts[kindState]!==undefined){counts[kindState]++;totals[kindState]++}
      const vetted=node.getAttribute("data-vetted")==="blocked";if(vetted){vetBlocked++}
      const match=planeFilter==="all"||(planeFilter==="vet-blocked"?vetted:planeFilter===kindState);node.hidden=!match;if(match){visible++}});
    total+=rows;shown+=visible;
    const selectable=[].slice.call(group.querySelectorAll(".row[data-state] .tick[aria-pressed]"));
    const selected=selectable.filter(function(control){return control.getAttribute("aria-pressed")==="true"}).length;
    const count=group.querySelector(".ct");if(count){const staticCount=group.getAttribute("data-static-count")||"";count.textContent=selectable.length?selected+" / "+selectable.length:rows?(planeFilter==="all"?String(rows):visible+" / "+rows):staticCount;count.title=planeFilter==="all"?"":visible+" of "+rows+" rows shown by the active filter"}
    const meter=group.querySelector(".meter");if(meter){if(selectable.length){const label=group.querySelector("h2");meter.hidden=false;meter.setAttribute("role","progressbar");meter.setAttribute("aria-label",(label?label.textContent:"Group")+": "+selected+" of "+selectable.length+" selected");meter.setAttribute("aria-valuemin","0");meter.setAttribute("aria-valuemax",String(selectable.length));meter.setAttribute("aria-valuenow",String(selected));meter.innerHTML=selected?'<i data-s="requested" style="width:'+(selected/selectable.length*100)+'%"></i>':""}else{meter.hidden=true;meter.removeAttribute("role");meter.removeAttribute("aria-label");meter.removeAttribute("aria-valuemin");meter.removeAttribute("aria-valuemax");meter.removeAttribute("aria-valuenow");meter.innerHTML=""}}});
  byId("c-shown").textContent=String(shown);byId("c-total").textContent=String(total);
  ROW_STATES.filter(function(s){return s!=="approval"&&s!=="availability"}).forEach(function(s){const node=byId(s==="requested"?"t-req":s==="pending"?"t-wait":s==="blocked"?"t-blk":"t-ext");if(node){node.textContent=String(totals[s])}});
  /* Every filter states how many rows it would show. A zero is information, not
     a dead end: its title says what would put a row there rather than leaving the
     administrator guessing. "Blocked" counts selection state and "Vet blocked"
     counts scan verdict; they are different axes and must never share a tally. */
  document.querySelectorAll(".f[data-filter]").forEach(function(chip){const key=chip.getAttribute("data-filter");
    const count=key==="all"?total:key==="vet-blocked"?vetBlocked:(totals[key]||0);
    chip.innerHTML=esc(chip.getAttribute("data-label")||"")+' <b>'+count+'</b>';
    /* Deliberately not disabled at zero: a disabled control cannot be focused,
       so it takes its own explanation with it. An empty filter stays clickable
       and the plane says why it is empty. */
    chip.setAttribute("data-empty",count===0?"true":"false");
    chip.title=count?"":FILTER_EMPTY[key]||"Nothing is in this state right now."});
  /* Owner focus is a view, not a selection: it hides no state and changes no
     policy, so a focused surface and the authored document never disagree. */
  const ownerRows={};
  document.querySelectorAll(".grp[data-owner]").forEach(function(group){
    const owners=String(group.getAttribute("data-owner")).split(" ");
    const count=group.querySelectorAll(".row[data-state]").length;
    owners.forEach(function(owner){ownerRows[owner]=(ownerRows[owner]||0)+count});
    group.hidden=ownerFocus!=="all"&&owners.indexOf(ownerFocus)===-1});
  document.querySelectorAll("#owner-ticker [data-owner-focus]").forEach(function(button){
    const owner=button.getAttribute("data-owner-focus");
    const count=owner==="all"?total:(ownerRows[owner]||0);
    button.querySelector("b").textContent=String(count);
    button.setAttribute("data-empty",count===0?"true":"false");
    button.setAttribute("aria-pressed",owner===ownerFocus?"true":"false")});
  const empty=byId("plane-empty");
  if(empty){empty.hidden=shown!==0;empty.textContent=shown===0?(FILTER_EMPTY[planeFilter]||"No row is in this state right now."):""}};
const FILTER_EMPTY={requested:"Nothing is selected yet. Select an item, or compose a preset.",
  external:"Everything selectable has been selected.",
  approval:"No source-locked ECC MCP entry is available for approval authoring.",
  availability:"No availability-only inventory rows are visible.",
  pending:"No AIH control is awaiting a request.",
  blocked:"Nothing is blocked. A row lands here when an AIH-owned gate fails - a custom source without a completed scan bound to its exact pin is the usual one."};
document.addEventListener("click",function(event){const head=event.target.closest&&event.target.closest("[data-group]");if(!head){return}const group=head.closest(".grp");const next=group.dataset.open==="1"?"0":"1";group.dataset.open=next;head.setAttribute("aria-expanded",next==="1"?"true":"false");const label=head.querySelector("h2");if(label){openGroups[label.textContent]=next==="1"}});
/* ── drawer: every detail the compact row deliberately does not carry ────── */
const drawerNode=byId("drawer"),scrimNode=byId("scrim"),authoringSidebarNode=byId("authoring-sidebar"),authoringScrimNode=byId("authoring-scrim"),eccMcpSidebarNode=byId("ecc-mcp-sidebar"),eccMcpScrimNode=byId("ecc-mcp-scrim");
const kv=function(key,value){return '<div><span>'+esc(key)+'</span><b>'+value+'</b></div>'};
const findingPlainLanguage=function(finding){
  const detail=String(finding.detail||"");
  if(finding.code==="trust.permission-risk")return {title:"Automated lifecycle script",meaning:"This component declares a package lifecycle or build script that can run code automatically.",risk:"Unreviewed scripts may execute code on the host during package preparation, build, or installation."};
  if(finding.code==="trust.external-egress"){const match=detail.match(/https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/);const endpoint=match?match[0]:"an external endpoint";return {title:"External network connection",meaning:"This component declares a connection to "+endpoint+".",risk:"Repository context or credentials could leave the local environment when that endpoint is used; an administrator must verify its owner, purpose, and data boundary."}}
  return {title:"Scanner review finding",meaning:"The scanner reported "+finding.code+" for this component.",risk:"Review the recorded source location and scanner evidence before completing the supported curation workflow."};
};
const scrollCode=function(value){return '<code class="scroll-code">'+esc(value)+'</code>'};
const componentStatus=function(ready,reason){return '<div class="component-status" data-readiness="'+(ready?"ready":"review")+'"><span class="b '+(ready?"ok":"warn")+'">'+esc(ready?"Ready to Use":"Requires Human Review")+'</span><p>'+esc(reason)+'</p></div>'};
const auditDetails=function(content){return '<details class="security-audit"><summary>Security &amp; Audit</summary><div class="security-body">'+content+'</div></details>'};
const scannerFindings=function(vet){
  if(!vet)return '<p class="note">No scanner verdict is recorded for this exact pin. No analyzer, tree digest, or finding is being claimed.</p>';
  const plain=vet.findings.map(findingPlainLanguage);
  const findings=plain.map(function(item,index){const finding=vet.findings[index];return '<article class="scanner-finding"><h3>'+esc(item.title)+'</h3><p><b>What it means:</b> '+esc(item.meaning)+'</p><p><b>Why it matters:</b> '+esc(item.risk)+'</p><p class="mono">'+esc(finding.code)+(finding.count===undefined?"":" · observed "+esc(finding.count))+'</p><p class="mono">'+esc(finding.detail)+'</p></article>'}).join("");
  return findings?'<div class="scanner-findings">'+findings+'</div>':'<p class="note ok">The recorded analyzers reported no findings for this exact content tree.</p>';
};
const securityAudit=function(framework,asset){
  const vet=asset.vet;const command=evidenceCommand(framework,asset);const analyzers=vet?vet.analyzers.map(function(analyzer){return analyzer.name+" "+analyzer.version}).join(", "):"not recorded";
  let content='<div class="cap">AIH administrator command</div><div class="cmdline admin-command"><code>'+esc(command)+'</code><button type="button" class="copy" data-copy="'+esc(command)+'">COPY</button></div><p class="note">Run this exact applying command where you have repository access. Evidence returns to <code>.aih/evidence/</code> in the governed repository.</p><div class="cap">Scanner findings</div>'+scannerFindings(vet)+'<div class="cap">Provenance</div><div class="kv">'+kv("Source repository",esc(asset.source.repository))+kv("Pinned commit",scrollCode(asset.source.commit))+kv("Source definition",esc(asset.metadata?asset.metadata.sourcePath:asset.source.path))+(asset.metadata?kv("Source SHA-256",scrollCode(asset.metadata.sourceSha256)):"")+(vet?kv("Tree SHA-256",scrollCode(vet.treeSha256)):"")+kv("Analyzers",esc(analyzers))+'</div>';
  return auditDetails(content);
};
const describeRow=function(id){
  const skillMarker="ECC skill: ";
  if(String(id).indexOf(skillMarker)===0){const skill=model.catalog.eccSkills.find(function(item){return item.id===String(id).slice(skillMarker.length)});
    if(skill){const found=skill.governable?frameworkAsset("ecc","skill:"+skill.id):null;if(found){return {id:found.asset.id,owner:"ECC",enforce:false,asset:found.asset,framework:found.framework}}return {id:"skill:"+skill.id,owner:"ECC",enforce:false,availabilitySkill:skill}}}
  const externalMcpMarker="ECC MCP: ";
  if(String(id).indexOf(externalMcpMarker)===0){const externalMcp=model.catalog.eccMcpInventory.find(function(item){return item.id===String(id).slice(externalMcpMarker.length)});
    if(externalMcp){return {id:externalMcp.id,owner:externalMcp.owner==="aih"?"AIH":"ECC",enforce:false,externalMcp:externalMcp}}}
  const aihCapabilities=model.catalog.aihSkills.map(function(pack){return {kind:"Skill",pack:pack}}).concat(model.catalog.aihAgents.map(function(pack){return {kind:"Agent",pack:pack}}));
  const aihCapability=aihCapabilities.find(function(entry){return entry.pack.skills.indexOf(String(id))!==-1});
  if(aihCapability){const source=aihCapability.pack.sources.find(function(entry){return entry.skill===String(id)});if(source){return {id:String(id),owner:"AIH",enforce:false,aihCapability:{kind:aihCapability.kind,pack:aihCapability.pack,source:source}}}}
  const mcp=model.catalog.mcp.find(function(item){return item.id===id});
  if(mcp){const eccMcp=model.catalog.eccMcpInventory.find(function(item){return item.owner==="aih"&&item.id===id});return {id:id,owner:"AIH",enforce:true,desc:mcp.description,control:mcp.control,server:mcp.server,eccMcp:eccMcp}}
  const hook=model.catalog.hooks.find(function(item){return item.id===id});
  if(hook){return {id:id,owner:"AIH",enforce:true,desc:hook.description,control:hook.control,hook:hook}}
  const marker=String(id).indexOf(" / ");
  if(marker!==-1){const frameworkId=String(id).slice(0,marker);const componentId=String(id).slice(String(id).indexOf(": ")+2);
    const found=frameworkAsset(frameworkId,componentId);
    if(found){return {id:componentId,owner:found.framework.id==="superpowers"?"Superpowers":"ECC",enforce:false,asset:found.asset,framework:found.framework}}}
  const custom=governance().catalog.custom.find(function(item){return item.id===id});
  if(custom){return {id:id,owner:"You",enforce:true,custom:custom}}
  return null};
const paintDrawer=function(id){
  const host=byId("drawer-detail");
  const close='<button type="button" class="x" data-drawer-close aria-label="Close details">&#10005;</button>';
  if(id==="AIH Governance & Telemetry Hooks information"){host.innerHTML='<div class="dhead"><h2>AIH Governance &amp; Telemetry Hooks</h2>'+close+'</div><div class="badges"><span class="b">AIH registers</span><span class="b ext">Owners vary</span></div>'+hookRegistryInformationMarkup();return}
  const item=describeRow(id);
  if(!item){host.innerHTML='<div class="dhead"><h2>'+esc(id)+'</h2>'+close+'</div>';return}
  if(item.availabilitySkill){const skill=item.availabilitySkill;const availability=skill.governable?
      "This source-locked skill has an existing individually governable policy component; use its canonical inventory row to record requested intent.":
      "This source-locked skill is not individually governable. Availability does not author policy and makes no installation, materialization, evidence, or support claim.";
    const provenance=model.catalog.eccSkillsProvenance;const audit=auditDetails('<div class="cap">Provenance</div><div class="kv">'+kv("Repository",esc(provenance.repository))+kv("Pinned commit",scrollCode(provenance.commit))+kv("Source definition",esc(skill.path))+kv("Source SHA-256",scrollCode(skill.sourceSha256))+'</div><p class="note">'+esc(availability)+'</p>');host.innerHTML='<div class="dhead"><h2>'+esc(skill.title)+'</h2>'+close+'</div><div class="badges"><span class="b ext">'+esc(item.id)+'</span><span class="b">ECC skill</span></div><div class="cap">Component overview</div><p class="note">'+esc(skill.summary)+'</p><div class="kv">'+kv("Allowed tools / scope","No explicit tool allow-list declared in source")+kv("Source definition",esc(skill.path))+'</div><p class="note"><b>Usage context:</b> '+esc(skill.usageContext)+'</p>'+componentStatus(false,"This availability-only source entry has no exact scanner verdict or supported materialization claim in this Workbench.")+audit+(skill.governable?'<div class="brow"><button type="button" class="btn sm" data-next-action data-inspector-selection>Go to canonical selection</button></div>':"");return}
  if(item.externalMcp){const externalMcp=item.externalMcp;
    const approval=externalMcp.owner==="ecc";const hasAihControl=model.catalog.mcp.some(function(control){return control.id===externalMcp.id});const launch=externalMcp.url||([externalMcp.command].concat(externalMcp.args||[]).filter(Boolean).join(" "))||"manual configuration";const credentials=externalMcp.credentialRequirement.variables.length?externalMcp.credentialRequirement.variables.join(", "):"none declared";const provenance=model.catalog.eccMcpProvenance;const audit=auditDetails('<div class="cap">Provenance</div><div class="kv">'+kv("Repository",esc(provenance.repository))+kv("Pinned commit",scrollCode(provenance.commit))+kv("Source definition",esc(provenance.path))+kv("Content SHA-256",scrollCode(model.catalog.eccMcpApproval.sourceContentSha256))+kv("Credential variables",esc(credentials))+kv("Supply",esc(externalMcp.supply))+kv("Addability",esc(externalMcp.addability))+'</div><p class="note">This source-locked declaration is not installed, contacted, scanned, attested, or represented as reachable.'+(approval?"":hasAihControl?" A separate AIH control row exists for this id.":" This Core build has no AIH policy control for this id.")+'</p>');host.innerHTML='<div class="dhead"><h2>'+esc(item.id)+'</h2>'+close+'</div><div class="badges"><span class="b ext">ECC source metadata</span><span class="b">MCP</span></div><div class="cap">Component overview</div><p class="note">'+esc(externalMcp.description)+'</p><div class="kv">'+kv("Allowed tools / scope",esc(externalMcp.description))+kv("Transport",esc(externalMcp.transport))+kv("Declared launch",scrollCode(launch))+'</div><p class="note"><b>Usage context:</b> '+esc("Declared for "+externalMcp.transport+" use through "+launch+".")+'</p>'+componentStatus(false,approval?"An administrator must review and author approval for this exact pinned declaration.":"This availability entry has no separate scanner verdict; use the AIH-owned control row for supported policy action.")+audit+(approval?'<div class="brow"><button type="button" class="btn sm" data-ecc-mcp-approval="'+esc(externalMcp.id)+'">Open approval authoring</button></div>':"");return}
  if(item.aihCapability){const capability=item.aihCapability;const packageIdentity=model.catalog.aihCapabilityPackage.name+String.fromCharCode(64)+model.catalog.aihCapabilityPackage.version;const agent=capability.kind==="Agent";const boundary=agent?"Isolated worker required":"Active task context";const disclosure=agent?" This Workbench records governed package intent; it does not launch the worker.":"";const audit=auditDetails('<div class="cap">Packaged provenance</div><div class="kv">'+kv("Package",scrollCode(packageIdentity))+kv("Pack root",esc(capability.pack.id))+kv("Packaged source",esc(capability.source.path))+kv("Manifest identity",scrollCode(capability.source.manifestIdentity))+kv("Catalog binding",esc(model.catalog.aihCapabilityCatalog.repository+" (managed by AIH)"))+'</div><p class="note" data-proof-status><b>Proof status:</b> this exact Core package declares and ships the reusable instruction source for this '+esc(capability.kind.toLowerCase())+'.'+esc(disclosure)+' Qualification proof is still pending: this portable artifact does not contain an exact catalog lock, promotion evidence, custody receipt, supported host execution receipt, or target-repository evaluation.</p>');host.innerHTML='<div class="dhead"><h2>'+esc(item.id)+'</h2>'+close+'</div><div class="badges"><span class="b">AIH packaged first-party</span><span class="b">'+esc(capability.kind)+'</span></div><div class="cap">Component overview</div><p class="note">'+esc(capability.pack.description)+'</p><div class="kv">'+kv("Allowed tools / scope",esc(boundary))+kv("Source definition",esc(capability.source.path))+'</div><p class="note"><b>Usage context:</b> '+esc(boundary+".")+'</p>'+componentStatus(false,"Qualification proof is still pending for this exact portable package and target-repository execution.")+audit+'<div class="brow"><button type="button" class="btn sm" data-next-action data-inspector-selection>Go to canonical selection</button></div>';return}
  const selected=item.asset?isFrameworkSelected(item.framework.id,item.asset.id):
    (item.control?governance().catalog.reviewed.some(function(entry){return entry.id===item.id}):false);
  const kind=item.asset?item.asset.kind:item.hook?"hook":item.custom?"custom MCP":"MCP";
  const metadata=item.asset&&item.asset.metadata;const drawerTitle=item.id;
  let html='<div class="dhead"><h2>'+esc(drawerTitle)+'</h2>'+close+'</div>'+
    '<div class="badges"><span class="b '+(item.owner==="AIH"?"":"ext")+'">'+esc(item.owner)+(item.enforce?" enforces":" &mdash; records only")+'</span>'+
    '<span class="b">'+esc(kind)+'</span>'+(item.eccMcp?'<span class="b ext">Also declared by ECC</span>':"")+'</div><div class="cap">Component overview</div>';
  if(metadata){html+='<p class="note">'+esc(metadata.summary)+'</p><div class="kv">'+kv("Component title",esc(metadata.title))+kv("Allowed tools / scope",esc(metadata.allowedTools.length?metadata.allowedTools.join(", "):"No explicit tool allow-list declared in source"))+kv("Source definition",esc(metadata.sourcePath))+'</div><p class="note"><b>Usage context:</b> '+esc(metadata.usageContext)+'</p>'}
  else if(item.desc){html+='<p class="note">'+esc(item.desc)+'</p>'}
  else if(item.asset){html+='<div class="kv">'+kv("Component",esc(item.asset.id))+kv("Source definition",esc(item.asset.source.path))+'</div>'}
  if(item.asset){html+='<p class="note">'+esc(item.framework.id)+" owns this component; by default it installs and runs it. AIH records the selection with its pinned source."+'</p>'}
  const ready=item.asset?!!item.asset.vet&&item.asset.vet.verdict==="pass":!!item.control&&!item.custom;
  const statusReason=ready?"Recorded evidence for this exact source passed; target-repository evaluation still decides whether authored intent becomes effective.":item.asset&&item.asset.vet&&item.asset.vet.verdict==="blocked"?"Recorded scanner findings require administrator review before the supported curation and authority workflow can complete.":item.custom?"This custom candidate remains blocked until exact evidence and authority are present.":"No exact scanner verdict is recorded for this component in the portable Workbench.";
  html+=componentStatus(ready,statusReason);
  if(item.control){html+='<div class="kv">'+kv("Projector",esc(item.control.projector)+" &rarr; "+esc(item.control.targets.join(", ")))+kv("Lifecycle",esc(item.control.lifecycle))+'</div>'+
    '<p class="journey-effective">Authored intent: '+(selected?"selected.":"not selected.")+' Effective count: not evaluated in this portable artifact; target-repository evaluation decides effectiveness.</p>';
    if(item.eccMcp){const eccMcp=item.eccMcp;const provenance=model.catalog.eccMcpProvenance;const credentials=eccMcp.credentialRequirement.variables.length?eccMcp.credentialRequirement.variables.join(", "):"none declared";html+=auditDetails('<div class="cap">Also declared by ECC</div><div class="kv">'+kv("Repository",esc(provenance.repository))+kv("Pinned commit",scrollCode(provenance.commit))+kv("Source definition",esc(provenance.path))+kv("Content SHA-256",scrollCode(model.catalog.eccMcpApproval.sourceContentSha256))+kv("Transport",esc(eccMcp.transport))+kv("Supply",esc(eccMcp.supply))+kv("Addability",esc(eccMcp.addability))+kv("Credential variables",esc(credentials))+'</div><p class="note">This source-locked declaration is preserved as provenance on the shared identity. It does not create a second control, installation, scan, attestation, or reachability claim.</p>')}}
  /* The row and its detail state the fulfillment consequence once selected -
     the drawer is exactly the "detail" the compact row deliberately does not
     carry (see the comment above paintDrawer). Gated the same way the row's
     own annotation is: never for a kind-mismatched (malformed) selection. */
  if(item.asset&&selected&&selectedAssetAuthorizable(item.framework.id,item.asset)){
    const classification=classifyFulfillment(item.asset.vet);
    const fulfillment=fulfillmentNote(item.framework,item.asset.vet);
    html+='<p class="note'+(classification===FULFILLMENT_VET_BLOCKED?" bad":classification===FULFILLMENT_MATERIALIZES?" ok":"")+'">'+esc(fulfillment)+'</p>'}
  if(item.asset){html+='<p class="journey-effective">Authored intent: '+(selected?"selected.":"not selected.")+' Effective count: not evaluated in this portable artifact; target-repository evaluation decides effectiveness.</p>'+securityAudit(item.framework,item.asset)}
  /* ECC's own declaration riders, stated before the click rather than
     discovered after it. The selection path authors this declared closure in
     one fail-closed change; browser-local intent tracking makes reversal retain
     independent selections without adding fabricated authority to the policy. */
  if(item.asset&&item.asset.riders&&item.asset.riders.length){
    html+='<div class="cap">Brings in with it</div><div class="kv">'+item.asset.riders.map(function(id){return kv(id,isFrameworkSelected(item.framework.id,id)?"selected":"not selected")}).join("")+'</div>'+
      '<p class="note">'+esc(item.framework.id)+' declares these alongside '+esc(item.asset.id)+'. Selecting it authors these declared riders in the same change. Deselecting it retains riders selected independently or still required by another declaration.</p>'}
  if(item.hook){html+='<div class="cap">Hook disclosure</div><div class="kv">'+
    kv("Trigger / event",esc(item.hook.behaviour.trigger))+kv("Records",esc(item.hook.behaviour.records))+
    kv("Artifact written",esc(item.hook.behaviour.artifact))+kv("Failure behaviour",esc(item.hook.behaviour.failureMode))+
    kv("Host targets",esc(item.control.targets.join(", ")))+
    kv("Script identity","<code>"+esc(item.control.source.scriptDigest)+"</code>")+
    kv("Ownership","AIH authored, AIH enforced")+'</div>'}
  if(item.asset){html+=(item.asset.curationKind?'<div class="brow"><button type="button" class="btn sm" data-next-action data-open-authoring="curation" data-curation-prefill="'+esc(item.framework.id+"|"+item.asset.curationKind+"|"+item.asset.id)+'">Open curation authoring</button></div>':'<div class="brow"><button type="button" class="btn sm" data-next-action data-inspector-selection>Go to canonical selection</button></div>')}
  if(item.control){html+='<div class="brow"><button type="button" class="btn sm" data-next-action data-inspector-selection>Go to canonical selection</button></div>'}
  if(item.custom){html+='<p class="note bad">'+esc(customNextAction(item.custom))+'</p><p class="journey-effective">Effective count: zero. This pending custom candidate is blocked and cannot materialize.</p><div class="brow"><button type="button" class="btn sm" data-next-action data-open-authoring="custom">Open custom MCP authoring</button></div>'}
  host.innerHTML=html};
const closeAuthoring=function(){authoringScrimNode.classList.remove("open");authoringSidebarNode.hidden=true};
const authoringTitle=function(kind){return kind==="custom"?"Add organization MCP":kind==="remote-custom"?"Add remote custom MCP":"Add framework curation"};
const resetCurationAuthoringCopy=function(){byId("curation-kind").disabled=false;byId("curation-editor").querySelector("summary").textContent="Add framework curation";byId("curation-purpose").textContent="Add audited ECC or Superpowers guidance. This is framework curation, not an organization-owned source and not MCP. AIH records report-only policy intent and does not install, run, or enforce the source.";byId("curation-framework-label").textContent="External framework owner";byId("add-curation").textContent="Add framework curation"};
const openAuthoring=function(kind,title){closeDrawer();closeEccMcpSidebar();authoringSidebarNode.hidden=false;authoringScrimNode.classList.add("open");Array.from(byId("authoring-forms").children).forEach(function(candidate){const active=candidate.id===kind+"-editor";candidate.hidden=!active;if(candidate.tagName==="DETAILS"){candidate.open=active}});if(kind==="curation"){resetCurationAuthoringCopy()}byId("authoring-title").textContent=title||authoringTitle(kind);const field=byId(kind==="curation"?"curation-id":kind==="remote-custom"?"remote-custom-id":"custom-id");if(field){field.focus()}};
authoringScrimNode.addEventListener("click",closeAuthoring);
byId("authoring-close").addEventListener("click",closeAuthoring);
const openDrawer=function(id){closeAuthoring();closeEccMcpSidebar();drawerNode.hidden=false;scrimNode.classList.add("open");paintDrawer(id);drawerNode.dataset.item=id};
const closeDrawer=function(){scrimNode.classList.remove("open");drawerNode.hidden=true;delete drawerNode.dataset.item};
scrimNode.addEventListener("click",closeDrawer);
const openEccMcpSidebar=function(){closeDrawer();closeAuthoring();eccMcpSidebarNode.hidden=false;eccMcpScrimNode.classList.add("open");byId("ecc-mcp-id").focus()};
const closeEccMcpSidebar=function(){eccMcpScrimNode.classList.remove("open");eccMcpSidebarNode.hidden=true};
eccMcpScrimNode.addEventListener("click",closeEccMcpSidebar);
byId("ecc-mcp-close").addEventListener("click",closeEccMcpSidebar);
const openEccMcpApproval=function(id){if(!model.catalog.externalMcp.some(function(item){return item.id===id})){return}openEccMcpSidebar();byId("ecc-mcp-id").value=id;announce("ECC MCP "+id+" selected for approval authoring only; it is not installed or contacted.")};
document.addEventListener("click",function(event){const approval=event.target.closest&&event.target.closest("[data-ecc-mcp-approval]");if(approval){openEccMcpApproval(approval.getAttribute("data-ecc-mcp-approval"))}});
/* data-detail, not data-open: the group cards carry data-open for their own
   collapsed state, so an opener keyed on it matched the enclosing card from
   every click inside a group and opened a stub drawer whose scrim then blocked
   the toolbar. Distinct attributes for distinct jobs. */
document.addEventListener("click",function(event){const opener=event.target.closest&&event.target.closest("[data-detail]");if(opener){openDrawer(opener.getAttribute("data-detail"));return}
  if(event.target.closest&&event.target.closest("[data-drawer-close]")){closeDrawer();return}const author=event.target.closest&&event.target.closest("[data-open-authoring]");if(author){openAuthoring(author.getAttribute("data-open-authoring"));return}const selection=event.target.closest&&event.target.closest("[data-inspector-selection]");if(selection){closeDrawer();byId("workbench").focus();announce("Selection stays on its canonical inventory or left-rail control.")}});
document.addEventListener("click",function(event){const rider=event.target.closest&&event.target.closest("[data-add-riders]");if(!rider){return}
  const parts=String(rider.getAttribute("data-add-riders")).split("|");const found=frameworkAsset(parts[0],parts[1]);if(!found||!found.asset.riders){return}
  const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}
  let added=0;found.asset.riders.forEach(function(id){const target=frameworkAsset(found.framework.id,id);if(target&&selectFrameworkAsset(g,target.framework,target.asset)){added++}});
  if(!added){state.policy=previous;announce("Every component "+found.asset.id+" declares is already selected.",true);render();return}
  commitPolicy(previous,"Added "+added+" component(s) declared by "+found.asset.id+" as requested intent with their pinned sources.")});
document.addEventListener("click",function(event){const copy=event.target.closest&&event.target.closest("[data-copy]");if(!copy){return}if(navigator.clipboard){navigator.clipboard.writeText(copy.getAttribute("data-copy"))}copy.textContent="COPIED";setTimeout(function(){copy.textContent="COPY"},1400)});
/* ── theme, sheet, spotlight ─────────────────────────────────────────────── */
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-theme-set]");if(!button){return}document.documentElement.dataset.theme=button.getAttribute("data-theme-set");document.querySelectorAll("[data-theme-set]").forEach(function(node){node.setAttribute("aria-pressed",node===button?"true":"false")})});
const sheetNode=byId("sheet");
const openSheet=function(){sheetNode.classList.add("open")};
const closeSheet=function(){sheetNode.classList.remove("open")};
/* Delegated, like every other shell control on this surface. The JSON sheet is
   opened here rather than from inside the export handler so that opening it
   never depends on that handler reaching its last statement. */
document.addEventListener("click",function(event){if(!event.target.closest){return}
  if(event.target.closest("#sheet-close")){closeSheet();return}
  if(event.target.closest("#export")){openSheet()}});
const openOrganizationArtifact=function(kind){const labels={skill:"Skill",agent:"Agent",mcp:"MCP server"};const label=labels[kind];if(!label){return}closeAuthoring();closeDrawer();closeEccMcpSidebar();document.body.dataset.view="author";document.querySelectorAll("[data-view-tab]").forEach(function(button){button.setAttribute("aria-pressed",button.dataset.viewTab==="author"?"true":"false")});byId("protected-kind").value=kind;byId("organization-artifact-context").textContent="Adding an organization-owned "+label+". Catalog-independent route: obtain attributable scan evidence for this exact source, then add its approval and download the protected policy file. Core can observe the existing files and durable lifecycle; it does not install or run the "+label+". The accountable owner email identifies the human responsible for this decision.";if(typeof window.__aihPolicyWorkbenchProtectedScanGuide==="function"){window.__aihPolicyWorkbenchProtectedScanGuide()}const section=byId("protected-form").closest("[data-groupcard]");if(section){section.dataset.open="1";const header=section.querySelector("[data-group]");if(header){header.setAttribute("aria-expanded","true")}if(section.scrollIntoView){section.scrollIntoView({block:"start"})}}byId("protected-subject-id").focus();announce("Organization-owned "+label+" selected. Add exact source and scan evidence in the protected policy form; this is separate from ECC/Superpowers curation.")};
byId("open-protected-mcp").addEventListener("click",function(){openOrganizationArtifact("mcp")});
byId("open-ecc-mcp").addEventListener("click",openEccMcpSidebar);
const spotNode=byId("spot-bd"),spotQuery=byId("spot-q"),hitsNode=byId("hits");
let spotIndex=0;
const spotItems=function(){const list=[];
  model.catalog.aihSkills.forEach(function(item){item.skills.forEach(function(skill){list.push({id:skill,group:"AIH Skills"})})});
  model.catalog.aihAgents.forEach(function(item){item.skills.forEach(function(skill){list.push({id:skill,group:"AIH Agents"})})});
  model.catalog.mcp.forEach(function(item){list.push({id:item.id,group:"AIH MCP servers"})});
  model.catalog.hooks.forEach(function(item){list.push({id:item.id,group:"AIH-Governance & Telemetry Hooks"})});
  model.catalog.eccMcpInventory.forEach(function(item){const shared=item.owner==="aih"&&model.catalog.mcp.some(function(control){return control.id===item.id});if(!shared){list.push({id:"ECC MCP: "+item.id,group:item.owner==="ecc"?"ECC MCP catalog":"AIH MCP servers"})}});
  model.catalog.eccSkills.forEach(function(item){list.push({id:item.governable?"ecc / skill: skill:"+item.id:"ECC skill: "+item.id,group:"ECC skills"})});
  model.catalog.frameworks.forEach(function(framework){framework.assets.forEach(function(asset){
    if(framework.id==="ecc"&&asset.kind==="skill"){return}
    list.push({id:framework.id+" / "+asset.kind+": "+asset.id,group:assetGroup(framework,asset)})})});
  return list};
const spotMatches=function(){const text=spotQuery.value.trim().toLowerCase();
  return spotItems().filter(function(item){return !text||(item.label||item.id).toLowerCase().indexOf(text)!==-1}).slice(0,40)};
const paintHits=function(){const matches=spotMatches();
  hitsNode.innerHTML=matches.map(function(item,index){return '<button type="button" class="hit'+(index===spotIndex?" sel":"")+'" data-hit="'+esc(item.id)+'"><span class="hid">'+esc(item.label||item.id)+'</span><span class="hg">'+esc(item.group)+'</span></button>'}).join("")||'<p class="spot-foot">No item matches. Every id stays searchable.</p>';
  byId("spot-count").textContent="searches all "+spotItems().length+" items"};
const openSpot=function(){spotNode.classList.add("open");spotQuery.value="";spotIndex=0;paintHits();spotQuery.focus()};
const closeSpot=function(){spotNode.classList.remove("open")};
byId("seek").addEventListener("click",openSpot);
spotQuery.addEventListener("input",function(){spotIndex=0;paintHits()});
spotNode.addEventListener("click",function(event){if(event.target===spotNode){closeSpot();return}
  const hit=event.target.closest&&event.target.closest("[data-hit]");if(hit){closeSpot();openDrawer(hit.getAttribute("data-hit"))}});
document.addEventListener("keydown",function(event){
  if(event.key==="/"&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){event.preventDefault();openSpot();return}
  if(event.key==="Escape"){closeSpot();closeDrawer();closeAuthoring();closeEccMcpSidebar();closeSheet();return}
  if(!spotNode.classList.contains("open")){return}
  const matches=spotMatches();
  if(event.key==="ArrowDown"){event.preventDefault();spotIndex=Math.min(spotIndex+1,matches.length-1);paintHits()}
  if(event.key==="ArrowUp"){event.preventDefault();spotIndex=Math.max(spotIndex-1,0);paintHits()}
  if(event.key==="Enter"&&matches[spotIndex]){event.preventDefault();closeSpot();openDrawer(matches[spotIndex].id)}});
document.addEventListener("click",function(event){const filter=event.target.closest&&event.target.closest(".f[data-filter]");if(!filter){return}planeFilter=filter.getAttribute("data-filter");document.querySelectorAll(".f[data-filter]").forEach(function(node){node.setAttribute("aria-pressed",node===filter?"true":"false")});paintShell()});
const canonicalEccDisabledIds=function(profile,ids){const controls=model.catalog.eccHookControls;const requested=new Set(Array.isArray(ids)?ids:[]);return controls.disabledHooks.eligibleIds.filter(function(id){const hook=controls.hooks.find(function(item){return item.id===id});return requested.has(id)&&hook&&hook.profiles.indexOf(profile)!==-1})};
document.addEventListener("click",function(event){const profileControl=event.target.closest&&event.target.closest("[data-ecc-hook-profile]");if(profileControl){const profile=profileControl.getAttribute("data-ecc-hook-profile");if(!model.catalog.eccHookControls.profiles.some(function(item){return item.id===profile})){return}const previous=structuredClone(state.policy);const g=ensureGovernance();const prior=g.eccHookControls&&Array.isArray(g.eccHookControls.disabledIds)?g.eccHookControls.disabledIds:[];const disabledIds=canonicalEccDisabledIds(profile,prior);g.eccHookControls=Object.assign({profile:profile},disabledIds.length?{disabledIds:disabledIds}:{});commitPolicy(previous,"ECC hook profile set to "+profile+". AIH records supported Claude environment intent; ECC executes the hooks.");return}const button=event.target.closest&&event.target.closest("[data-ecc-hook-disable]");if(!button||button.disabled){return}const id=button.getAttribute("data-ecc-hook-disable");const current=governance().eccHookControls;if(!current||!current.profile){return}const hook=model.catalog.eccHookControls.hooks.find(function(item){return item.id===id});if(!hook||!hook.disableEligible||hook.profiles.indexOf(current.profile)===-1){return}const previous=structuredClone(state.policy);const g=ensureGovernance();const prior=Array.isArray(g.eccHookControls&&g.eccHookControls.disabledIds)?g.eccHookControls.disabledIds:[];const requested=prior.indexOf(id)===-1?prior.concat([id]):prior.filter(function(item){return item!==id});const disabledIds=canonicalEccDisabledIds(current.profile,requested);g.eccHookControls=Object.assign({profile:current.profile},disabledIds.length?{disabledIds:disabledIds}:{});commitPolicy(previous,(prior.indexOf(id)===-1?"Disabled ":"Re-enabled ")+id+" for ECC's "+current.profile+" profile. ECC applies this after process spawn; it is not AIH enforcement.")});
const render=function(){byId("posture").value=state.policy.minimumPosture||"vibe";syncFrameworkSelect();renderAdoptionRecipe();renderRows();decorateConceptHeaders();renderEccHookControls();renderEccMcpApprovals();renderComposition();renderReceipt();renderDecision();renderPreview();syncRail();paintHosts();paintShell();byId("dispositionable-findings").textContent=model.findings.dispositionable.join(" | ");byId("hard-blockers").textContent=model.findings.fenced.join(" | ");if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}};
const applyPreset=function(value){if(value==="custom"){const previous=structuredClone(state.policy);activePreset="custom";state.policy=structuredClone(model.initialPolicy);state.editing=null;explicitFrameworkSelections.clear();commitPolicy(previous,"Custom composition started empty. Select only the components you intend to request.");return}activePreset=value;if(value==="vibe"){composeVibeProfile();return}if(value==="enterprise"){composeEnterpriseProfile()}};
byId("posture").addEventListener("change",function(event){const value=event.target.value;activePreset="custom";state.policy.minimumPosture=value;announce("Posture changed without modifying selections. Enterprise requires an explicit supported-CLI allow-list before export.");render()});
const closeTooltips=function(){document.querySelectorAll(".tooltip[data-open='true']").forEach(function(tip){tip.setAttribute("data-open","false")});document.querySelectorAll("[data-tooltip-button][aria-expanded='true']").forEach(function(button){button.setAttribute("aria-expanded","false")})};
const openTooltip=function(button){closeTooltips();button.setAttribute("aria-expanded","true");button.removeAttribute("data-tooltip-dismissed");const tip=byId(button.getAttribute("data-tooltip-button"));if(tip){const rect=button.getBoundingClientRect();const width=Math.min(368,Math.max(24,window.innerWidth-32));tip.style.width=width+"px";tip.style.left=Math.max(16,Math.min(rect.left,window.innerWidth-16-width))+"px";tip.style.top=Math.max(16,rect.bottom+4)+"px";tip.setAttribute("data-open","true")}};
document.addEventListener("focusin",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton&&!helpButton.hasAttribute("data-tooltip-dismissed")){openTooltip(helpButton)}});
document.addEventListener("focusout",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton){helpButton.removeAttribute("data-tooltip-dismissed");closeTooltips()}});
document.addEventListener("pointerover",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper){const helpButton=wrapper.querySelector("[data-tooltip-button]");if(helpButton){openTooltip(helpButton)}}});
document.addEventListener("pointerout",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper&&!wrapper.contains(event.relatedTarget)){closeTooltips()}});
document.addEventListener("click",function(event){const helpButton=event.target.closest("[data-tooltip-button]");if(helpButton){openTooltip(helpButton);return}const target=event.target.closest("[data-reviewed]");if(target){toggleReviewed(target.getAttribute("data-reviewed"));return}closeTooltips()});
document.addEventListener("click",function(event){const target=event.target.closest&&event.target.closest("[data-aih-capability-package]");if(!target){return}const id=target.getAttribute("data-aih-capability-package");const capabilities=model.catalog.aihSkills.concat(model.catalog.aihAgents);if(!capabilities.some(function(item){return item.id===id})){return}const current=state.policy.capabilityPackages;const roots=new Set(current&&Array.isArray(current.roots)?current.roots:[]);const selected=roots.has(id);const official=model.catalog.aihCapabilityCatalog;const boundElsewhere=Boolean(current&&current.catalog&&(current.catalog.provider!==official.provider||current.catalog.repository.toLowerCase()!==official.repository.toLowerCase()));if(boundElsewhere&&!selected){announce("AIH capability selection is unavailable because the imported capability-package intent is bound to another catalog. Remove that imported intent before selecting first-party AIH capabilities.",true);return}const previous=structuredClone(state.policy);if(selected){roots.delete(id)}else{roots.add(id)}const nextRoots=Array.from(roots).sort();if(nextRoots.length===0){delete state.policy.capabilityPackages}else if(boundElsewhere){state.policy.capabilityPackages={catalog:current.catalog,roots:nextRoots}}else{state.policy.capabilityPackages={catalog:{provider:official.provider,repository:official.repository},roots:nextRoots}}commitPolicy(previous,(selected?"Removed ":"Selected ")+id+" as capability-package intent. AIH manages its first-party package source; exact lock, promotion evidence, and custody are still required.")});
document.addEventListener("keydown",function(event){if(event.key==="Escape"){const focused=document.activeElement;closeTooltips();if(focused&&focused.matches("[data-tooltip-button]")){focused.setAttribute("data-tooltip-dismissed","true");focused.focus()}}});
byId("curation-framework").addEventListener("change",function(){syncFrameworkSelect();prefillCurationAsset()});
byId("curation-asset").addEventListener("change",prefillCurationAsset);
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-framework-select]");if(!button){return}const key=button.getAttribute("data-framework-select");if(button.closest(".rail")){revealRailSelectionGroup(key)}toggleFrameworkSelection(key)});
/* One control per additive part, reversible from itself: a part already fully
   selected removes exactly its own components and leaves anything another part
   or a row click selected alone. */
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-composition-add]");if(!button){return}const part=model.catalog.enterpriseComposition.parts.find(function(item){return item.id===button.getAttribute("data-composition-add")});if(!part){return}const previous=structuredClone(state.policy);const wasEnterpriseComplete=manualCompositionChange();const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}if(partSelectedCount(part)===part.componentIds.length){const group=g.externalSelections.find(function(item){return item.framework===model.catalog.enterpriseComposition.framework});if(group){group.items=group.items.filter(function(item){return part.componentIds.indexOf(item.id)===-1});if(!group.items.length){g.externalSelections=g.externalSelections.filter(function(item){return item.framework!==model.catalog.enterpriseComposition.framework})}}commitPolicy(previous,"Removed "+part.label+": "+part.componentIds.length+" component(s) are no longer requested."+compositionBreakNotice(wasEnterpriseComplete));return}const added=selectCompositionPart(g,part);commitPolicy(previous,"Added "+part.label+": "+added+" component(s) selected as requested intent with their pinned sources. Audit evidence is still owed for each."+compositionBreakNotice(wasEnterpriseComplete))});
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-curation-prefill]");if(!button){return}openAuthoring("curation");const key=String(button.getAttribute("data-curation-prefill")).split("|");byId("curation-framework").value=key[0];syncFrameworkSelect();byId("curation-asset").value=key[1]+"|"+key[2];prefillCurationAsset();announce("Curation form prefilled from "+key[2]+"; add an audit record to record report-only intent.")});
byId("add-curation").addEventListener("click",function(){const frameworkId=byId("curation-framework").value;const kind=byId("curation-kind").value;const id=byId("curation-id").value.trim();const repository=byId("curation-repository").value.trim();const commit=byId("curation-commit").value.trim();const path=byId("curation-path").value.trim();const record=byId("audit-record").value.trim();const digest=byId("audit-digest").value.trim();const unsafePath=!path||path.startsWith("/")||path.startsWith("./")||path.includes("\\")||path.includes("//")||path.split("/").some(function(part){return !part||part==="."||part===".."});if(!/^(agent|skill|command)$/.test(kind)||!id||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!/^[0-9a-f]{40}$/.test(commit)||unsafePath||!record||!/^sha256:[0-9a-f]{64}$/.test(digest)){announce("Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",true);return}const g=governance();let group=g.externalCuration.find(function(item){return item.framework===frameworkId});if(!group){group={framework:frameworkId,items:[]};g.externalCuration.push(group)}if(group.items.some(function(item){return item.kind===kind&&item.id===id})){announce("That external curation item is already present.",true);return}const previous=structuredClone(state.policy);group.items.push({kind:kind,id:id,source:{repository:repository,commit:commit,path:path},audit:{record:record,digest:digest},clarification:byId("curation-note").value.trim()||undefined});commitPolicy(previous,"External curation intent added; it is report-only and not enforced by AIH.")});
byId("custom-form").addEventListener("submit",function(event){event.preventDefault();const id=byId("custom-id").value.trim(),pkg=byId("custom-package").value.trim(),version=byId("custom-version").value.trim(),integrity=byId("custom-integrity").value.trim(),evidence=byId("custom-evidence").value.trim(),note=byId("custom-note").value.trim();const g=governance();if(g.catalog.custom.some(function(item){return item.id===id})){announce("Custom candidate identifier already exists.",true);return}const previous=structuredClone(state.policy);g.catalog.custom.push({id:id,kind:"mcp",description:"Pending custom MCP",capabilities:[],risks:["custom source"],source:{type:"stdio",resolver:"npx",registry:"https://registry.npmjs.org",package:pkg,version:version,integrity:integrity},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:evidence},clarification:note||undefined});if(commitPolicy(previous,"Pending custom MCP added. It cannot be activated.")){event.target.reset()}});
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-ecc-mcp-approval-remove]");if(!button){return}const id=button.getAttribute("data-ecc-mcp-approval-remove");const previous=structuredClone(state.policy);const g=ensureGovernance();g.eccMcpApprovals=(Array.isArray(g.eccMcpApprovals)?g.eccMcpApprovals:[]).filter(function(item){return item.id!==id});commitPolicy(previous,"ECC MCP approval removed for "+id+".")});
const readFile=function(input,callback){const file=input.files&&input.files[0];if(!file){return}const reader=new FileReader();reader.onload=function(){callback(String(reader.result||""))};reader.readAsText(file)};
byId("import-policy").addEventListener("click",function(){byId("policy-file").click()});byId("policy-file").addEventListener("change",function(event){readFile(event.target,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}const problems=schemaErrors(model.schema,value,"").concat(policySemantics(value),kiroTransportSemantics(value),policyTextSemantics(value));if(problems.length){throw new Error(problems.slice(0,3).join("; "))}state.policy=value;activePreset="custom";rememberCurrentSelectionsAsExplicit();announce("Policy imported without transformation after schema and policy-grammar validation.");render()}catch(error){announce("Policy import rejected: "+(error&&error.message?error.message:"valid policy JSON required"),true)}})});
byId("import-evidence").addEventListener("click",function(){byId("evidence-file").click()});byId("evidence-file").addEventListener("change",function(event){readFile(event.target,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}state.receipt=value;announce("Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.");renderReceipt();if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}}catch(error){announce("Evidence import failed: valid JSON object required.",true)}})});
byId("import-decision").addEventListener("click",function(){byId("decision-file").click()});byId("decision-file").addEventListener("change",function(event){const input=event.target;const file=input.files&&input.files[0];if(!file){return}const selection=++decisionSelection;const prior=state.decision===null?null:structuredClone(state.decision);const reader=new FileReader();const readFailure=function(){if(selection!==decisionSelection){return}state.decision=prior;renderDecision();announce("Decision import rejected: unable to read decision file",true)};reader.onerror=readFailure;reader.onabort=readFailure;reader.onload=function(){if(selection!==decisionSelection){return}try{const value=JSON.parse(String(reader.result||""));const problems=decisionProblems(value);if(problems.length){throw new Error(problems.slice(0,3).join("; "))}state.decision=structuredClone(value);announce("Decision imported for inspection only: unverified and not effective.");renderDecision()}catch(error){state.decision=prior;renderDecision();announce("Decision import rejected: "+(error&&error.message?error.message:"strict decision JSON required"),true)}};reader.readAsText(file)});
byId("copy-approvals").addEventListener("click",function(){if(state.receipt&&Array.isArray(state.receipt.approvals)){const previous=structuredClone(state.policy);governance().authority.approvals=structuredClone(state.receipt.approvals);commitPolicy(previous,"Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.")}});
byId("validate").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Schema and policy-grammar validation failed: "+problems.slice(0,3).join("; "),true)}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.")}renderPreview()});
byId("export").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Export blocked: "+problems.slice(0,3).join("; "),true);return}renderPreview();announce("Policy export preview refreshed from the actual policy schema and grammar.")});
byId("download").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Download blocked: "+problems.slice(0,3).join("; "),true);return}const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started.")});
byId("download-decision").addEventListener("click",function(){if(!state.decision){return}const blob=new Blob([decisionStableJson(state.decision)+"\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-governance-decision.json";link.click();URL.revokeObjectURL(url);announce("Canonical decision download started; it remains unverified and not effective.")});
/* Expand all has to record the state, not just paint it: the framework groups
   are re-rendered from openGroups on every policy change, so a bulk expand that
   only set dataset.open collapsed again the moment anything was selected. */
byId("toggle-groups").addEventListener("click",function(event){const groups=[].slice.call(document.querySelectorAll(".grp"));const open=groups.some(function(group){return group.dataset.open!=="1"});groups.forEach(function(group){group.dataset.open=open?"1":"0";const head=group.querySelector("[data-group]");if(head){head.setAttribute("aria-expanded",open?"true":"false");const label=head.querySelector("h2");if(label){openGroups[label.textContent]=open}}});event.target.textContent=open?"Collapse all":"Expand all";paintShell()});
document.querySelectorAll("[data-group]").forEach(function(head){head.setAttribute("aria-expanded",head.closest(".grp").dataset.open==="1"?"true":"false")});
/* AIH knows eleven CLIs; an org policy can name two of them as targets. Showing
   only the two leaves an administrator unable to tell whether the rest are
   unknown to AIH or merely unprojectable by policy, so both facts are stated. */
const sanctionedClis=function(){const value=governance().supportedClis;return Array.isArray(value)?value:[]};
const paintHosts=function(){const hosts=model.catalog.hosts||[];const projectable=hosts.filter(function(host){return host.policyTarget});const sanctioned=new Set(sanctionedClis());
  const list=byId("rail-hosts");if(!list){return}
  list.innerHTML=hosts.map(function(host){const pressed=sanctioned.has(host.id);return '<button type="button" class="chip" data-host="'+esc(host.id)+'" data-sanctioned-cli="'+esc(host.id)+'" aria-pressed="'+(pressed?"true":"false")+'" title="'+esc(host.label+(host.policyTarget?" - a policy activation can target this host":" - can be sanctioned by org policy, but cannot be targeted by the projector")+". MCP support: "+host.mcpSupport)+'">'+esc(host.id)+'</button>'}).join("");
  byId("rail-host-count").textContent=projectable.length+" of "+hosts.length;
  byId("rail-host-note").textContent="AIH supports "+hosts.length+" CLIs. A policy activation can target "+projectable.map(function(host){return host.id}).join(" and ")+"; "+sanctioned.size+" sanctioned by this policy. Sanctioned, materialization-capable, and projector-capable are separate sets."};
paintHosts();
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-sanctioned-cli]");if(!button){return}const cli=button.getAttribute("data-sanctioned-cli");const hosts=model.catalog.hosts||[];if(!hosts.some(function(host){return host.id===cli})){return}const previous=structuredClone(state.policy);const g=ensureGovernance();const selected=new Set(Array.isArray(g.supportedClis)?g.supportedClis:[]);if(selected.has(cli)){selected.delete(cli)}else{selected.add(cli)}const ordered=hosts.map(function(host){return host.id}).filter(function(id){return selected.has(id)});if(ordered.length){g.supportedClis=ordered}else{delete g.supportedClis}commitPolicy(previous,ordered.length?"Supported CLI allow-list updated: "+ordered.join(", ")+". Unsanctioned selected or detected CLIs are refused by the engine.":"Supported CLI allow-list cleared. Vibe permits an omitted list; Enterprise requires an explicit list.")});
/* The compact row moved detail into the drawer, so the inline help that used to
   sit on every row now sits where authoring actually happens. */
byId("curation-editor").querySelector("summary").insertAdjacentHTML("afterend",help("external curation","AIH preserves audited curation intent for agents, skills and commands with a pin and an audit record. It never installs, projects or enforces them - ECC and Superpowers do."));
byId("custom-editor").querySelector("summary").insertAdjacentHTML("afterend",help("custom sources","A custom MCP is recorded immediately as a fully pinned candidate and stays blocked until a completed scan binds to that exact pin."));
/* Acceptance step 3 opens with "Reset, select Enterprise, ...", so starting over
   has to be one control. It restores the generated starting policy exactly,
   which is also what makes the one-framework rule escapable. */
document.addEventListener("click",function(event){if(!event.target.closest||!event.target.closest("#clear-policy")){return}
  state.policy=structuredClone(model.initialPolicy);state.editing=null;activePreset="custom";explicitFrameworkSelections.clear();
  announce("Policy cleared. Every selection, requested control and curation record is gone, and either framework can be selected again.");render()});
byId("owner-ticker").innerHTML=OWNERS.map(function(entry,index){
  return (index?'<span class="sep" aria-hidden="true">|</span>':"")+
    '<button type="button" data-owner-focus="'+esc(entry[0])+'" aria-pressed="'+(entry[0]==="all"?"true":"false")+'">'+esc(entry[1])+' <b>0</b></button>'}).join("")+
  '<span class="soon">soon '+UPCOMING.map(esc).join(" &middot; ")+'</span>';
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-owner-focus]");if(!button){return}
  ownerFocus=button.getAttribute("data-owner-focus");paintShell()});
byId("presets").innerHTML=PRESETS.map(function(entry){return '<button type="button" class="preset" data-preset="'+esc(entry[0])+'" aria-pressed="false"><b>'+esc(entry[1])+'</b><span>'+esc(entry[2])+'</span></button>'}).join("");
document.addEventListener("click",function(event){const preset=event.target.closest&&event.target.closest("[data-preset]");if(!preset){return}applyPreset(preset.getAttribute("data-preset"))});
buildRail();
rememberCurrentSelectionsAsExplicit();
render();
</script>
<script>
/* Enhancements kept separate so the portable workbench remains dependency-free. */
(function(){
  const ids={curation:["curation-kind","curation-id","curation-owner","curation-repository","curation-commit","curation-path","audit-record","audit-digest","curation-note"],custom:["custom-id","custom-owner","custom-package","custom-version","custom-integrity","custom-evidence","custom-note"],remote:["remote-custom-id","remote-custom-origin","remote-custom-approved-by","remote-custom-authentication-mode","remote-custom-data-classes","remote-custom-administrative-status","remote-custom-evidence","remote-custom-note"],eccMcp:["ecc-mcp-id","ecc-mcp-state","ecc-mcp-approved-by","ecc-mcp-authentication-mode","ecc-mcp-data-classes"]};
  const status=byId("status");status.removeAttribute("aria-live");status.removeAttribute("role");
  const fieldError=function(id,message){const input=byId(id);if(!input){return}let node=byId(id+"-error");if(!node){node=document.createElement("span");node.id=id+"-error";node.className="field-error";node.hidden=true;input.insertAdjacentElement("afterend",node)}node.textContent=message||"";node.hidden=!message;if(message){input.setAttribute("aria-invalid","true");input.setAttribute("aria-describedby",node.id)}else{input.removeAttribute("aria-invalid");input.removeAttribute("aria-describedby")}};
  const clearFields=function(group){ids[group].forEach(function(id){fieldError(id,"")})};
  const recover=function(group,issues,summary){clearFields(group);let first;Object.keys(issues).forEach(function(id){fieldError(id,issues[id]);first=first||byId(id)});announce(summary,true);if(first){first.focus()}};
  const visible=function(value){return typeof value==="string"&&value===value.trim()&&value.length>=1&&value.length<=500&&/\S/u.test(value)&&!/\p{C}/u.test(value)};
  const approverEmail=new RegExp(model.semantics.approverEmailPattern);
const safeBrowserHttpsOrigin=function(origin){if(typeof origin!=="string"){return false}try{const pattern=new RegExp(model.semantics.httpsOriginPattern,"u");const url=new URL(origin);return origin===origin.trim()&&pattern.test(origin)&&url.protocol==="https:"&&url.username===""&&url.password===""&&url.pathname==="/"&&url.search===""&&url.hash===""}catch(_error){return false}};
const safeBrowserArgument=function(argument){if(typeof argument!=="string"||argument.length<1||argument.length>500){return false}const prefix=(model.semantics.httpsOriginArgumentPrefixes||[]).find(function(item){return argument.startsWith(item)});if(prefix){return safeBrowserHttpsOrigin(argument.slice(prefix.length))}return !argument.startsWith("/")&&!argument.startsWith("\\")&&!argument.includes("..")&&!/[\\/;|&$<>\p{C}]/u.test(argument)&&!argument.includes(String.fromCharCode(96))};
const browserArgumentErrors=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}const sources=[];const catalog=governanceValue.catalog||{};["reviewed","custom"].forEach(function(collection){(catalog[collection]||[]).forEach(function(candidate,index){sources.push({source:candidate&&candidate.source,path:"policy.governance.catalog."+collection+"["+index+"]"})})});const approvals=governanceValue.authority&&governanceValue.authority.approvals||[];approvals.forEach(function(approval,index){sources.push({source:approval&&approval.source,path:"policy.governance.authority.approvals["+index+"]"})});sources.forEach(function(entry){const source=entry.source;if(source&&(source.type==="package"||source.type==="stdio")&&!safeBrowserHttpsOrigin(source.registry)){errors.push(validationError(entry.path+".source.registry","must be an exact HTTPS origin"))}if(source&&source.type==="command"&&Array.isArray(source.args)){source.args.forEach(function(argument,index){if(!safeBrowserArgument(argument)){errors.push(validationError(entry.path+".source.args["+index+"]","must be a safe relative argument or exact HTTPS registry/index origin"))}})}});return errors};
  const browserRootErrors=function(policy){const errors=[];const overrides=policy&&policy.trust&&Array.isArray(policy.trust.baselineOverrides)?policy.trust.baselineOverrides:[];overrides.forEach(function(item,index){safePath(item.bundle,"policy.trust.baselineOverrides["+index+"].bundle",errors);isoTime(item.approvedAt,"policy.trust.baselineOverrides["+index+"].approvedAt",errors)});return errors};
  const browserSemanticErrors=function(policy){return policySemantics(policy).filter(function(error){return !/\.source\.args\[\d+\]: must be a safe relative argument/.test(error)}).concat(kiroTransportSemantics(policy),browserArgumentErrors(policy),browserRootErrors(policy))};
  const browserProblems=function(){return schemaErrors(model.schema,state.policy,"").concat(browserSemanticErrors(state.policy),policyTextSemantics(state.policy))};
  policyValidator=browserProblems;
  const readInput=function(input,callback){const file=input.files&&input.files[0];if(!file){return}const reader=new FileReader();reader.onload=function(){callback(String(reader.result||""))};reader.readAsText(file)};
  byId("policy-file").addEventListener("change",function(event){event.stopImmediatePropagation();readInput(event.currentTarget,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}const problems=schemaErrors(model.schema,value,"").concat(browserSemanticErrors(value),policyTextSemantics(value));if(problems.length){throw new Error(problems.slice(0,3).join("; "))}state.policy=value;state.editing=null;activePreset="custom";rememberCurrentSelectionsAsExplicit();announce("Policy imported without transformation after schema and policy-grammar validation.");render()}catch(error){announce("Policy import rejected: "+(error&&error.message?error.message:"valid policy JSON required"),true)}},true);
  },true);
  const exportNarration=function(){const g=governance();const controls=g.activations.filter(function(item){return item.state==="active"}).length;const external=externalSelectionGroups().reduce(function(total,group){return total+group.items.length},0);return (controls+external)+" requested item(s), 0 effective in this browser; import into a target repository for engine evaluation."};
  const narrateReport=function(){const report=byId("report-preview");report.value=report.value+"\n\nExport summary: "+exportNarration()};
  const runValidation=function(event,mode){event.preventDefault();event.stopImmediatePropagation();const problems=browserProblems();if(problems.length){announce((mode==="download"?"Download blocked: ":mode==="export"?"Export blocked: ":"Schema and policy-grammar validation failed: ")+problems.slice(0,3).join("; "),true);return false}if(mode==="download"){const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started. "+exportNarration())}else if(mode==="export"){renderPreview();narrateReport();openSheet();announce("Policy export preview refreshed from the actual policy schema and grammar. "+exportNarration())}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.");renderPreview()}return true};
  ["validate","export","download"].forEach(function(id){byId(id).addEventListener("click",function(event){runValidation(event,id)},true)});
byId("copy-approvals").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();if(!(state.receipt&&Array.isArray(state.receipt.approvals))){return}const previous=structuredClone(state.policy);ensureGovernance().authority.approvals=structuredClone(state.receipt.approvals);if(browserProblems().length){state.policy=previous;announce("Approval preservation rejected: imported subjects do not satisfy the actual policy grammar.",true);render();return}announce("Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.");render()},true);
  const curationIssues=function(){const values={kind:byId("curation-kind").value,id:byId("curation-id").value.trim(),owner:byId("curation-owner").value.trim(),repository:byId("curation-repository").value.trim(),commit:byId("curation-commit").value.trim(),path:byId("curation-path").value.trim(),record:byId("audit-record").value.trim(),digest:byId("audit-digest").value.trim(),note:byId("curation-note").value.trim()};const issues={};if(!/^(agent|skill|command)$/.test(values.kind)){issues["curation-kind"]="Choose agent, skill, or command."}if(!visible(values.id)){issues["curation-id"]="Use visible text with no hidden Unicode."}if(values.owner.length>254||!approverEmail.test(values.owner)){issues["curation-owner"]="Use a valid accountable owner email address."}if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)){issues["curation-repository"]="Use owner/repository."}if(!/^[0-9a-f]{40}$/.test(values.commit)){issues["curation-commit"]="Use a lowercase 40-character commit."}if(!values.path||values.path.startsWith("/")||values.path.startsWith("./")||values.path.includes("\\")||values.path.includes("//")||values.path.split("/").some(function(part){return !part||part==="."||part===".."})){issues["curation-path"]="Use a safe repo-relative POSIX path."}if(!visible(values.record)){issues["audit-record"]="Use visible audit-record text."}if(!/^sha256:[0-9a-f]{64}$/.test(values.digest)){issues["audit-digest"]="Use sha256: followed by 64 lowercase hex characters."}if(values.note&&!visible(values.note)){issues["curation-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const npmPackageNamePattern=/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const npmPackageNameOk=function(value){return value.length<=214&&npmPackageNamePattern.test(value)};
  const customIssues=function(){const values={id:byId("custom-id").value.trim(),owner:byId("custom-owner").value.trim(),pkg:byId("custom-package").value.trim(),version:byId("custom-version").value.trim(),integrity:byId("custom-integrity").value.trim(),evidence:byId("custom-evidence").value.trim(),note:byId("custom-note").value.trim()};const issues={};if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.id)){issues["custom-id"]="Use a lowercase stable identifier."}if(values.owner.length>254||!approverEmail.test(values.owner)){issues["custom-owner"]="Use a valid accountable owner email address."}if(!npmPackageNameOk(values.pkg)){issues["custom-package"]="Use an unscoped npm package name or a complete @scope/package identity."}if(!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(values.version)){issues["custom-version"]="Use an exact package version."}if(!/^sha256:[0-9a-f]{64}$/.test(values.integrity)){issues["custom-integrity"]="Use sha256: followed by 64 lowercase hex characters."}if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.evidence)){issues["custom-evidence"]="Use a lowercase evidence record identifier."}if(values.note&&!visible(values.note)){issues["custom-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const renderCustomScanGuide=function(){const host=byId("custom-scan-guide");if(!host){return}const packageName=byId("custom-package").value.trim();const version=byId("custom-version").value.trim();const packageOk=npmPackageNameOk(packageName);const versionOk=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version);if(/^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)){host.textContent="That value is only an npm scope, not a package. A scoped package must include both parts as @scope/package. Copy the exact package name from the publisher's install command, npm page, or package.json. No command was generated.";return}if(!packageOk){host.textContent="Enter a complete npm package name: unscoped-package or @scope/package. Copy the exact name rather than a directory title, publisher, or README heading. No command was generated.";return}if(!versionOk){host.textContent="Confirm the package identity before choosing an exact version: npm view \""+packageName+"\" name version repository bin --json. The listing title or SDK package/version may not identify the MCP server; registry metadata is discovery, not evidence.";return}const pinned=packageName+String.fromCharCode(64)+version;host.textContent="Inspect the publisher's registry metadata: npm view \""+pinned+"\" name version repository bin dist.tarball dist.integrity --json. Confirm that the metadata describes the MCP server and that its name and version match these fields; an SDK or client library is a different artifact. Record an organization-computed tarball SHA-256 in Integrity digest, add and download the pending policy, then from the target root run: aih trust scan "+pinned+" --apply. The command emits preflight evidence, not approval, installation, or activation."};
  ["custom-package","custom-version"].forEach(function(id){byId(id).addEventListener("input",renderCustomScanGuide);byId(id).addEventListener("change",renderCustomScanGuide)});
  renderCustomScanGuide();
  const remoteIssues=function(){const values={id:byId("remote-custom-id").value.trim(),origin:byId("remote-custom-origin").value.trim(),approvedBy:byId("remote-custom-approved-by").value.trim(),authenticationMode:byId("remote-custom-authentication-mode").value.trim(),allowedDataClasses:byId("remote-custom-data-classes").value.split(",").map(function(value){return value.trim()}).filter(Boolean),administrativeStatus:byId("remote-custom-administrative-status").value,evidence:byId("remote-custom-evidence").value.trim(),note:byId("remote-custom-note").value.trim()};const issues={};const identifier=/^[a-z][a-z0-9-]{0,63}$/;if(!identifier.test(values.id)){issues["remote-custom-id"]="Use a lowercase stable identifier."}if(!safeBrowserHttpsOrigin(values.origin)){issues["remote-custom-origin"]="Use an exact HTTPS origin with no path, query, or credentials."}if(values.approvedBy.length>254||!approverEmail.test(values.approvedBy)){issues["remote-custom-approved-by"]="Use a valid approver email address."}if(!visible(values.authenticationMode)){issues["remote-custom-authentication-mode"]="Use visible authentication text with no hidden Unicode."}if(!values.allowedDataClasses.length||values.allowedDataClasses.length>20||values.allowedDataClasses.some(function(value){return !identifier.test(value)})){issues["remote-custom-data-classes"]="Use one to 20 comma-separated lowercase data-class identifiers."}if(!/^(approved|revoked)$/.test(values.administrativeStatus)){issues["remote-custom-administrative-status"]="Choose approved or revoked."}if(!identifier.test(values.evidence)){issues["remote-custom-evidence"]="Use a lowercase evidence record identifier."}if(values.note&&!visible(values.note)){issues["remote-custom-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const eccMcpIssues=function(){const rawDataClasses=byId("ecc-mcp-data-classes").value.trim();const values={id:byId("ecc-mcp-id").value,state:byId("ecc-mcp-state").value,approvedBy:byId("ecc-mcp-approved-by").value.trim(),authenticationMode:byId("ecc-mcp-authentication-mode").value.trim(),allowedDataClasses:rawDataClasses?rawDataClasses.split(",").map(function(value){return value.trim()}):[]};const issues={};const identifier=/^[a-z][a-z0-9-]{0,63}$/;if(!model.catalog.externalMcp.some(function(item){return item.id===values.id})){issues["ecc-mcp-id"]="Choose a pinned ECC MCP."}if(!/^(approved|revoked)$/.test(values.state)){issues["ecc-mcp-state"]="Choose approved or revoked."}if(values.approvedBy.length>254||!approverEmail.test(values.approvedBy)){issues["ecc-mcp-approved-by"]="Use a valid approver email address."}if(!visible(values.authenticationMode)){issues["ecc-mcp-authentication-mode"]="Use visible authentication text with no hidden Unicode."}if(!values.allowedDataClasses.length||values.allowedDataClasses.length>20||values.allowedDataClasses.some(function(value){return !identifier.test(value)})||new Set(values.allowedDataClasses).size!==values.allowedDataClasses.length){issues["ecc-mcp-data-classes"]="Use one to 20 comma-separated lowercase data-class identifiers without duplicates; wildcards are not allowed."}return {values:values,issues:issues}};
  const setCurationEditState=function(editing){byId("curation-framework").disabled=editing;byId("curation-framework-label").textContent=editing?"External framework owner (locked; remove and re-add to change)":"External framework owner";byId("cancel-curation-edit").hidden=!editing};
  byId("remote-custom-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const result=remoteIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="remote"?state.editing:null;const duplicate=governance().catalog.custom.some(function(item,index){return item.id===values.id&&(!editing||editing.index!==index)});if(duplicate){result.issues["remote-custom-id"]="That pending custom candidate already exists."}if(Object.keys(result.issues).length){recover("remote",result.issues,"Correct the highlighted remote-endpoint fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const existing=editing&&g.catalog.custom[editing.index];const source={type:"remote",origin:values.origin,approval:{approvedBy:values.approvedBy,authenticationMode:values.authenticationMode,allowedDataClasses:values.allowedDataClasses},administrativeStatus:values.administrativeStatus,contentScanned:false};const item=existing?Object.assign({},existing,{id:values.id,source:source,evidence:Object.assign({},existing.evidence,{record:values.evidence})}):{id:values.id,kind:"mcp",description:"Pending remote custom MCP",capabilities:[],risks:["remote source"],source:source,targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:values.evidence}};if(values.note){item.clarification=values.note}else{delete item.clarification}if(editing){g.catalog.custom[editing.index]=item}else{g.catalog.custom.push(item)}if(commitPolicy(previous,editing?"Pending remote MCP updated. It remains blocked and cannot be activated.":"Pending remote MCP recorded. It remains blocked and cannot be activated.")){state.editing=null;clearFields("remote");event.currentTarget.reset()}},true);
  const resetCurationEditor=function(){state.editing=null;setCurationEditState(false);clearFields("curation")};
  ids.curation.forEach(function(id){byId(id).addEventListener("input",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")});byId(id).addEventListener("change",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")})});
  ids.custom.forEach(function(id){byId(id).addEventListener("input",function(){const result=customIssues();fieldError(id,result.issues[id]||"")})});
  ids.remote.forEach(function(id){byId(id).addEventListener("input",function(){const result=remoteIssues();fieldError(id,result.issues[id]||"")})});
  ids.eccMcp.forEach(function(id){byId(id).addEventListener("input",function(){const result=eccMcpIssues();fieldError(id,result.issues[id]||"")});byId(id).addEventListener("change",function(){const result=eccMcpIssues();fieldError(id,result.issues[id]||"")})});
  byId("save-ecc-mcp-approval").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();const result=eccMcpIssues();const values=result.values;if(Object.keys(result.issues).length){recover("eccMcp",result.issues,"Correct the highlighted ECC MCP approval fields.");return}const entry=model.catalog.externalMcp.find(function(item){return item.id===values.id});if(!entry){return}const previous=structuredClone(state.policy);const g=ensureGovernance();const existing=Array.isArray(g.eccMcpApprovals)?g.eccMcpApprovals:[];g.eccMcpApprovals=existing.filter(function(item){return item.id!==values.id});g.eccMcpApprovals.push({id:values.id,sourceContentSha256:model.catalog.eccMcpApproval.sourceContentSha256,state:values.state,approvedBy:values.approvedBy,authenticationMode:values.authenticationMode,allowedDataClasses:values.allowedDataClasses});if(commitPolicy(previous,"ECC MCP approval recorded for "+values.id+". "+(entry.addability==="https-configurable"?"It is eligible for a later explicit Add to one selected client.":"It is approval-only; current explicit Add is unavailable for its manual configuration."))){clearFields("eccMcp")}},true);
  byId("add-curation").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();const result=curationIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="curation"?state.editing:null;const frameworkId=editing?editing.framework:byId("curation-framework").value;const existingGroup=governance().externalCuration.find(function(item){return item.framework===frameworkId});const duplicate=existingGroup&&existingGroup.items.some(function(item,index){return item.kind===values.kind&&item.id===values.id&&(!editing||editing.framework!==existingGroup.framework||editing.index!==index)});if(duplicate){result.issues["curation-id"]="That framework item already exists."}if(Object.keys(result.issues).length){recover("curation",result.issues,"Correct the highlighted curation fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const group=g.externalCuration.find(function(item){return item.framework===frameworkId});const item={kind:values.kind,id:values.id,accountableOwner:values.owner,source:{repository:values.repository,commit:values.commit,path:values.path},audit:{record:values.record,digest:values.digest}};if(values.note){item.clarification=values.note}if(editing){const target=g.externalCuration.find(function(entry){return entry.framework===editing.framework});if(!target||!target.items[editing.index]){state.policy=previous;announce("The curation item changed before it could be saved; nothing was replaced.",true);return}target.items[editing.index]=item}else if(group){group.items.push(item)}else{g.externalCuration.push({framework:frameworkId,items:[item]})}if(commitPolicy(previous,editing?"External curation intent updated; it remains report-only and not enforced by AIH.":"External curation intent added; it is report-only and not enforced by AIH.")){resetCurationEditor();byId("curation-id").value="";byId("curation-note").value=""}},true);
  byId("cancel-curation-edit").addEventListener("click",function(){if(!(state.editing&&state.editing.kind==="curation")){return}resetCurationEditor();announce("Curation edit cancelled. Select a framework to add a new report-only item.")});
  byId("custom-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const result=customIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="custom"?state.editing:null;const duplicate=governance().catalog.custom.some(function(item,index){return item.id===values.id&&(!editing||editing.index!==index)});if(duplicate){result.issues["custom-id"]="That pending custom candidate already exists."}if(Object.keys(result.issues).length){recover("custom",result.issues,"Correct the highlighted custom-candidate fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const item={id:values.id,kind:"mcp",accountableOwner:values.owner,description:"Pending custom MCP",capabilities:[],risks:["custom source"],source:{type:"stdio",resolver:"npx",registry:"https://registry.npmjs.org",package:values.pkg,version:values.version,integrity:values.integrity},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:values.evidence}};if(values.note){item.clarification=values.note}if(editing){g.catalog.custom[editing.index]=item}else{g.catalog.custom.push(item)}if(commitPolicy(previous,editing?"Pending custom MCP updated. It remains blocked and cannot be activated.":"Pending custom MCP added. It cannot be activated.")){state.editing=null;clearFields("custom");event.currentTarget.reset();renderCustomScanGuide()}},true);
  const detail=function(row,label,lines){if(row.querySelector(".row-details")){return}const primary=row.querySelector(".row-slot")||row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const body=document.createElement("p");body.className="mono";body.textContent=lines.join(" · ");disclosure.append(summary,body);primary.append(disclosure)};
  const importedRecordText=function(record){try{return JSON.stringify(record,null,2)}catch(_error){return "[unserializable imported record]"}};
  const receiptDetail=function(row,label,type,record){if(row.querySelector(".row-details")){return}const primary=row.querySelector(".row-slot")||row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const notice=document.createElement("p");notice.className="mono";notice.textContent="Status: preserved/preflight-only; not verified or effective. Full imported "+type+" record (untrusted):";const body=document.createElement("pre");body.className="mono receipt-record";body.textContent=importedRecordText(record);disclosure.append(summary,notice,body);primary.append(disclosure)};
  const action=function(row,label,kind,index,framework,readOnly){let actions=row.querySelector(".row-actions");if(!actions){actions=document.createElement("div");actions.className="row-actions";row.append(actions)}if(actions.querySelector("[data-workbench-action]")){return}const items=readOnly?[["Legacy record (read-only)","readonly"],["Remove","remove"]]:[["Edit / prefill","edit"],["Remove","remove"]];items.forEach(function(item){const button=document.createElement("button");button.type="button";button.textContent=item[0];button.setAttribute("aria-label",item[0]+" "+label);button.dataset.workbenchAction=item[1];button.dataset.workbenchKind=kind;button.dataset.workbenchIndex=String(index);if(framework){button.dataset.workbenchFramework=framework}actions.append(button)})};
  const remoteDetails=function(item){const source=item.source;const administrative=Object.prototype.hasOwnProperty.call(source,"administrativeStatus");const governance=administrative?["Administrative status: "+source.administrativeStatus]:["Legacy tool-surface digest: "+source.toolSurfaceDigest,"Legacy verdict: "+source.verdict,"Legacy snapshot metadata is preserved read-only; remove and re-add to migrate."];return {administrative:administrative,lines:["Status: pending and blocked; no activation affordance.","Remote origin: "+source.origin,"Approved by: "+source.approval.approvedBy,"Authentication: "+source.approval.authenticationMode,"Allowed data classes: "+source.approval.allowedDataClasses.join(", ")].concat(governance,["Content scan: none","Evidence record: "+item.evidence.record,"Clarification: "+(item.clarification||"none")])}};
  const enhanceRows=function(){setCurationEditState(Boolean(state.editing&&state.editing.kind==="curation"));const g=governance();Array.from(byId("custom-rows").querySelectorAll(".row")).forEach(function(row,index){const item=g.catalog.custom[index];if(!item){return}row.dataset.evidenceRecord=item.evidence.record;const remote=item.source.type==="remote";const remoteState=remote?remoteDetails(item):null;detail(row,item.id,remote?remoteState.lines:["Status: pending and blocked; no activation affordance.","Accountable owner: "+(item.accountableOwner||"legacy record - not provided"),"Package: "+item.source.package+" @ "+item.source.version,"Registry: "+item.source.registry,"Integrity: "+item.source.integrity,"Evidence record: "+item.evidence.record,"Clarification: "+(item.clarification||"none")]);action(row,item.id,remote?"remote":"custom",index,undefined,Boolean(remoteState&&!remoteState.administrative))});let curationIndex=0;g.externalCuration.forEach(function(group){group.items.forEach(function(item,index){const row=byId("curation-rows").querySelectorAll(".row")[curationIndex++];if(!row){return}detail(row,group.framework+" "+item.kind+" "+item.id,["Status: report-only external guidance; not enforced by AIH.","Accountable owner: "+(item.accountableOwner||"legacy record - not provided"),"Repository: "+item.source.repository,"Commit: "+item.source.commit,"Path: "+item.source.path,"Audit record: "+item.audit.record,"Audit digest: "+item.audit.digest,"Clarification: "+(item.clarification||"none")]);action(row,item.id,"curation",index,group.framework)})});const receipt=state.receipt||{};const approvalItems=Array.isArray(receipt.approvals)?receipt.approvals:[];const evidenceItems=Array.isArray(receipt.evidence)?receipt.evidence:[];const receiptRows=byId("approval-rows").querySelectorAll(".row");approvalItems.forEach(function(item,index){const row=receiptRows[index];if(!row){return}receiptDetail(row,item.id||"approval","approval",item)});evidenceItems.forEach(function(item,index){const row=receiptRows[approvalItems.length+index];if(!row){return}const evidenceId=typeof item.id==="string"?item.id:"evidence";row.dataset.evidenceRecord=evidenceId;const customRow=Array.from(byId("custom-rows").querySelectorAll(".row")).find(function(candidateRow){return candidateRow.dataset.evidenceRecord===evidenceId});if(customRow){row.classList.add("evidence-linked");customRow.classList.add("evidence-linked");row.dataset.evidenceAssociation="pending-custom";customRow.dataset.evidenceAssociation="preflight-receipt";row.setAttribute("aria-label","Preflight evidence record "+evidenceId+" matches a pending custom MCP; it is not verified or effective.");customRow.setAttribute("aria-label","Pending custom MCP has matching preflight evidence record "+evidenceId+"; it is not verified or effective.")}receiptDetail(row,evidenceId,"evidence",item)})};
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest('[data-workbench-kind="curation"]');if(!button){return}if(button.dataset.workbenchAction==="edit"){setCurationEditState(true)}if(button.dataset.workbenchAction==="remove"){resetCurationEditor()}});
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-workbench-action]");if(!button){return}event.preventDefault();const g=governance();const index=Number(button.dataset.workbenchIndex);const kind=button.dataset.workbenchKind;const mode=button.dataset.workbenchAction;if(!Number.isInteger(index)){return}if(kind==="custom"){const item=g.catalog.custom[index];if(!item){return}if(mode==="edit"){byId("custom-id").value=item.id;byId("custom-owner").value=item.accountableOwner||"";byId("custom-package").value=item.source.package;byId("custom-version").value=item.source.version;byId("custom-integrity").value=item.source.integrity;byId("custom-evidence").value=item.evidence.record;byId("custom-note").value=item.clarification||"";state.editing={kind:"custom",index:index};openAuthoring("custom");announce("Editing pending custom MCP. Save validates before replacing the existing blocked candidate.")}else{const previous=structuredClone(state.policy);g.catalog.custom.splice(index,1);if(commitPolicy(previous,"Pending custom MCP removed; it was never active.")){state.editing=null}}}else if(kind==="remote"){const item=g.catalog.custom[index];if(!item||item.source.type!=="remote"){return}if(mode==="readonly"){announce("Legacy remote MCP records are preserved read-only. Remove and recreate one to use the administrative-status model.");return}if(mode==="edit"){byId("remote-custom-id").value=item.id;byId("remote-custom-origin").value=item.source.origin;byId("remote-custom-approved-by").value=item.source.approval.approvedBy;byId("remote-custom-authentication-mode").value=item.source.approval.authenticationMode;byId("remote-custom-data-classes").value=item.source.approval.allowedDataClasses.join(", ");byId("remote-custom-administrative-status").value=item.source.administrativeStatus;byId("remote-custom-evidence").value=item.evidence.record;byId("remote-custom-note").value=item.clarification||"";state.editing={kind:"remote",index:index};openAuthoring("remote-custom");announce("Editing pending remote MCP. Save validates before replacing the existing blocked candidate.")}else{const previous=structuredClone(state.policy);g.catalog.custom.splice(index,1);if(commitPolicy(previous,"Pending remote MCP removed; it was never active.")){state.editing=null}}}else if(kind==="curation"){const framework=button.dataset.workbenchFramework;const group=g.externalCuration.find(function(entry){return entry.framework===framework});const item=group&&group.items[index];if(!item){return}if(mode==="edit"){byId("curation-framework").value=framework;syncFrameworkSelect();byId("curation-kind").value=item.kind;byId("curation-id").value=item.id;byId("curation-owner").value=item.accountableOwner||"";byId("curation-repository").value=item.source.repository;byId("curation-commit").value=item.source.commit;byId("curation-path").value=item.source.path;byId("audit-record").value=item.audit.record;byId("audit-digest").value=item.audit.digest;byId("curation-note").value=item.clarification||"";state.editing={kind:"curation",framework:framework,index:index};openAuthoring("curation");setCurationEditState(true);announce("Editing external curation. Save validates before replacing the report-only intent.")}else{const previous=structuredClone(state.policy);group.items.splice(index,1);if(!group.items.length){g.externalCuration=g.externalCuration.filter(function(entry){return entry!==group})}if(commitPolicy(previous,"External curation intent removed; it was report-only and never enforced by AIH.")){state.editing=null}}}});
  const detailKey=function(frameworkId,id){const framework=model.catalog.frameworks.find(function(item){return item.id===frameworkId});const asset=framework&&framework.assets.find(function(item){return item.id===id});return asset?framework.id+" / "+asset.kind+": "+asset.id:null};
  const idReference=function(id,key){const button=document.createElement("button");button.type="button";button.className="rid";button.dataset.idReference=id;button.dataset.detail=key;button.textContent=id;return button};
  const enhanceIdReferences=function(){const composition=model.catalog.enterpriseComposition;Array.from(byId("composition-parts").querySelectorAll(":scope > .row")).forEach(function(row,index){const part=composition.parts[index];const host=row.querySelector("p.mono");if(!part||!host||host.querySelector("[data-id-reference]")){return}host.textContent="";part.componentIds.forEach(function(id,itemIndex){const key=detailKey(composition.framework,id);if(!key){return}if(itemIndex){host.append(document.createTextNode(" "))}host.append(idReference(id,key))})});[byId("hook-registry-rows")].concat(Array.from(document.querySelectorAll(".governance-info .hook-registry-rows"))).forEach(function(registry){Array.from(registry.querySelectorAll(".hookreg")).forEach(function(row,index){const entry=model.catalog.hookRegistry.entries[index];const host=row.querySelector("b");if(!entry||!host||host.querySelector("[data-id-reference]")){return}const framework=entry.owner==="aih"?null:model.catalog.frameworks.find(function(item){return item.assets.some(function(asset){return asset.id===entry.id})&&((item.id==="superpowers"?"Superpowers":"ECC")===entry.ownerLabel)});const key=entry.owner==="aih"?entry.id:(framework&&detailKey(framework.id,entry.id));if(!key){return}host.textContent="";host.append(idReference(entry.id,key))})})};
  window.__aihPolicyWorkbenchEnhanceRows=function(){enhanceRows();enhanceIdReferences()};[byId("custom-rows"),byId("curation-rows"),byId("approval-rows")].forEach(function(node){new MutationObserver(enhanceRows).observe(node,{childList:true})});[byId("composition-parts"),byId("hook-registry-rows")].forEach(function(node){new MutationObserver(enhanceIdReferences).observe(node,{childList:true})});enhanceRows();enhanceIdReferences();
${protectedPolicyScript}
})();
</script>
<script>
(function(){
var views=[["compose","Compose"],["artifacts","Artifacts"],["author","Authoring"],["imports","Imports"]];
var tabs=document.createElement("nav");tabs.className="tabs";tabs.setAttribute("aria-label","Workbench views");
tabs.innerHTML=views.map(function(v){return '<button type="button" data-view-tab="'+v[0]+'" aria-pressed="false">'+v[1]+'</button>'}).join("");
var bar=document.querySelector(".bar");bar.prepend(tabs);
var side=document.createElement("aside");side.id="side";side.setAttribute("aria-label","Policy navigation");
var stage=document.querySelector(".stage");stage.prepend(side);
var sidehead=document.createElement("div");sidehead.className="sidehead";
var railBtn=document.createElement("button");railBtn.type="button";railBtn.id="rail-toggle";
var syncRailBtn=function(){var off=document.body.dataset.rail==="off";railBtn.textContent=off?"\u203A":"\u2039";railBtn.setAttribute("aria-pressed",off?"true":"false");railBtn.setAttribute("aria-label",off?"Expand navigation":"Collapse navigation to icons")};
railBtn.addEventListener("click",function(){document.body.dataset.rail=document.body.dataset.rail==="off"?"on":"off";syncRailBtn()});
sidehead.append(document.querySelector(".brand"),railBtn);
var seekBtn=byId("seek");seekBtn.innerHTML='<span class="ico" aria-hidden="true">\u2315</span><span class="lbl2">Find any item\u2026</span><kbd>/</kbd>';seekBtn.title="Find any item";
side.append(sidehead,seekBtn);
var railEl=document.querySelector(".rail");side.append(railEl);
syncRailBtn();
var closeWorkspaceOverlays=function(){[["drawer","scrim"],["authoring-sidebar","authoring-scrim"],["ecc-mcp-sidebar","ecc-mcp-scrim"]].forEach(function(pair){var panel=byId(pair[0]);var scrim=byId(pair[1]);if(panel){panel.hidden=true}if(scrim){scrim.classList.remove("open")}})};
var setView=function(v){closeWorkspaceOverlays();document.body.dataset.view=v;tabs.querySelectorAll("[data-view-tab]").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.viewTab===v?"true":"false")})};
window.__aihSetWorkbenchView=setView;
tabs.addEventListener("click",function(e){var b=e.target.closest("[data-view-tab]");if(b){setView(b.dataset.viewTab)}});
/* sticky offsets follow the real header height */
var setBarH=function(){document.documentElement.style.setProperty("--barh",(bar.offsetHeight+8)+"px")};
window.addEventListener("resize",setBarH);setBarH();
var work=document.querySelector(".work");
var artifacts=document.createElement("div");artifacts.id="panel-artifacts";artifacts.className="plane pane";artifacts.setAttribute("role","main");
var author=document.createElement("div");author.id="panel-author";author.className="plane pane";author.setAttribute("role","main");
var imports=document.createElement("div");imports.id="panel-imports";imports.className="plane pane";imports.setAttribute("role","main");
work.append(artifacts,author,imports);
var secOf=function(id){var n=byId(id);return n?n.closest("section"):null};
var openGrp=function(sec){if(!sec||!sec.classList.contains("grp"))return;sec.dataset.open="1";var h=sec.querySelector("[data-group]");if(h){h.setAttribute("aria-expanded","true");var l=h.querySelector("h2");if(l){openGroups[l.textContent]=true}}};
var tipSeq=0;
var infoTip=function(content,label){tipSeq++;var id="shell-tip-"+tipSeq;var wrap=document.createElement("span");wrap.className="tip-wrap";var btn=document.createElement("button");btn.type="button";btn.className="help-button";btn.setAttribute("aria-label",label||"More information");btn.setAttribute("aria-describedby",id);btn.setAttribute("aria-expanded","false");btn.setAttribute("data-tooltip-button",id);btn.textContent="?";var tip=document.createElement("span");tip.id=id;tip.className="tooltip";tip.setAttribute("role","tooltip");tip.setAttribute("data-open","false");if(typeof content==="string"){tip.textContent=content}else if(content){tip.append(content)}wrap.append(btn,tip);return wrap};
/* move authoring + import surfaces into their views */
var recipe=byId("adoption-recipe");
if(recipe){var rh=recipe.querySelector("h2");var rhelp=recipe.querySelector(".help");if(rh&&rhelp){var rhead=document.createElement("div");rhead.className="recipehead";rh.before(rhead);rhead.append(rh,infoTip(rhelp,"About the adoption recipe"))}author.append(recipe)}
var protectedSec=secOf("protected-form");
if(protectedSec){var plegend=protectedSec.querySelector("legend");var phelp=protectedSec.querySelector("fieldset .help");if(plegend&&phelp){plegend.append(infoTip(phelp,"About this form"))}author.append(protectedSec)}
var curationSec=secOf("curation-rows");if(curationSec){openGrp(curationSec);author.append(curationSec)}
var importBar=document.createElement("div");importBar.className="gcard importbar";
importBar.innerHTML='<div class="cap">Import files <span id="import-tip-slot"></span></div><div class="brow" id="import-actions"></div>';
imports.append(importBar);
byId("import-tip-slot").append(infoTip("Importing a policy replaces the current document after validation. Evidence and decisions are preserved for preflight inspection only and never become effective in this browser.","About imports"));
byId("import-actions").append(byId("import-policy"),byId("import-evidence"),byId("import-decision"));
var approvalSec=secOf("approval-rows");if(approvalSec){openGrp(approvalSec);imports.append(approvalSec)}
var eccEd=byId("ecc-mcp-editor");if(eccEd){var eccHelp=eccEd.querySelector(".help");var eccHead=eccEd.closest("aside").querySelector(".dhead h2");if(eccHelp&&eccHead){eccHead.append(infoTip(eccHelp,"About MCP approvals"))}}
/* group footnotes -> info tips in the group header */
document.querySelectorAll("section.grp").forEach(function(sec){var note=sec.querySelector(":scope > p.grpnote")||sec.querySelector(":scope > .grpbody > p.grpnote:first-child");if(!note){return}sec.classList.add("has-tip");var head=sec.querySelector(".grphead h2");var wrap=infoTip(note,"About "+(head?head.textContent:"this group"));wrap.classList.add("grp-tip");sec.append(wrap)});
/* preset: one select, description behind ? */
var presetHost=byId("presets");presetHost.innerHTML="";
var presetRow=document.createElement("div");presetRow.className="ctlrow";
var presetLbl=document.createElement("span");presetLbl.className="lbl";presetLbl.textContent="Preset";
var presetSel=document.createElement("select");presetSel.id="preset-select";presetSel.setAttribute("aria-label","Preset");
presetSel.innerHTML=PRESETS.map(function(p){return '<option value="'+p[0]+'">'+p[1]+'</option>'}).join("");
presetSel.value=activePreset;
presetSel.addEventListener("change",function(){applyPreset(presetSel.value)});
var presetTip=infoTip("","About the selected preset");var presetTipSpan=presetTip.querySelector(".tooltip");
presetRow.append(presetLbl,presetSel,presetTip);
presetHost.append(presetRow);
var railPosture=byId("rail-posture");railPosture.classList.add("sr");
var syncPreset=function(){var v=(railPosture.textContent||"custom").toLowerCase();if(presetSel.value!==v&&PRESETS.some(function(p){return p[0]===v})){presetSel.value=v}var d=PRESETS.find(function(p){return p[0]===presetSel.value});var t=d?d[2]:"";if(presetTipSpan.textContent!==t){presetTipSpan.textContent=t}var pl=d?d[1]:"";var pb=presetNav?presetNav.row.querySelector(".selcount"):null;if(pb&&pb.textContent!==pl){pb.textContent=pl}};
/* posture: segmented, shown only when it is an independent choice (Custom) */
var postureSel=byId("posture");var postureLabel=postureSel.closest("label");
var seg=document.createElement("div");seg.className="seg";seg.setAttribute("role","group");seg.setAttribute("aria-label","Posture");
[["vibe","Vibe"],["enterprise","Enterprise"]].forEach(function(o){var b=document.createElement("button");b.type="button";b.dataset.postureSet=o[0];b.textContent=o[1];b.setAttribute("aria-pressed","false");b.addEventListener("click",function(){if(postureSel.value!==o[0]){postureSel.value=o[0];postureSel.dispatchEvent(new Event("change",{bubbles:true}))}});seg.append(b)});
var postureRow=document.createElement("div");postureRow.className="ctlrow";
var postureLbl=document.createElement("span");postureLbl.className="lbl";postureLbl.textContent="Posture";
var postureTip=infoTip("Minimum posture the exported policy declares. It follows the preset; with a Custom composition you set it here. Changing it does not modify selections; Enterprise requires an explicit supported-CLI allow-list before export.","About posture");
postureRow.append(postureLbl,seg,postureTip);
var syncPosture=function(){seg.querySelectorAll("[data-posture-set]").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.postureSet===postureSel.value?"true":"false")});var show=presetSel.value==="custom";if(postureRow.hidden===show){postureRow.hidden=!show}};
var presetSect=presetHost.closest(".sect");
var noteP=byId("rail-composition-note");
presetSect.append(postureRow);
if(noteP){presetSect.append(noteP)}
postureLabel.setAttribute("hidden","");presetSect.append(postureLabel);
var clearBtn=byId("clear-policy");clearBtn.classList.add("sm");
var clearRow=document.createElement("div");clearRow.className="brow";clearRow.append(clearBtn);
presetSect.append(clearRow);
/* catalog rows -> popovers; Bring your own clubbed below */
var catCard=document.createElement("section");catCard.className="gcard sect";
catCard.innerHTML='<div class="cap">ECC catalog</div><div class="poplist" id="rail-poplist"></div>';
var presetCard=document.createElement("section");presetCard.className="gcard sect";
presetCard.innerHTML='<div class="cap">AIH policy</div><div class="poplist" id="preset-poplist"></div>';
var byoCard=document.createElement("section");byoCard.className="gcard sect";
byoCard.innerHTML='<div class="cap">Bring Your Own</div><div class="poplist" id="byo-actions"></div>';
presetSect.after(presetCard);presetCard.after(catCard);catCard.after(byoCard);
var popList=byId("rail-poplist");
var openPop=null;
var closePop=function(){if(openPop){openPop.pop.removeAttribute("data-open");openPop.row.setAttribute("aria-expanded","false");openPop=null}};
var pops=[];
var IC={preset:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5h6M12.7 5h.8"/><circle cx="10.6" cy="5" r="1.8"/><path d="M2.5 11h.8M8.5 11h5"/><circle cx="5.4" cy="11" r="1.8"/></svg>',langs:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 2.5 8 6 12.5"/><path d="M10 3.5 13.5 8 10 12.5"/></svg>',frameworks:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 13.8 5 8 7.8 2.2 5Z"/><path d="M2.2 8.2 8 11l5.8-2.8"/><path d="M2.2 11.2 8 14l5.8-2.8"/></svg>',caps:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.8 2.2 3.4 9h3.5l-.8 4.8L11.6 7H8.1Z"/></svg>',modules:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2.4" y="2.4" width="4.7" height="4.7" rx=".9"/><rect x="8.9" y="2.4" width="4.7" height="4.7" rx=".9"/><rect x="2.4" y="8.9" width="4.7" height="4.7" rx=".9"/><rect x="8.9" y="8.9" width="4.7" height="4.7" rx=".9"/></svg>',hosts:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M4.6 6.4 6.8 8.2 4.6 10M8.6 10.2h3"/></svg>',mcp:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.6 2.4v2.4M10.4 2.4v2.4"/><path d="M4 4.8h8v2.6a4 4 0 0 1-8 0Z"/><path d="M8 11.6v2"/></svg>',plus:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>'};
var makePop=function(label,icon,nodes,countable,host){
  var row=document.createElement("button");row.type="button";row.className="pop-row";row.setAttribute("aria-expanded","false");row.title=label;
  row.innerHTML='<i class="pi">'+icon+'</i><span class="pl">'+label+'</span><b class="selcount"></b><span class="pc">&rsaquo;</span>';
  var pop=document.createElement("div");pop.className="pop";
  var cap=document.createElement("div");cap.className="cap";cap.textContent=label;pop.append(cap);
  nodes.forEach(function(n){if(n){pop.append(n)}});
  row.addEventListener("click",function(e){e.stopPropagation();if(openPop&&openPop.row===row){closePop();return}closePop();pop.setAttribute("data-open","true");row.setAttribute("aria-expanded","true");var rect=row.getBoundingClientRect();var pw=Math.min(430,window.innerWidth-24);pop.style.width=pw+"px";var left=rect.right+10;if(left+pw>window.innerWidth-12){left=Math.max(12,window.innerWidth-pw-12)}pop.style.left=left+"px";var minimumHeight=Math.min(160,Math.max(80,window.innerHeight-24));var preferredHeight=Math.min(520,Math.max(minimumHeight,pop.scrollHeight));var top=Math.max(12,Math.min(rect.top,window.innerHeight-preferredHeight-12));pop.style.top=top+"px";pop.style.maxHeight=Math.max(minimumHeight,window.innerHeight-top-12)+"px";openPop={row:row,pop:pop}});
  (host||popList).append(row,pop);
  pops.push({row:row,pop:pop,countable:countable!==false});
  return {row:row,pop:pop}};
var presetNav=makePop("Presets",IC.preset,[presetSect],false,byId("preset-poplist"));
presetNav.row.classList.add("rowcap");
var chipPops=[["rail-modules","ECC modules",IC.modules],["rail-langs","Languages",IC.langs],["rail-frameworks","Frameworks",IC.frameworks],["rail-caps","Capabilities",IC.caps]];
chipPops.forEach(function(e){var chips=byId(e[0]);if(!chips)return;var old=chips.closest("section");makePop(e[1],e[2],[chips],true);if(old&&old!==presetSect){old.remove()}});
var hostsChips=byId("rail-hosts");var hostsSect=hostsChips.closest("section");
var hostCountLine=document.createElement("p");hostCountLine.className="help";
hostCountLine.append(document.createTextNode("Projectable: "),byId("rail-host-count"));
makePop("Allowed CLI",IC.hosts,[hostsChips,hostCountLine,byId("rail-host-note")],true,byId("preset-poplist"));
hostsSect.remove();
var cliUsage=document.createElement("div");cliUsage.className="cli-usage-list";
var cliUsageCommand=function(label,command,detail){return '<article><h3>'+esc(label)+'</h3><div class="cmdline"><code>'+esc(command)+'</code><button type="button" class="copy" data-copy="'+esc(command)+'">COPY</button></div><p class="help">'+esc(detail)+'</p></article>'};
cliUsage.innerHTML='<p class="note">Run these commands in the target project or workstation context. Viewing or copying a command does not select policy, grant authority, or execute anything.</p>'+
  cliUsageCommand("Certificates / TLS","aih heal --scope certs --apply","Repair eligible local certificate and runtime trust wiring.")+
  cliUsageCommand("npm","aih heal --scope npm --apply","Diagnose npm and emit the operator-run reinstall script; AIH does not execute that script.")+
  cliUsageCommand("PATH","aih heal --scope path --apply","Apply supported local PATH remediation.")+
  cliUsageCommand("MCP runtime","aih heal --scope mcp --apply","Apply supported local MCP runtime remediation.")+
  cliUsageCommand("All runtime scopes","aih heal --scope all --apply","Run the supported certs, npm, PATH, and MCP repair scopes together.")+
  cliUsageCommand("Certificate propagation","aih certs --apply","Project detected certificate trust into supported CLI configuration.")+
  cliUsageCommand("Shell tools","aih tools --apply","Install missing supported agent shell tools with the detected package manager, or emit manual guidance when no supported installer is available.")+
  cliUsageCommand("Readiness","aih ready","Run the graded readiness gate. In an interactive terminal, review the optional tool-install prompt before accepting it.")+
  cliUsageCommand("Verification","aih doctor","Run the read-only health verification surface.")+
  '<article><h3>SSH</h3><p class="help"><b>No dedicated AIH SSH repair command.</b> AIH does not modify SSH keys or SSH configuration. Repair SSH with your organization\'s approved tooling, then re-run readiness or doctor.</p></article>';
makePop("CLI usages",IC.hosts,[cliUsage],false,byId("preset-poplist"));
var mcpBtn=byId("open-ecc-mcp"),artifactBtn=byId("open-artifacts"),customHookBtn=byId("open-custom-hook-info");
var mcpSect=mcpBtn.closest("section"),customSect=artifactBtn.closest("section");
byId("byo-actions").append(artifactBtn,customHookBtn);
if(mcpSect)mcpSect.remove();if(customSect)customSect.remove();
var iconizeBtn=function(btn,icon){var t=btn.textContent;btn.title=t;btn.className="pop-row";btn.innerHTML='<i class="pi">'+icon+'</i><span class="pl">'+esc(t)+'</span><span class="pc">&rsaquo;</span>'};
iconizeBtn(artifactBtn,IC.plus);
iconizeBtn(customHookBtn,'<span aria-hidden="true">i</span>');
document.addEventListener("click",function(e){if(openPop&&!openPop.pop.contains(e.target)&&!openPop.row.contains(e.target)){closePop()}});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){closePop()}});
/* theme toggle */
var pill=document.querySelector(".pill");
var themeBtn=document.createElement("button");themeBtn.type="button";themeBtn.className="btn";themeBtn.id="theme-toggle";
var syncTheme=function(){var cur=document.documentElement.dataset.theme;themeBtn.textContent=cur==="light"?"Dark":"Light";themeBtn.setAttribute("aria-label","Switch to "+(cur==="light"?"dark":"light")+" theme")};
themeBtn.addEventListener("click",function(){var cur=document.documentElement.dataset.theme;var target=document.querySelector('[data-theme-set="'+(cur==="light"?"dark":"light")+'"]');if(target){target.click()}syncTheme()});
pill.before(themeBtn);pill.setAttribute("hidden","");syncTheme();
/* governance information drawer: compact entry rows keep their full facts
   behind local information controls without becoming another inventory. */
var transformRegistry=function(){document.querySelectorAll(".governance-info .hookreg:not([data-tipped])").forEach(function(reg){reg.setAttribute("data-tipped","1");var helps=Array.prototype.slice.call(reg.querySelectorAll("p.help"));if(!helps.length){return}var holder=document.createElement("span");helps.forEach(function(p){holder.append(p)});var first=reg.querySelector("p");if(first){first.classList.add("hookline");first.append(infoTip(holder,"Hook entry details"))}})};
var transformEcc=function(){var host=byId("ecc-hook-controls");if(!host){return}
  var intros=Array.prototype.slice.call(host.querySelectorAll(":scope > p.help"));
  var legend=host.querySelector("fieldset legend");
  if(intros.length&&legend&&!legend.querySelector(".tip-wrap")){var holder=document.createElement("span");intros.forEach(function(p){holder.append(p)});legend.append(infoTip(holder,"About ECC-Guardrails & Safety Hooks"))}
  var radios=host.querySelector("fieldset");if(radios&&!radios.querySelector(".hookprofiles")){var wrapRow=document.createElement("div");wrapRow.className="hookprofiles";Array.prototype.slice.call(radios.querySelectorAll(":scope > label")).forEach(function(l){wrapRow.append(l)});radios.append(wrapRow)}
  Array.prototype.slice.call(host.querySelectorAll(".hookreg:not([data-opt])")).forEach(function(reg){reg.setAttribute("data-opt","1");
    var idNode=reg.querySelector("b");var title=reg.querySelector("p");var help=reg.querySelector("p.help");
    var btn=reg.querySelector("[data-ecc-hook-disable]");var span=btn?null:reg.querySelector("span.help");
    var rowEl=document.createElement("label");rowEl.className="hookopt";
    var box=document.createElement("input");box.type="checkbox";
    if(btn){box.checked=btn.textContent!=="Re-enable";box.disabled=btn.disabled;box.addEventListener("change",function(){btn.click()})}else{box.checked=true;box.disabled=true}
    var hid=document.createElement("span");hid.className="hid";hid.textContent=idNode?idNode.textContent:"hook";
    var ev=document.createElement("span");ev.className="ev";var evText=title?title.textContent:"";var dash=evText.indexOf("\u2014");ev.textContent=dash!==-1?evText.slice(dash+1).trim():"";
    var holder=document.createElement("span");
    if(help){holder.append(help)}
    if(span){var pnote=document.createElement("p");pnote.className="help";pnote.textContent=span.textContent;holder.append(pnote);span.setAttribute("hidden","")}
    if(btn){btn.setAttribute("hidden","")}
    rowEl.append(box,hid,ev,infoTip(holder,"About this hook"));
    if(title){title.replaceWith(rowEl)}else{reg.prepend(rowEl)}
  })};
var hookQueued=null;var queueHooks=function(){if(hookQueued){return}hookQueued=requestAnimationFrame(function(){hookQueued=null;if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}transformRegistry();transformEcc()})};
var drawerInfoHost=byId("drawer-detail");if(drawerInfoHost){new MutationObserver(queueHooks).observe(drawerInfoHost,{childList:true})}
var eccHost=byId("ecc-hook-controls");if(eccHost){new MutationObserver(queueHooks).observe(eccHost,{childList:true})}
transformRegistry();transformEcc();
/* keep counts + preset + posture in sync with every re-render */
var rowsHost=byId("framework-rows");
var planeHost=rowsHost?rowsHost.parentElement:null;
var orderPass=function(){if(!planeHost){return}var canon=Array.prototype.slice.call(document.querySelectorAll(".ticker button")).map(function(b){return (b.textContent||"").replace(/[0-9]+/g,"").trim().toUpperCase()}).filter(function(t){return t&&t!=="ALL"});var canonOf=function(sec){var e=(sec.classList&&sec.classList.contains("grp"))?sec.querySelector(".grphead .own"):null;if(!e){return ""}var u=e.textContent.trim().toUpperCase();for(var i=0;i<canon.length;i++){if(u.indexOf(canon[i])!==-1){return canon[i]}}return ""};var walk=function(el){if(el.classList&&(el.classList.contains("planetop")||el.classList.contains("ticker"))){return}var o=canonOf(el);var idx=o?canon.indexOf(o)+1:(el.id==="plane-empty"?98:50);var v=String(idx);if(el.style.order!==v){el.style.order=v}};Array.prototype.slice.call(planeHost.children).forEach(function(ch){if(ch===rowsHost){Array.prototype.slice.call(rowsHost.children).forEach(walk)}else{walk(ch)}})};
if(planeHost){new MutationObserver(function(){orderPass()}).observe(planeHost,{childList:true,subtree:true});orderPass()}
var planetopEl=planeHost?planeHost.querySelector(".planetop"):null;
var tickerEl=document.querySelector(".ticker");
if(planetopEl&&tickerEl){planetopEl.before(tickerEl)}
var syncCompact=function(){pops.forEach(function(p){var b=p.row.querySelector(".selcount");if(!p.countable){return}var total=p.pop.querySelectorAll("[aria-pressed]").length;var sel=p.pop.querySelectorAll('[aria-pressed="true"]').length;var t=sel?sel+" / "+total:String(total);if(b&&b.textContent!==t){b.textContent=t}});syncPreset();syncPosture()};
var syncQueued=null;var queueSync=function(){if(syncQueued){return}syncQueued=requestAnimationFrame(function(){syncQueued=null;syncCompact()})};
new MutationObserver(queueSync).observe(document.querySelector(".rail"),{subtree:true,attributes:true,attributeFilter:["aria-pressed"],childList:true,characterData:true});
syncCompact();
setView("compose");setBarH();
if(typeof paintShell==="function"){paintShell()}
})();
</script>
${artifactIntakeScript}
</body>
</html>`.replace("__AIH_DATA__", () => safeScriptJson(model));
}
