import type { PolicyStudioModel } from "./studio-model.js";

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** Portable, dependency-free policy authoring surface. */
export function policyStudioHtml(model: PolicyStudioModel): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIH Policy Workbench</title>
<style>
/* Policy Workbench - Sahara, warm minimalism, ported from the owner-accepted
   acceptance artifact. Burnt sienna on warm linen, EB Garamond headings against
   Manrope labels, IBM Plex Mono for ids, whitespace as the primary tool.

   Two standing instructions bound this and must not be re-litigated:
   "keep it compact just colors and not effects" - Sahara's 28-32px padding rules
   were not applied, they fight the measured compactness; and "i don't care for
   design any more just it should function" - so there is no blur, no
   backdrop-filter, no animated full-viewport backdrop anywhere. The field is
   three static radial gradients painted straight onto the background, which is
   what the artifact measured as costing nothing while looking the same.

   Fonts are stacks, not webfonts: this artifact opens with no repository and no
   network, so a remote font would be a dependency it must not have. */
:root{
  color-scheme:light dark;
  --display:"EB Garamond",Georgia,"Times New Roman",serif;
  --sans:"Manrope","Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  --radius:8px;
  --bg:#faf5ee;--bg-deep:#f2ebe1;
  --panel:#fffcf7;--panel2:#f2ebe1;--line:#8a7d6d;--hair:#ded4c6;
  --fg:#3a302a;--muted:#6b5d52;--faint:#94867a;
  --accent:#a8541f;--accent-soft:rgba(194,101,42,.1);--focus:#c2652a;
  --ok:#8f4517;--warn:#8a6316;--bad:#8c3c3c;
  --fill:rgba(58,48,42,.045);--fill-2:rgba(58,48,42,.09);
  --blob-1:rgba(194,101,42,.09);--blob-2:rgba(201,162,39,.07);--blob-3:rgba(140,60,60,.06);
  --shadow:0 2px 16px rgba(58,48,42,.05);--shadow-lg:0 8px 40px -12px rgba(58,48,42,.14);
  /* one ramp, shared by the group meter and the state badges */
  --s-sel:#c2652a;--s-req:#dda877;--s-wait:#c9a227;--s-blk:#8c3c3c;--s-uns:#a79c8d;
  --s-avail:rgba(58,48,42,.13);
  --b-pending-bg:#f5e9c8;--b-pending-fg:#6b4c08;
  --b-blocked-bg:#f3dcdc;--b-blocked-fg:#7a2f2f;
  --b-external-bg:#eae3d8;--b-external-fg:#544a3e;
  --b-requested-bg:#f7e0cf;--b-requested-fg:#8f4517;
  font-family:var(--sans);
}
/* Sahara after sundown: the same warmth, inverted. Warm charcoal, never blue-black. */
@media(prefers-color-scheme:dark){:root{
  --bg:#1c1714;--bg-deep:#15110f;
  --panel:#2a231e;--panel2:#231d19;--line:#7d7266;--hair:#3d342d;
  --fg:#f4ece1;--muted:#cbbdad;--faint:#9a8b7c;
  --accent:#eda468;--accent-soft:rgba(224,131,68,.14);--focus:#e08344;
  --ok:#e08344;--warn:#d9b23f;--bad:#c96363;
  --fill:rgba(240,228,214,.07);--fill-2:rgba(240,228,214,.13);
  --blob-1:rgba(224,131,68,.1);--blob-2:rgba(217,178,63,.07);--blob-3:rgba(201,99,99,.06);
  --shadow:0 2px 16px rgba(0,0,0,.25);--shadow-lg:0 12px 48px -14px rgba(0,0,0,.5);
  --s-sel:#e08344;--s-req:#a9754c;--s-wait:#d9b23f;--s-blk:#c96363;--s-uns:#8a7f72;
  --s-avail:rgba(240,228,214,.16);
  --b-pending-bg:#40361c;--b-pending-fg:#e8cd7a;
  --b-blocked-bg:#45272a;--b-blocked-fg:#f0b3b3;
  --b-external-bg:#332c25;--b-external-fg:#cbbdad;
  --b-requested-bg:#4a2f1c;--b-requested-fg:#f0a670;
}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--fg);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;
  background:
    radial-gradient(56vw 56vw at 14% -6%,var(--blob-1),transparent 65%),
    radial-gradient(44vw 44vw at 92% 22%,var(--blob-2),transparent 65%),
    radial-gradient(40vw 40vw at 44% 118%,var(--blob-3),transparent 65%),
    var(--bg);
  background-attachment:fixed}
h1,h2,legend{font-family:var(--display);letter-spacing:-.01em;margin:0}
button,input,select,textarea{font:inherit}
/* 32px interactive floor is this repository's standard and predates the
   restyle. Sahara's compactness does not get to lower a tap target. */
button,input,select{min-height:32px}
summary{min-height:32px}
button{border:1px solid var(--line);border-radius:6px;background:var(--fill);color:var(--fg);
  padding:.22rem .5rem;cursor:pointer;font-size:12px;font-weight:600;
  transition:background 160ms ease,border-color 160ms ease}
button:hover{background:var(--fill-2);border-color:var(--focus)}
button:disabled{opacity:.5;cursor:not-allowed}
:where(button,input,select,textarea,summary):focus-visible{outline:3px solid var(--focus);outline-offset:2px}
input,select,textarea{max-width:100%;border:1px solid var(--line);border-radius:6px;
  background:var(--panel);color:var(--fg);padding:.28rem .4rem}
textarea{width:100%;min-height:9rem;resize:vertical;font-family:var(--mono);font-size:11.5px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:.75rem;top:.75rem;z-index:30;background:var(--panel);padding:.5rem}
.hidden{display:none}

/* ── stage ─────────────────────────────────────────── */
.stage{max-width:1500px;margin:auto;padding:10px 14px 0;display:grid;gap:9px}
.bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 12px;
  border:1px solid var(--hair);border-radius:14px;background:var(--panel);box-shadow:var(--shadow)}
.brand{display:flex;align-items:center;gap:8px;margin-right:auto}
.brand-mark{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;
  background:var(--focus)}
.brand-mark svg{width:14px;height:14px}
.bar h1{font-size:15px}
.bar h1 span{color:var(--faint);font-weight:400;font-family:var(--sans);font-size:11.5px}
.bar label{display:flex;align-items:center;gap:.35rem;font-size:11.5px;color:var(--muted)}
.bar #status{font-family:var(--mono);font-size:11px;color:var(--faint);
  flex:1 1 12rem;min-width:0;overflow-wrap:anywhere}
.announce{min-height:1.3rem;margin:0;padding:0 4px;color:var(--muted);font-size:12px}
.announce.error{color:var(--bad)}
.boundary{margin:0 4px;color:var(--faint);font-size:11.5px;max-width:90ch}

/* ── work: rail + plane ────────────────────────────── */
.work{display:grid;grid-template-columns:232px minmax(0,1fr);gap:10px;align-items:start;
  padding-bottom:12px}
.rail{display:grid;gap:8px;align-content:start;position:sticky;top:10px}
.sect{padding:9px 10px;display:grid;gap:6px;border:1px solid var(--hair);border-radius:14px;
  background:var(--panel);box-shadow:var(--shadow)}
.cap{font:600 9.5px/1.3 var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--faint);
  display:flex;align-items:center;gap:6px}
.cap .end{margin-left:auto;color:var(--accent);font-size:9.5px;text-transform:none;letter-spacing:0}
.rail select{width:100%}
.chips{display:flex;flex-wrap:wrap;gap:4px}
/* 24px is the WCAG 2.2 target-size minimum; the artifact's 21px chips would
   fail it, and a decorative toggle is still a target. */
.chip{min-height:24px;height:24px;padding:0 9px;border-radius:999px;border:1px solid transparent;
  background:var(--fill);color:var(--muted);font-size:11px;font-weight:600;line-height:1}
.chip:hover{background:var(--fill-2);color:var(--fg)}
.chip[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--focus)}
.plane{display:grid;gap:8px;align-content:start;min-width:0}
.planetop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;
  border:1px solid var(--hair);border-radius:14px;background:var(--panel);box-shadow:var(--shadow)}
.f{min-height:24px;height:24px;padding:0 10px;border-radius:999px;border:1px solid transparent;
  background:var(--fill);color:var(--muted);font-size:11px}
.f:hover{background:var(--fill-2);color:var(--fg)}
.f[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--focus)}
.planetop .n{margin-left:auto;font:500 11px/1 var(--mono);color:var(--faint)}
.planetop .n b{color:var(--fg)}

/* ── group cards ───────────────────────────────────── */
.group{border:1px solid var(--hair);border-radius:14px;background:var(--panel);
  box-shadow:var(--shadow);overflow:hidden}
.grphead{display:flex;align-items:center;gap:9px;width:100%;padding:8px 11px;text-align:left;
  border:0;border-radius:0;background:none;min-height:0;transition:background 160ms ease}
.grphead:hover{background:var(--fill);border-color:transparent}
.grphead .tw{width:9px;color:var(--faint);font-size:8px;flex:0 0 auto;
  transition:transform 200ms ease}
.group[data-open="1"] .grphead .tw{transform:rotate(90deg)}
.grphead h2{font-size:13px;white-space:nowrap;font-weight:600}
.grphead .ct{margin-left:auto;font:500 11px/1 var(--mono);color:var(--faint);flex:0 0 auto}
.meter{display:flex;gap:1px;height:5px;width:96px;border-radius:999px;overflow:hidden;
  background:var(--s-avail);flex:0 0 auto}
.meter i{display:block;height:100%}
.meter i[data-s="requested"]{background:var(--s-sel)}
.meter i[data-s="pending"]{background:var(--s-wait)}
.meter i[data-s="blocked"]{background:var(--s-blk)}
.meter i[data-s="external"]{background:var(--s-uns)}
.group[data-open="0"] .body{display:none}
.body{padding:2px 11px 10px;display:grid;gap:7px}

/* ── rows ──────────────────────────────────────────── */
.matrix{display:grid;gap:0}
.row{display:grid;grid-template-columns:minmax(11rem,1.6fr) minmax(7rem,1.1fr) auto;gap:.55rem;
  align-items:center;min-height:30px;padding:.2rem 0;min-width:0;
  border-bottom:1px solid var(--hair)}
.row:last-child{border:0}
.row:hover{background:var(--fill)}
.row strong{font:400 11.5px/1.35 var(--mono);overflow-wrap:anywhere;font-weight:500}
.row p{margin:0;color:var(--muted);overflow-wrap:anywhere;font-size:11px}
.row-actions{display:flex;gap:.3rem;justify-content:flex-end;flex-wrap:wrap}
.badge{display:inline-block;border-radius:999px;padding:.1rem .45rem;font-family:var(--mono);
  font-size:10.5px;white-space:nowrap}
.pending{background:var(--b-pending-bg);color:var(--b-pending-fg)}
.blocked{background:var(--b-blocked-bg);color:var(--b-blocked-fg)}
.external{background:var(--b-external-bg);color:var(--b-external-fg)}
.requested{background:var(--b-requested-bg);color:var(--b-requested-fg)}
.mono{font-family:var(--mono);font-size:10.5px;overflow-wrap:anywhere;color:var(--muted)}
.help{color:var(--muted);max-width:86ch;font-size:11.5px}
.error{color:var(--bad)}
.row-details{margin:.25rem 0 0;border:0;padding:0}
.row-details summary{font-size:10.5px}
.row-details p{margin:.2rem 0 0}

/* ── forms and disclosure ──────────────────────────── */
.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem}
.form-grid label{display:grid;gap:.2rem;color:var(--muted);font-size:11px}
fieldset{border:1px solid var(--hair);border-radius:10px;margin:0;padding:.5rem}
legend{padding:0 .25rem;color:var(--muted);font-size:11.5px}
details{border-top:1px solid var(--hair);padding-top:.4rem;margin-top:.2rem}
summary{cursor:pointer;color:var(--accent);min-height:26px;font-size:11.5px}
[aria-invalid="true"]{border-color:var(--bad)!important}
.field-error{display:block;color:var(--bad);font-size:10.5px;line-height:1.25}
.receipt-record{white-space:pre-wrap;max-width:100%;max-height:22rem;overflow:auto}
.tip-wrap{display:inline-flex;position:relative;vertical-align:middle;margin-left:.25rem}
.help-button{min-width:24px;min-height:24px;padding:0;border-radius:999px;font-weight:700;
  line-height:1;font-size:11px}
.tooltip{display:none;position:fixed;left:1rem;right:auto;width:auto;z-index:40;
  max-width:calc(100vw - 2rem);padding:.45rem .55rem;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);color:var(--fg);font-size:11.5px;line-height:1.4;box-shadow:var(--shadow-lg)}
.tip-wrap .tooltip[data-open="true"]{display:block}

/* ── ledger ────────────────────────────────────────── */
.ledger{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:14px;flex-wrap:wrap;
  padding:7px 14px;margin:0 -14px;border-top:1px solid var(--hair);background:var(--panel);
  font-size:11.5px}
.ledger i{font-style:normal;color:var(--faint)}
.ledger b{font-family:var(--mono);font-weight:700}
.l-req b{color:var(--s-sel)}.l-wait b{color:var(--warn)}.l-blk b{color:var(--bad)}
.l-ext b{color:var(--muted)}
.ledger .eff{margin-left:auto;color:var(--faint)}

@media(max-width:980px){.work{grid-template-columns:1fr}.rail{position:static}
  .form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.row{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}
  .bar h1{width:100%}.ledger .eff{margin-left:0;width:100%}}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
</style>
</head>
<body>
<a class="skip" href="#workbench">Skip to policy workbench</a>
<div class="stage">
  <header class="bar" aria-label="Policy workbench toolbar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.4" fill="none" stroke="#fffcf7" stroke-opacity=".92" stroke-width="1.7"/><circle cx="12" cy="12" r="2.7" fill="#fffcf7"/><circle cx="17.3" cy="6.7" r="2.1" fill="#fffcf7"/></svg></span>
      <h1>AIH Policy Workbench <span>&middot; no repository required</span></h1>
    </span>
    <label>Preset <select id="profile"><option value="team">Team</option><option value="enterprise">Enterprise</option><option value="vibe">Vibe</option></select></label>
    <span id="status">Ready - no repository is required.</span>
    <button type="button" id="import-policy">Import policy</button>
    <button type="button" id="import-evidence">Import evidence</button>
    <button type="button" id="validate">Validate</button>
    <button type="button" id="export">Export</button>
    <button type="button" id="download">Download policy</button>
    <input class="hidden" id="policy-file" type="file" accept="application/json">
    <input class="hidden" id="evidence-file" type="file" accept="application/json">
  </header>
  <p id="announcement" class="announce" aria-live="polite"></p>
  <main id="workbench" tabindex="-1">
    <p class="boundary">Author portable intent without repository access. Imported audit and authority data is preserved/preflight-only here; AIH engine evaluation in a target repository is the only source of effective state.</p>
    <div class="work">
      <aside class="rail" aria-label="Quick selection">
        <section class="sect">
          <div class="cap">Preset <span class="end" id="rail-posture">team</span></div>
          <p class="help" id="rail-preset-note">Team names a posture only. Vibe selects everything this catalog offers; Enterprise selects ECC Core and offers the rest as additive choices.</p>
        </section>
        <section class="sect"><div class="cap">Languages</div><div class="chips" id="rail-langs"></div></section>
        <section class="sect"><div class="cap">Frameworks</div><div class="chips" id="rail-frameworks"></div></section>
        <section class="sect"><div class="cap">Capabilities</div><div class="chips" id="rail-caps"></div></section>
        <section class="sect"><div class="cap">ECC modules</div><div class="chips" id="rail-modules"></div></section>
      </aside>
      <div class="plane">
        <div class="planetop" role="group" aria-label="Filter inventory">
          <button type="button" class="f" data-filter="all" aria-pressed="true">All</button>
          <button type="button" class="f" data-filter="requested" aria-pressed="false">Selected</button>
          <button type="button" class="f" data-filter="external" aria-pressed="false">Selectable</button>
          <button type="button" class="f" data-filter="pending" aria-pressed="false">Awaiting</button>
          <button type="button" class="f" data-filter="blocked" aria-pressed="false">Blocked</button>
          <button type="button" class="f" id="toggle-groups">Expand all</button>
          <span class="n"><b id="c-shown">0</b> / <b id="c-total">0</b> rows</span>
        </div>
        <section class="group" data-open="1"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH MCP</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><div id="mcp-rows" class="matrix"></div><details><summary>Control boundary</summary><p class="help">Requested controls require target-repository identity, evidence, authority, safety, ownership, and a supported projector before they can become effective.</p></details></div></section>
        <section class="group" data-open="1"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH hooks</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><div id="hook-rows" class="matrix"></div><details><summary>Control boundary</summary><p class="help">Only AIH-owned hook identities are authorable. Custom hooks are not supported.</p></details></div></section>
        <section class="group" data-open="1"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>Framework inventory</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><details><summary>What selecting an externally owned item does</summary><p class="help">ECC and Superpowers own these components and install and run them. Selecting one records requested intent in this policy together with the component's repository, pinned commit and source path, so the request stays portable and reviewable. AIH does not install them, and recording intent is not enforcement. Each row carries the evidence command that earns the audit record and digest, which is what moves a selection into external curation.</p></details><div id="framework-rows" class="matrix"></div></div></section>
        <section class="group" data-open="0"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>Enterprise composition</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><details><summary>What a posture composes, and what it offers</summary><p class="help">These parts are derived from AIH's own ECC selectors, not restated here. Composed parts become requested intent when the posture is chosen; additive parts are yours to add.</p></details><div id="composition-parts" class="matrix"></div></div></section>
        <section class="group" data-open="0"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC / Superpowers curation &mdash; audited intent</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><details><summary>Framework authority</summary><p class="help">AIH preserves audited curation intent for agents, skills, and commands. It does not install, project, or enforce those external assets. A selection becomes curation once it carries an audit record and digest.</p></details><div class="form-grid"><label><span id="curation-framework-label">Framework</span> <select id="curation-framework"></select></label><label>Catalog prefill (optional) <select id="curation-asset"></select></label><label>Item kind <select id="curation-kind"><option value="agent">Agent</option><option value="skill">Skill</option><option value="command">Command</option></select></label><label>Item identifier <input id="curation-id" required></label><label>Source repository <input id="curation-repository" placeholder="owner/repository" required></label><label>Source commit <input id="curation-commit" placeholder="40-character commit" required></label><label>Source path <input id="curation-path" placeholder="relative/path" required></label><label>Audit record <input id="audit-record" value="external-audit" required></label><label>Audit digest <input id="audit-digest" value="sha256:0000000000000000000000000000000000000000000000000000000000000000" required></label><label>Admin clarification <input id="curation-note"></label></div><p><button type="button" id="add-curation">Add external curation intent</button><button type="button" id="cancel-curation-edit" hidden>Cancel curation edit</button></p><div id="curation-rows" class="matrix"></div></div></section>
        <section class="group" data-open="0"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>Your sources</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><details><summary>Custom MCP boundary</summary><p class="help">Custom MCP can only be authored as a fully pinned pending candidate. It has no activation affordance until supported scanning, evidence, and projection exist.</p></details><form id="custom-form"><fieldset><legend>Add pending custom MCP</legend><div class="form-grid"><label>Identifier <input id="custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label><label>Package <input id="custom-package" placeholder="@scope/package" required></label><label>Exact version <input id="custom-version" placeholder="1.2.3" required></label><label>Integrity digest <input id="custom-integrity" placeholder="sha256:..." required></label><label>Evidence record <input id="custom-evidence" required></label><label>Clarification <input id="custom-note"></label></div><p><button type="submit">Add pending custom MCP</button></p></fieldset></form><div id="custom-rows" class="matrix"></div></div></section>
        <section class="group" data-open="0"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>Approval / evidence</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><p id="receipt-state" class="help">No authority receipt imported.</p><button type="button" id="copy-approvals" disabled>Preserve approval subjects in policy (not effective)</button><div id="approval-rows" class="matrix"></div><details open><summary>Finding model: 8 administrator-dispositionable, 6 hard blockers</summary><p class="help">A completed scan reports these 8. The accountable administrator decides each one, because a detector label is evidence and not a verdict. They stay visible and authorable; this workbench does not dispose of them.</p><p id="dispositionable-findings" class="mono"></p><p class="help">These 6 are missing or untrustworthy prerequisites rather than detector findings. No approval substitutes for one, and this workbench cannot waive, approve, or downgrade them.</p><p id="hard-blockers" class="mono"></p></details></div></section>
        <section class="group" data-open="0"><button type="button" class="grphead" data-group><span class="tw" aria-hidden="true">&#9654;</span><h2>Authored config / evaluated report</h2><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="body"><label for="config-preview">Authored policy &mdash; actual schema fields</label><textarea id="config-preview" readonly aria-label="Authored policy actual schema fields"></textarea><label for="report-preview">Evaluated report &mdash; unavailable without target evaluation</label><textarea id="report-preview" readonly aria-label="Evaluated report unavailable without target evaluation"></textarea></div></section>
      </div>
    </div>
  </main>
  <div class="ledger" aria-label="Policy tally">
    <span class="l-req"><i>selected</i> <b id="t-req">0</b></span>
    <span class="l-wait"><i>awaiting</i> <b id="t-wait">0</b></span>
    <span class="l-blk"><i>blocked</i> <b id="t-blk">0</b></span>
    <span class="l-ext"><i>selectable</i> <b id="t-ext">0</b></span>
    <span class="eff">effective: not evaluated &mdash; needs a target repository</span>
  </div>
</div>
<script>
const model=__AIH_DATA__;
const state={policy:structuredClone(model.initialPolicy),receipt:null};
const byId=function(id){return document.getElementById(id)};
const esc=function(value){return String(value).replace(/[&<>"']/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]})};
let helpSequence=0;
const help=function(label,detail){const id="tooltip-"+(++helpSequence);return '<span class="tip-wrap"><button type="button" class="help-button" aria-label="About '+esc(label)+'" aria-describedby="'+id+'" aria-expanded="false" data-tooltip-button="'+id+'">?</button><span id="'+id+'" class="tooltip" role="tooltip" data-open="false">'+esc(detail)+'</span></span>'};
const announce=function(message,error){const node=byId("announcement");node.textContent=message;node.className="announce"+(error?" error":"");byId("status").textContent=message};
const emptyGovernance=function(){return {policyVersion:"1",catalog:{reviewed:[],custom:[]},activations:[],authority:{approvals:[]},externalCuration:[],externalSelections:[]}};
const governance=function(){return state.policy.governance||emptyGovernance()};
const ensureGovernance=function(){if(!state.policy.governance){state.policy.governance=emptyGovernance()}return state.policy.governance};
const policyText=function(){return JSON.stringify(state.policy,null,2)+"\n"};
const validationError=function(path,message){return (path||"policy")+": "+message};
const schemaErrors=function(schema,value,path){
  const errors=[];const location=path||"policy";
  if(schema&&typeof schema==="object"&&Array.isArray(schema.oneOf)){const matches=schema.oneOf.filter(function(option){return schemaErrors(option,value,path).length===0}).length;if(matches!==1){errors.push(validationError(location,"must match exactly one schema variant"))}return errors}
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
const candidateSemantics=function(candidate,path,collection,errors){if(!candidate||typeof candidate!=="object"){return}safePolicyText(candidate.description,path+".description",errors);(candidate.capabilities||[]).forEach(function(value,index){safePolicyText(value,path+".capabilities["+index+"]",errors)});(candidate.risks||[]).forEach(function(value,index){safePolicyText(value,path+".risks["+index+"]",errors)});if(candidate.clarification!==undefined){safePolicyText(candidate.clarification,path+".clarification",errors)}if(candidate.annotation!==undefined){safePolicyText(candidate.annotation,path+".annotation",errors)}const source=candidate.source||{};sourceSemantics(source,path+".source",errors);if(candidate.kind==="mcp"&&(source.type!=="mcp"&&source.type!=="stdio")){errors.push(validationError(path+".source","MCP candidates require exact catalog or pinned stdio identity"))}if(candidate.kind==="mcp"&&source.type==="mcp"&&candidate.id!==source.server){errors.push(validationError(path+".id","must match built-in MCP source.server"))}if(candidate.kind==="mcp"&&Array.isArray(candidate.targets)&&candidate.targets.some(function(target){return target!=="claude"})){errors.push(validationError(path+".targets","MCP candidates support Claude only"))}if(candidate.kind==="hook"&&source.type!=="hook"){errors.push(validationError(path+".source","hook candidates require an AIH-owned hook identity"))}if(candidate.kind==="hook"&&source.type==="hook"&&candidate.id!==source.handler){errors.push(validationError(path+".id","must match AIH hook handler"))}if(candidate.kind==="framework"&&!candidate.framework){errors.push(validationError(path+".framework","is required for framework candidates"))}if(candidate.kind!=="framework"&&candidate.framework!==undefined){errors.push(validationError(path+".framework","is only valid for framework candidates"))}if(candidate.kind==="framework"&&(candidate.projector!=="framework-contract"||candidate.autoExecute||!Array.isArray(candidate.targets)||candidate.targets.length!==1||candidate.targets[0]!=="claude")){errors.push(validationError(path,"framework candidates must be Claude-only, non-autoexecuting framework-contract records"))}if(collection==="reviewed"&&source.type!=="mcp"&&source.type!=="hook"){errors.push(validationError(path+".source","reviewed candidates must reference AIH-shipped MCP or hook identities"))}if(collection==="custom"&&candidate.kind==="mcp"&&source.type!=="stdio"){errors.push(validationError(path+".source","custom MCP candidates must use pinned stdio identity"))}if(collection==="custom"&&candidate.kind==="hook"){errors.push(validationError(path,"custom hooks are unsupported"))}};
const policySemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}const catalog=governanceValue.catalog||{};const reviewed=Array.isArray(catalog.reviewed)?catalog.reviewed:[];const custom=Array.isArray(catalog.custom)?catalog.custom:[];reviewed.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.reviewed["+index+"]","reviewed",errors)});custom.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.custom["+index+"]","custom",errors)});const candidates=reviewed.concat(custom);const ids=candidates.map(function(item){return item.id});if(new Set(ids).size!==ids.length){errors.push(validationError("policy.governance.catalog","candidate identifiers must be unique"))}const activations=Array.isArray(governanceValue.activations)?governanceValue.activations:[];const activeIds=activations.map(function(item){return item.candidate});if(new Set(activeIds).size!==activeIds.length){errors.push(validationError("policy.governance.activations","candidate decisions must be unique"))}activations.forEach(function(activation,index){const candidate=candidates.find(function(item){return item.id===activation.candidate});if(!candidate){errors.push(validationError("policy.governance.activations["+index+"]","references an unknown candidate"))}else if(Array.isArray(activation.targets)&&activation.targets.some(function(target){return !candidate.targets.includes(target)})){errors.push(validationError("policy.governance.activations["+index+"]","targets exceed candidate support"))}});const frameworks=activations.filter(function(activation){return activation.state==="active"&&candidates.some(function(candidate){return candidate.id===activation.candidate&&candidate.kind==="framework"})});if(frameworks.length>1){errors.push(validationError("policy.governance.activations","only one framework intent may be active"))}const approvals=governanceValue.authority&&Array.isArray(governanceValue.authority.approvals)?governanceValue.authority.approvals:[];if(new Set(approvals.map(function(item){return item.id})).size!==approvals.length){errors.push(validationError("policy.governance.authority.approvals","approval identifiers must be unique"))}approvals.forEach(function(approval,index){sourceSemantics(approval.source,"policy.governance.authority.approvals["+index+"].source",errors);isoTime(approval.notBefore,"policy.governance.authority.approvals["+index+"].notBefore",errors);isoTime(approval.expiresAt,"policy.governance.authority.approvals["+index+"].expiresAt",errors)});const curation=Array.isArray(governanceValue.externalCuration)?governanceValue.externalCuration:[];if(new Set(curation.map(function(item){return item.framework})).size!==curation.length){errors.push(validationError("policy.governance.externalCuration","framework records must be unique"))}curation.forEach(function(group,groupIndex){const itemKeys=(group.items||[]).map(function(item){safePolicyText(item.id,"policy.governance.externalCuration["+groupIndex+"].items id",errors);safePath(item.source&&item.source.path,"policy.governance.externalCuration["+groupIndex+"].items path",errors);safePolicyText(item.audit&&item.audit.record,"policy.governance.externalCuration["+groupIndex+"].items audit record",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.externalCuration["+groupIndex+"].items clarification",errors)}return item.kind+"\\u0000"+item.id});if(new Set(itemKeys).size!==itemKeys.length){errors.push(validationError("policy.governance.externalCuration["+groupIndex+"].items","kind/id pairs must be unique"))}});(policy.trust&&Array.isArray(policy.trust.baselineOverrides)?policy.trust.baselineOverrides:[]).forEach(function(item,index){safePath(item.bundle,"policy.trust.baselineOverrides["+index+"].bundle",errors);isoTime(item.approvedAt,"policy.trust.baselineOverrides["+index+"].approvedAt",errors)});return errors};
const policyTextSemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}safePolicyText(governanceValue.policyVersion,"policy.governance.policyVersion",errors);(governanceValue.activations||[]).forEach(function(item,index){if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.activations["+index+"].clarification",errors)}});const approvals=governanceValue.authority&&governanceValue.authority.approvals||[];approvals.forEach(function(item,index){safePolicyText(item.policyVersion,"policy.governance.authority.approvals["+index+"].policyVersion",errors);safePolicyText(item.reason,"policy.governance.authority.approvals["+index+"].reason",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.authority.approvals["+index+"].clarification",errors)}safePolicyText(item.github&&item.github.attestationId,"policy.governance.authority.approvals["+index+"].github.attestationId",errors)});return errors};
const policyProblems=function(){return schemaErrors(model.schema,state.policy,"").concat(policySemantics(state.policy),policyTextSemantics(state.policy))};
let policyValidator=policyProblems;
const commitPolicy=function(previous,message){const problems=policyValidator();if(problems.length){state.policy=previous;announce("Policy change rejected: "+problems.slice(0,3).join("; "),true);render();return false}announce(message);render();return true};
const candidateStatus=function(candidate){if(candidate.kind==="mcp"&&candidate.source&&candidate.source.type==="stdio"){return ["Blocked - no supported projector/scanning/evidence","blocked"]}const activation=governance().activations.find(function(item){return item.candidate===candidate.id});return activation&&activation.state==="active"?["Requested intent - runtime evaluation required","requested"]:["Disabled","pending"]};
/* The note sits inside the first cell so the status badge stays the row's first
   .badge, which is what the inventory contract reads as a row's status. */
const row=function(title,detail,status,kind,action,note){return '<div class="row" data-state="'+esc(kind)+'"><div><strong>'+esc(title)+'</strong>'+help(title,detail)+(note?'<p class="mono">'+esc(note)+'</p>':"")+'</div><span class="badge '+kind+'">'+esc(status)+'</span>'+(action||"")+'</div>'};
const PROVENANCE_PREFIX="Requested by: ";
/* Every origin that declared a control is kept, not just the first. An
   administrator who removes one reason must be able to see that another still
   holds the selection in place. */
const recordOrigin=function(activation,origin){const text=String(activation.clarification||"");const origins=text.indexOf(PROVENANCE_PREFIX)===0?text.slice(PROVENANCE_PREFIX.length).split(", "):[];if(origins.indexOf(origin)===-1){origins.push(origin)}activation.clarification=PROVENANCE_PREFIX+origins.join(", ")};
const controlProvenance=function(id){const activation=governance().activations.find(function(item){return item.candidate===id});const text=activation&&activation.clarification;return typeof text==="string"&&text.indexOf(PROVENANCE_PREFIX)===0?text:""};
const aihControls=function(){return [].concat(model.catalog.mcp.map(function(item){return item.control}),model.catalog.hooks.map(function(item){return item.control}))};
/* Hooks are AIH-owned and custom hooks are unsupported, so knowing exactly what
   runs is the administrator's whole affordance here. */
const hookDisclosure=function(hook){return "Fires on "+hook.behaviour.trigger+"; records "+hook.behaviour.records+" to "+hook.behaviour.artifact+". "+hook.behaviour.failureMode+". Projector "+hook.control.projector+", targets "+hook.control.targets.join(" and ")+", pinned script "+hook.control.source.scriptDigest+"."};
const frameworkAssetCount=function(){return model.catalog.frameworks.reduce(function(total,framework){return total+framework.assets.length},0)};
/* Returns false when the control is already authored, so callers stay idempotent
   instead of authoring the duplicate candidate ids the grammar rejects. */
const requestControl=function(g,control,origin){if(g.catalog.reviewed.some(function(item){return item.id===control.id})){const activation=g.activations.find(function(item){return item.candidate===control.id});if(activation){recordOrigin(activation,origin)}return false}g.catalog.reviewed.push({id:control.id,kind:control.kind,description:"AIH-provided governed control",capabilities:[],risks:[],source:control.source,targets:control.targets,projector:control.projector,lifecycle:control.lifecycle,evidence:{record:"aih-"+control.id}});g.activations.push({candidate:control.id,state:"active",targets:control.targets,clarification:PROVENANCE_PREFIX+origin});return true};
const addReviewed=function(id){const control=aihControls().find(function(item){return item.id===id});if(!control){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(!requestControl(g,control,"administrator")){state.policy=previous;announce("That AIH control is already present.",true);return}commitPolicy(previous,"Requested intent added; it is not active until runtime evaluation.")};
/* Vibe is "everything this catalog offers", and it means it: every AIH control
   is requested and every framework-owned component is selected as requested
   intent. A selection carries the component's pinned source and no audit
   fields, so composing one invents no evidence - which is what kept this
   profile from offering the catalog while third-party rows were unselectable.
   External curation still needs an audit record and a digest, and no preset may
   author one. */
const composeVibeProfile=function(){const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const controls=aihControls();controls.forEach(function(control){requestControl(g,control,"vibe profile")});model.catalog.frameworks.forEach(function(framework){framework.assets.forEach(function(asset){selectFrameworkAsset(g,framework,asset)})});state.policy.minimumPosture="vibe";
/* Report the resulting selection, never the delta: composing over an existing
   selection adds nothing for what is already held, and a delta reads as though
   the rest were left out. */
const selected=g.externalSelections.reduce(function(total,group){return total+group.items.length},0);commitPolicy(previous,"Vibe composed: "+controls.length+" AIH control(s) requested and "+selected+" of "+frameworkAssetCount()+" framework-owned component(s) selected as requested intent with their pinned sources - ECC and Superpowers install and run those, AIH records them. No audit evidence was authored; each selection still owes its own. "+g.catalog.custom.length+" custom candidate(s) stay blocked. Requested intent is not effective until runtime evaluation in a target repository.")};
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
const composeEnterpriseProfile=function(){const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const controls=aihControls();controls.forEach(function(control){requestControl(g,control,"enterprise profile")});const composed=model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection==="composed"});composed.forEach(function(part){selectCompositionPart(g,part)});state.policy.minimumPosture="enterprise";const core=composed.reduce(function(total,part){return total+partSelectedCount(part)},0);const additive=model.catalog.enterpriseComposition.parts.filter(function(part){return part.selection==="additive"});commitPolicy(previous,"Enterprise composed: "+controls.length+" AIH control(s) requested and "+core+" ECC Core component(s) selected as requested intent. "+compositionPartIds("additive")+" further component(s) are offered as additive choices ("+additive.map(function(part){return part.label+" "+part.componentIds.length}).join(", ")+") and are yours to add. "+(frameworkAssetCount()-compositionNamedCount())+" further framework-owned component(s) stay selectable in the inventory. ECC installs and runs all of them; AIH records them. No audit evidence was authored. Requested intent is not effective until runtime evaluation in a target repository.")};
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
const selectFrameworkAsset=function(g,framework,asset){if(curatedFrameworkIds(g,framework.id).indexOf(asset.id)!==-1){return false}let group=g.externalSelections.find(function(item){return item.framework===framework.id});if(group&&group.items.some(function(item){return item.id===asset.id})){return false}if(!group){group={framework:framework.id,items:[]};g.externalSelections.push(group)}group.items.push({kind:asset.kind,id:asset.id,source:{repository:asset.source.repository,commit:asset.source.commit,path:asset.source.path}});return true};
const toggleFrameworkSelection=function(key){const parts=String(key).split("|");const found=frameworkAsset(parts[0],parts[2]);if(!found){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const group=g.externalSelections.find(function(item){return item.framework===found.framework.id});if(group&&group.items.some(function(item){return item.id===found.asset.id})){group.items=group.items.filter(function(item){return item.id!==found.asset.id});if(!group.items.length){g.externalSelections=g.externalSelections.filter(function(item){return item.framework!==found.framework.id})}commitPolicy(previous,"Deselected "+found.asset.id+"; the exported policy no longer records it.");return}if(!selectFrameworkAsset(g,found.framework,found.asset)){state.policy=previous;announce(found.asset.id+" already carries curation evidence; remove that record first to hold it as a bare selection.",true);render();return}commitPolicy(previous,"Selected "+found.asset.id+": requested intent recorded with its pinned source. "+found.framework.id+" installs and runs it; its audit evidence is still owed.")};
const frameworkInventoryRows=function(){return model.catalog.frameworks.flatMap(function(framework){return framework.assets.map(function(asset){const selected=isFrameworkSelected(framework.id,asset.id);const action='<button type="button" data-framework-select="'+esc(framework.id+"|"+asset.kind+"|"+asset.id)+'">'+(selected?"Deselect":"Select")+'</button>'+(asset.curationKind?'<button type="button" data-curation-prefill="'+esc(framework.id+"|"+asset.curationKind+"|"+asset.id)+'">Record curation evidence</button>':"");return row(framework.id+" / "+asset.kind+": "+asset.id,"AIH records this selection with its pinned source; "+framework.id+" installs and runs it. Recording intent is not enforcement.",selected?"Selected - requested intent recorded":"Selectable - "+framework.id+" installs and runs it",selected?"requested":"external",action,"Owned by "+framework.repository+" at "+framework.commit+", source "+asset.source.path+". Evidence: "+evidenceCommand(framework,asset))})}).join("")};
/* A pinned custom candidate must end in an exact command, not in nothing.
   The trust scan command takes a local path or a GitHub owner/repo, so the
   registry package identity is deliberately NOT presented as the scan target -
   emitting it as one would hand over a command that cannot run. */
const customNextAction=function(item){const source=item.source||{};return "Next: run aih trust scan <local path or owner/repo the package is built from> - a registry package identity is not itself a scan target. Bind the completed scan's evidence to this pinned identity: "+source.package+"@"+source.version+", integrity "+source.integrity+", registry "+source.registry+". Until evidence binds to that pin the candidate stays fenced on mandatory-detector-failed, so it remains authorable and visible but cannot become effective."};
const renderRows=function(){const g=governance();byId("mcp-rows").innerHTML=model.catalog.mcp.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];return row(item.id,item.description,status[0],status[1],'<button type="button" data-reviewed="'+esc(item.id)+'" '+(existing?"disabled":"")+'>Request intent</button>',controlProvenance(item.id))}).join("");byId("hook-rows").innerHTML=model.catalog.hooks.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];const provenance=controlProvenance(item.id);return row(item.id,item.description,status[0],status[1],'<button type="button" data-reviewed="'+esc(item.id)+'" '+(existing?"disabled":"")+'>Request intent</button>',hookDisclosure(item)+(provenance?" "+provenance:""))}).join("");byId("custom-rows").innerHTML=g.catalog.custom.length?g.catalog.custom.map(function(item){const status=candidateStatus(item);return row(item.id,"Pinned custom source - no activation affordance",status[0],status[1],"",customNextAction(item))}).join(""):"<p class=\"help\">No custom candidates.</p>";byId("curation-rows").innerHTML=g.externalCuration.length?g.externalCuration.flatMap(function(group){return group.items.map(function(item){return row(group.framework+": "+item.kind+" / "+item.id,"Audit "+item.audit.record+" - report-only", "External guidance - not enforced","external")})}).join(""):"<p class=\"help\">No external curation intent.</p>";byId("framework-rows").innerHTML=frameworkInventoryRows()};
const compositionNamedCount=function(){return model.catalog.enterpriseComposition.parts.reduce(function(total,part){return total+part.componentIds.length},0)};
const partSelectedCount=function(part){const ids=selectedItems(model.catalog.enterpriseComposition.framework).map(function(item){return item.id});return part.componentIds.filter(function(id){return ids.indexOf(id)!==-1}).length};
const renderComposition=function(){const composition=model.catalog.enterpriseComposition;byId("composition-parts").innerHTML='<p class="help">Every component below is owned by '+esc(composition.framework)+', which installs and runs it; AIH records the selection with its pinned source. Choosing Enterprise selects the Core parts. The additive parts are yours to add, here or from any inventory row.</p>'+composition.parts.map(function(part){const selected=partSelectedCount(part);const complete=selected===part.componentIds.length;const action=part.selection==="additive"?'<button type="button" data-composition-add="'+esc(part.id)+'">'+(complete?"Remove these":"Add these")+'</button>':"";return '<div class="row"><div><strong>'+esc(part.label)+'</strong><p>Derived from '+esc(part.rule)+'.</p><p class="mono">'+esc(part.componentIds.join(" "))+'</p></div><span class="badge '+(complete?"requested":"external")+'">'+esc(selected+" of "+part.componentIds.length+" selected"+(part.selection==="additive"?" - additive":" - Core"))+'</span>'+action+'</div>'}).join("")};
const renderReceipt=function(){const receipt=state.receipt;const rows=[];if(receipt&&Array.isArray(receipt.approvals)){receipt.approvals.forEach(function(item){rows.push(row(item.id||"approval",(item.issuer||"unknown issuer")+" — preserved/preflight-only", "Not verified / not effective","pending"))})}if(receipt&&Array.isArray(receipt.evidence)){receipt.evidence.forEach(function(item){rows.push(row(item.id||"evidence",(item.state||"unknown")+" evidence — preserved/preflight-only", "Not verified / not effective","pending"))})}byId("approval-rows").innerHTML=rows.length?rows.join(""):"<p class=\"help\">Import an authority receipt to preserve and inspect its subjects; target-repository verification decides authority.</p>";byId("receipt-state").textContent=receipt?"Receipt preserved for preflight only; this browser does not verify it or create effective approval.":"No authority receipt imported.";byId("copy-approvals").disabled=!(receipt&&Array.isArray(receipt.approvals))};
const renderPreview=function(){byId("config-preview").value=policyText();const g=governance();const requested=g.activations.filter(function(item){return item.state==="active"}).map(function(item){return item.candidate});const custom=g.catalog.custom.map(function(item){return item.id+": Blocked - custom MCP has no supported projector/scanning/evidence"});byId("report-preview").value=["Policy Workbench preview", "", "Requested intent: "+(requested.join(", ")||"none"), "Effective: not evaluated - import this policy into a target repository for engine verification.", "", "External selections: "+externalSelectionGroups().reduce(function(total,item){return total+item.items.length},0)+" requested item(s), audit evidence still owed.","External curation: "+g.externalCuration.reduce(function(total,item){return total+item.items.length},0)+" report-only item(s).", "", "Hard blocked:",].concat(custom.length?custom:["none"]).join("\n")};
const selectedFramework=function(){return model.catalog.frameworks.find(function(item){return item.id===byId("curation-framework").value})||model.catalog.frameworks[0]};
const curatableAssets=function(framework){return framework?framework.assets.filter(function(item){return item.curationKind}):[]};
const prefillCurationAsset=function(){const framework=selectedFramework();const key=byId("curation-asset").value.split("|");const asset=curatableAssets(framework).find(function(item){return item.curationKind===key[0]&&item.id===key[1]});if(!asset){return}byId("curation-kind").value=asset.curationKind;byId("curation-id").value=asset.id;byId("curation-repository").value=asset.source.repository;byId("curation-commit").value=asset.source.commit;byId("curation-path").value=asset.source.path};
const syncFrameworkSelect=function(){const framework=byId("curation-framework");const prior=framework.value;framework.innerHTML=model.catalog.frameworks.map(function(item){return '<option value="'+item.id+'">'+item.id.toUpperCase()+" - external guidance"+'</option>'}).join("");framework.value=prior||model.catalog.frameworks[0].id;const current=selectedFramework();byId("curation-asset").innerHTML='<option value="">Manual item</option>'+curatableAssets(current).map(function(item){return '<option value="'+esc(item.curationKind+"|"+item.id)+'">'+esc(item.curationKind+": "+item.id)+'</option>'}).join("")};
/* ── shell: rail, group cards, filter, ledger ──────────────────────────────
   Ported from the owner-accepted acceptance artifact. The rail exposes the
   catalog's own selectable namespaces as chips; the chips carry the same
   data-framework-select key a row does, so they go through one authoring path
   and cannot drift from the rows they mirror. */
const ROW_STATES=["requested","pending","blocked","external"];
let planeFilter="all";
const railKinds=[["rail-langs","lang"],["rail-frameworks","framework"],["rail-caps","capability"],["rail-modules","module"]];
const buildRail=function(){const framework=eccFramework();if(!framework){return}railKinds.forEach(function(entry){const host=byId(entry[0]);if(!host){return}host.innerHTML=framework.assets.filter(function(asset){return asset.kind===entry[1]}).map(function(asset){return '<button type="button" class="chip" data-framework-select="'+esc(framework.id+"|"+asset.kind+"|"+asset.id)+'" aria-pressed="false">'+esc(asset.id.slice(asset.id.indexOf(":")+1))+'</button>'}).join("")})};
const syncRail=function(){const framework=eccFramework();if(!framework){return}const chosen=selectedItems(framework.id).map(function(item){return item.id});document.querySelectorAll(".chip[data-framework-select]").forEach(function(chip){const id=String(chip.getAttribute("data-framework-select")).split("|")[2];chip.setAttribute("aria-pressed",chosen.indexOf(id)===-1?"false":"true")});const posture=byId("rail-posture");if(posture){posture.textContent=state.policy.minimumPosture||"team"}};
/* One pass over the rendered rows: it applies the filter, counts each group,
   paints its meter, and totals the ledger. Reading the DOM keeps the tally
   honest about what an administrator can actually see. */
const paintShell=function(){const totals={requested:0,pending:0,blocked:0,external:0};let shown=0,total=0;
  document.querySelectorAll(".group").forEach(function(group){const counts={requested:0,pending:0,blocked:0,external:0};let rows=0,visible=0;
    group.querySelectorAll(".row[data-state]").forEach(function(node){const kindState=node.getAttribute("data-state");rows++;if(counts[kindState]!==undefined){counts[kindState]++;totals[kindState]++}const match=planeFilter==="all"||planeFilter===kindState;node.hidden=!match;if(match){visible++}});
    total+=rows;shown+=visible;
    const count=group.querySelector(".ct");if(count){count.textContent=rows?(planeFilter==="all"?String(rows):visible+" / "+rows):""}
    const meter=group.querySelector(".meter");if(meter){meter.innerHTML=rows?ROW_STATES.filter(function(s){return counts[s]}).map(function(s){return '<i data-s="'+s+'" style="width:'+(counts[s]/rows*100)+'%"></i>'}).join(""):""}});
  byId("c-shown").textContent=shown;byId("c-total").textContent=total;
  ROW_STATES.forEach(function(s){const node=byId(s==="requested"?"t-req":s==="pending"?"t-wait":s==="blocked"?"t-blk":"t-ext");if(node){node.textContent=totals[s]}});};
document.addEventListener("click",function(event){const head=event.target.closest&&event.target.closest("[data-group]");if(!head){return}const group=head.closest(".group");group.dataset.open=group.dataset.open==="1"?"0":"1";head.setAttribute("aria-expanded",group.dataset.open==="1"?"true":"false")});
document.addEventListener("click",function(event){const filter=event.target.closest&&event.target.closest(".f[data-filter]");if(!filter){return}planeFilter=filter.getAttribute("data-filter");document.querySelectorAll(".f[data-filter]").forEach(function(node){node.setAttribute("aria-pressed",node===filter?"true":"false")});paintShell()});
const render=function(){byId("profile").value=state.policy.minimumPosture||"team";syncFrameworkSelect();renderRows();renderComposition();renderReceipt();renderPreview();syncRail();paintShell();byId("dispositionable-findings").textContent=model.findings.dispositionable.join(" | ");byId("hard-blockers").textContent=model.findings.fenced.join(" | ");if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}};
byId("profile").addEventListener("change",function(event){const value=event.target.value;if(value==="vibe"){composeVibeProfile();return}if(value==="enterprise"){composeEnterpriseProfile();return}const previous=structuredClone(state.policy);state.policy.minimumPosture=value;commitPolicy(previous,"Profile changed.")});
const closeTooltips=function(){document.querySelectorAll(".tooltip[data-open='true']").forEach(function(tip){tip.setAttribute("data-open","false")});document.querySelectorAll("[data-tooltip-button][aria-expanded='true']").forEach(function(button){button.setAttribute("aria-expanded","false")})};
const openTooltip=function(button){closeTooltips();button.setAttribute("aria-expanded","true");button.removeAttribute("data-tooltip-dismissed");const tip=byId(button.getAttribute("data-tooltip-button"));if(tip){const rect=button.getBoundingClientRect();const width=Math.min(368,Math.max(24,window.innerWidth-32));tip.style.width=width+"px";tip.style.left=Math.max(16,Math.min(rect.left,window.innerWidth-16-width))+"px";tip.style.top=Math.max(16,rect.bottom+4)+"px";tip.setAttribute("data-open","true")}};
document.addEventListener("focusin",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton&&!helpButton.hasAttribute("data-tooltip-dismissed")){openTooltip(helpButton)}});
document.addEventListener("focusout",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton){helpButton.removeAttribute("data-tooltip-dismissed");closeTooltips()}});
document.addEventListener("pointerover",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper){const helpButton=wrapper.querySelector("[data-tooltip-button]");if(helpButton){openTooltip(helpButton)}}});
document.addEventListener("pointerout",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper&&!wrapper.contains(event.relatedTarget)){closeTooltips()}});
document.addEventListener("click",function(event){const helpButton=event.target.closest("[data-tooltip-button]");if(helpButton){openTooltip(helpButton);return}const target=event.target.closest("[data-reviewed]");if(target){addReviewed(target.getAttribute("data-reviewed"));return}closeTooltips()});
document.addEventListener("keydown",function(event){if(event.key==="Escape"){const focused=document.activeElement;closeTooltips();if(focused&&focused.matches("[data-tooltip-button]")){focused.setAttribute("data-tooltip-dismissed","true");focused.focus()}}});
byId("curation-framework").addEventListener("change",function(){syncFrameworkSelect();prefillCurationAsset()});
byId("curation-asset").addEventListener("change",prefillCurationAsset);
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-framework-select]");if(!button){return}toggleFrameworkSelection(button.getAttribute("data-framework-select"))});
/* One control per additive part, reversible from itself: a part already fully
   selected removes exactly its own components and leaves anything another part
   or a row click selected alone. */
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-composition-add]");if(!button){return}const part=model.catalog.enterpriseComposition.parts.find(function(item){return item.id===button.getAttribute("data-composition-add")});if(!part){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}if(partSelectedCount(part)===part.componentIds.length){const group=g.externalSelections.find(function(item){return item.framework===model.catalog.enterpriseComposition.framework});if(group){group.items=group.items.filter(function(item){return part.componentIds.indexOf(item.id)===-1});if(!group.items.length){g.externalSelections=g.externalSelections.filter(function(item){return item.framework!==model.catalog.enterpriseComposition.framework})}}commitPolicy(previous,"Removed "+part.label+": "+part.componentIds.length+" component(s) are no longer requested.");return}const added=selectCompositionPart(g,part);commitPolicy(previous,"Added "+part.label+": "+added+" component(s) selected as requested intent with their pinned sources. Audit evidence is still owed for each.")});
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-curation-prefill]");if(!button){return}const key=String(button.getAttribute("data-curation-prefill")).split("|");byId("curation-framework").value=key[0];syncFrameworkSelect();byId("curation-asset").value=key[1]+"|"+key[2];prefillCurationAsset();announce("Curation form prefilled from "+key[2]+"; add an audit record to record report-only intent.")});
byId("add-curation").addEventListener("click",function(){const frameworkId=byId("curation-framework").value;const kind=byId("curation-kind").value;const id=byId("curation-id").value.trim();const repository=byId("curation-repository").value.trim();const commit=byId("curation-commit").value.trim();const path=byId("curation-path").value.trim();const record=byId("audit-record").value.trim();const digest=byId("audit-digest").value.trim();const unsafePath=!path||path.startsWith("/")||path.startsWith("./")||path.includes("\\")||path.includes("//")||path.split("/").some(function(part){return !part||part==="."||part===".."});if(!/^(agent|skill|command)$/.test(kind)||!id||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!/^[0-9a-f]{40}$/.test(commit)||unsafePath||!record||!/^sha256:[0-9a-f]{64}$/.test(digest)){announce("Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",true);return}const g=governance();let group=g.externalCuration.find(function(item){return item.framework===frameworkId});if(!group){group={framework:frameworkId,items:[]};g.externalCuration.push(group)}if(group.items.some(function(item){return item.kind===kind&&item.id===id})){announce("That external curation item is already present.",true);return}const previous=structuredClone(state.policy);group.items.push({kind:kind,id:id,source:{repository:repository,commit:commit,path:path},audit:{record:record,digest:digest},clarification:byId("curation-note").value.trim()||undefined});commitPolicy(previous,"External curation intent added; it is report-only and not enforced by AIH.")});
byId("custom-form").addEventListener("submit",function(event){event.preventDefault();const id=byId("custom-id").value.trim(),pkg=byId("custom-package").value.trim(),version=byId("custom-version").value.trim(),integrity=byId("custom-integrity").value.trim(),evidence=byId("custom-evidence").value.trim(),note=byId("custom-note").value.trim();const g=governance();if(g.catalog.custom.some(function(item){return item.id===id})){announce("Custom candidate identifier already exists.",true);return}const previous=structuredClone(state.policy);g.catalog.custom.push({id:id,kind:"mcp",description:"Pending custom MCP",capabilities:[],risks:["custom source"],source:{type:"stdio",resolver:"npx",registry:"https://registry.npmjs.org",package:pkg,version:version,integrity:integrity},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:evidence},clarification:note||undefined});if(commitPolicy(previous,"Pending custom MCP added. It cannot be activated.")){event.target.reset()}});
const readFile=function(input,callback){const file=input.files&&input.files[0];if(!file){return}const reader=new FileReader();reader.onload=function(){callback(String(reader.result||""))};reader.readAsText(file)};
byId("import-policy").addEventListener("click",function(){byId("policy-file").click()});byId("policy-file").addEventListener("change",function(event){readFile(event.target,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}const problems=schemaErrors(model.schema,value,"").concat(policySemantics(value),policyTextSemantics(value));if(problems.length){throw new Error(problems.slice(0,3).join("; "))}state.policy=value;announce("Policy imported without transformation after schema and policy-grammar validation.");render()}catch(error){announce("Policy import rejected: "+(error&&error.message?error.message:"valid policy JSON required"),true)}})});
byId("import-evidence").addEventListener("click",function(){byId("evidence-file").click()});byId("evidence-file").addEventListener("change",function(event){readFile(event.target,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}state.receipt=value;announce("Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.");renderReceipt()}catch(error){announce("Evidence import failed: valid JSON object required.",true)}})});
byId("copy-approvals").addEventListener("click",function(){if(state.receipt&&Array.isArray(state.receipt.approvals)){const previous=structuredClone(state.policy);governance().authority.approvals=structuredClone(state.receipt.approvals);commitPolicy(previous,"Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.")}});
byId("validate").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Schema and policy-grammar validation failed: "+problems.slice(0,3).join("; "),true)}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.")}renderPreview()});
byId("export").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Export blocked: "+problems.slice(0,3).join("; "),true);return}renderPreview();announce("Policy export preview refreshed from the actual policy schema and grammar.")});
byId("download").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Download blocked: "+problems.slice(0,3).join("; "),true);return}const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started.")});
byId("toggle-groups").addEventListener("click",function(event){const groups=[].slice.call(document.querySelectorAll(".group"));const open=groups.some(function(group){return group.dataset.open!=="1"});groups.forEach(function(group){group.dataset.open=open?"1":"0";const head=group.querySelector("[data-group]");if(head){head.setAttribute("aria-expanded",open?"true":"false")}});event.target.textContent=open?"Collapse all":"Expand all"});
document.querySelectorAll("[data-group]").forEach(function(head){head.setAttribute("aria-expanded",head.closest(".group").dataset.open==="1"?"true":"false")});
buildRail();
render();
</script>
<script>
/* Enhancements kept separate so the portable workbench remains dependency-free. */
(function(){
  const ids={curation:["curation-kind","curation-id","curation-repository","curation-commit","curation-path","audit-record","audit-digest","curation-note"],custom:["custom-id","custom-package","custom-version","custom-integrity","custom-evidence","custom-note"]};
  const status=byId("status");status.removeAttribute("aria-live");status.removeAttribute("role");
  const fieldError=function(id,message){const input=byId(id);if(!input){return}let node=byId(id+"-error");if(!node){node=document.createElement("span");node.id=id+"-error";node.className="field-error";node.hidden=true;input.insertAdjacentElement("afterend",node)}node.textContent=message||"";node.hidden=!message;if(message){input.setAttribute("aria-invalid","true");input.setAttribute("aria-describedby",node.id)}else{input.removeAttribute("aria-invalid");input.removeAttribute("aria-describedby")}};
  const clearFields=function(group){ids[group].forEach(function(id){fieldError(id,"")})};
  const recover=function(group,issues,summary){clearFields(group);let first;Object.keys(issues).forEach(function(id){fieldError(id,issues[id]);first=first||byId(id)});announce(summary,true);if(first){first.focus()}};
  const visible=function(value){return typeof value==="string"&&value===value.trim()&&value.length>=1&&value.length<=500&&/\S/u.test(value)&&!/\p{C}/u.test(value)};
const safeBrowserHttpsOrigin=function(origin){if(typeof origin!=="string"){return false}try{const pattern=new RegExp(model.semantics.httpsOriginPattern,"u");const url=new URL(origin);return origin===origin.trim()&&pattern.test(origin)&&url.protocol==="https:"&&url.username===""&&url.password===""&&url.pathname==="/"&&url.search===""&&url.hash===""}catch(_error){return false}};
const safeBrowserArgument=function(argument){if(typeof argument!=="string"||argument.length<1||argument.length>500){return false}const prefix=(model.semantics.httpsOriginArgumentPrefixes||[]).find(function(item){return argument.startsWith(item)});if(prefix){return safeBrowserHttpsOrigin(argument.slice(prefix.length))}return !argument.startsWith("/")&&!argument.startsWith("\\")&&!argument.includes("..")&&!/[\\/;|&$<>\p{C}]/u.test(argument)&&!argument.includes(String.fromCharCode(96))};
const browserArgumentErrors=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}const sources=[];const catalog=governanceValue.catalog||{};["reviewed","custom"].forEach(function(collection){(catalog[collection]||[]).forEach(function(candidate,index){sources.push({source:candidate&&candidate.source,path:"policy.governance.catalog."+collection+"["+index+"]"})})});const approvals=governanceValue.authority&&governanceValue.authority.approvals||[];approvals.forEach(function(approval,index){sources.push({source:approval&&approval.source,path:"policy.governance.authority.approvals["+index+"]"})});sources.forEach(function(entry){const source=entry.source;if(source&&(source.type==="package"||source.type==="stdio")&&!safeBrowserHttpsOrigin(source.registry)){errors.push(validationError(entry.path+".source.registry","must be an exact HTTPS origin"))}if(source&&source.type==="command"&&Array.isArray(source.args)){source.args.forEach(function(argument,index){if(!safeBrowserArgument(argument)){errors.push(validationError(entry.path+".source.args["+index+"]","must be a safe relative argument or exact HTTPS registry/index origin"))}})}});return errors};
  const browserRootErrors=function(policy){const errors=[];const overrides=policy&&policy.trust&&Array.isArray(policy.trust.baselineOverrides)?policy.trust.baselineOverrides:[];overrides.forEach(function(item,index){safePath(item.bundle,"policy.trust.baselineOverrides["+index+"].bundle",errors);isoTime(item.approvedAt,"policy.trust.baselineOverrides["+index+"].approvedAt",errors)});return errors};
  const browserSemanticErrors=function(policy){return policySemantics(policy).filter(function(error){return !/\.source\.args\[\d+\]: must be a safe relative argument/.test(error)}).concat(browserArgumentErrors(policy),browserRootErrors(policy))};
  const browserProblems=function(){return schemaErrors(model.schema,state.policy,"").concat(browserSemanticErrors(state.policy),policyTextSemantics(state.policy))};
  policyValidator=browserProblems;
  const readInput=function(input,callback){const file=input.files&&input.files[0];if(!file){return}const reader=new FileReader();reader.onload=function(){callback(String(reader.result||""))};reader.readAsText(file)};
  byId("policy-file").addEventListener("change",function(event){event.stopImmediatePropagation();readInput(event.currentTarget,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}const problems=schemaErrors(model.schema,value,"").concat(browserSemanticErrors(value),policyTextSemantics(value));if(problems.length){throw new Error(problems.slice(0,3).join("; "))}state.policy=value;state.editing=null;announce("Policy imported without transformation after schema and policy-grammar validation.");render()}catch(error){announce("Policy import rejected: "+(error&&error.message?error.message:"valid policy JSON required"),true)}},true);
  },true);
  const runValidation=function(event,mode){event.preventDefault();event.stopImmediatePropagation();const problems=browserProblems();if(problems.length){announce((mode==="download"?"Download blocked: ":mode==="export"?"Export blocked: ":"Schema and policy-grammar validation failed: ")+problems.slice(0,3).join("; "),true);return false}if(mode==="download"){const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started.")}else if(mode==="export"){renderPreview();announce("Policy export preview refreshed from the actual policy schema and grammar.")}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.");renderPreview()}return true};
  ["validate","export","download"].forEach(function(id){byId(id).addEventListener("click",function(event){runValidation(event,id)},true)});
byId("copy-approvals").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();if(!(state.receipt&&Array.isArray(state.receipt.approvals))){return}const previous=structuredClone(state.policy);ensureGovernance().authority.approvals=structuredClone(state.receipt.approvals);if(browserProblems().length){state.policy=previous;announce("Approval preservation rejected: imported subjects do not satisfy the actual policy grammar.",true);render();return}announce("Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.");render()},true);
  const curationIssues=function(){const values={kind:byId("curation-kind").value,id:byId("curation-id").value.trim(),repository:byId("curation-repository").value.trim(),commit:byId("curation-commit").value.trim(),path:byId("curation-path").value.trim(),record:byId("audit-record").value.trim(),digest:byId("audit-digest").value.trim(),note:byId("curation-note").value.trim()};const issues={};if(!/^(agent|skill|command)$/.test(values.kind)){issues["curation-kind"]="Choose agent, skill, or command."}if(!visible(values.id)){issues["curation-id"]="Use visible text with no hidden Unicode."}if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)){issues["curation-repository"]="Use owner/repository."}if(!/^[0-9a-f]{40}$/.test(values.commit)){issues["curation-commit"]="Use a lowercase 40-character commit."}if(!values.path||values.path.startsWith("/")||values.path.startsWith("./")||values.path.includes("\\")||values.path.includes("//")||values.path.split("/").some(function(part){return !part||part==="."||part===".."})){issues["curation-path"]="Use a safe repo-relative POSIX path."}if(!visible(values.record)){issues["audit-record"]="Use visible audit-record text."}if(!/^sha256:[0-9a-f]{64}$/.test(values.digest)){issues["audit-digest"]="Use sha256: followed by 64 lowercase hex characters."}if(values.note&&!visible(values.note)){issues["curation-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const customIssues=function(){const values={id:byId("custom-id").value.trim(),pkg:byId("custom-package").value.trim(),version:byId("custom-version").value.trim(),integrity:byId("custom-integrity").value.trim(),evidence:byId("custom-evidence").value.trim(),note:byId("custom-note").value.trim()};const issues={};if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.id)){issues["custom-id"]="Use a lowercase stable identifier."}if(!/^@?[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(values.pkg)){issues["custom-package"]="Use a package identity."}if(!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(values.version)){issues["custom-version"]="Use an exact package version."}if(!/^sha256:[0-9a-f]{64}$/.test(values.integrity)){issues["custom-integrity"]="Use sha256: followed by 64 lowercase hex characters."}if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.evidence)){issues["custom-evidence"]="Use a lowercase evidence record identifier."}if(values.note&&!visible(values.note)){issues["custom-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const setCurationEditState=function(editing){byId("curation-framework").disabled=editing;byId("curation-framework-label").textContent=editing?"Framework (locked; remove and re-add to change)":"Framework";byId("cancel-curation-edit").hidden=!editing};
  const resetCurationEditor=function(){state.editing=null;setCurationEditState(false);clearFields("curation")};
  ids.curation.forEach(function(id){byId(id).addEventListener("input",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")});byId(id).addEventListener("change",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")})});
  ids.custom.forEach(function(id){byId(id).addEventListener("input",function(){const result=customIssues();fieldError(id,result.issues[id]||"")})});
  byId("add-curation").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();const result=curationIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="curation"?state.editing:null;const frameworkId=editing?editing.framework:byId("curation-framework").value;const existingGroup=governance().externalCuration.find(function(item){return item.framework===frameworkId});const duplicate=existingGroup&&existingGroup.items.some(function(item,index){return item.kind===values.kind&&item.id===values.id&&(!editing||editing.framework!==existingGroup.framework||editing.index!==index)});if(duplicate){result.issues["curation-id"]="That framework item already exists."}if(Object.keys(result.issues).length){recover("curation",result.issues,"Correct the highlighted curation fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const group=g.externalCuration.find(function(item){return item.framework===frameworkId});const item={kind:values.kind,id:values.id,source:{repository:values.repository,commit:values.commit,path:values.path},audit:{record:values.record,digest:values.digest}};if(values.note){item.clarification=values.note}if(editing){const target=g.externalCuration.find(function(entry){return entry.framework===editing.framework});if(!target||!target.items[editing.index]){state.policy=previous;announce("The curation item changed before it could be saved; nothing was replaced.",true);return}target.items[editing.index]=item}else if(group){group.items.push(item)}else{g.externalCuration.push({framework:frameworkId,items:[item]})}if(commitPolicy(previous,editing?"External curation intent updated; it remains report-only and not enforced by AIH.":"External curation intent added; it is report-only and not enforced by AIH.")){resetCurationEditor();byId("curation-id").value="";byId("curation-note").value=""}},true);
  byId("cancel-curation-edit").addEventListener("click",function(){if(!(state.editing&&state.editing.kind==="curation")){return}resetCurationEditor();announce("Curation edit cancelled. Select a framework to add a new report-only item.")});
  byId("custom-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const result=customIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="custom"?state.editing:null;const duplicate=governance().catalog.custom.some(function(item,index){return item.id===values.id&&(!editing||editing.index!==index)});if(duplicate){result.issues["custom-id"]="That pending custom candidate already exists."}if(Object.keys(result.issues).length){recover("custom",result.issues,"Correct the highlighted custom-candidate fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const item={id:values.id,kind:"mcp",description:"Pending custom MCP",capabilities:[],risks:["custom source"],source:{type:"stdio",resolver:"npx",registry:"https://registry.npmjs.org",package:values.pkg,version:values.version,integrity:values.integrity},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:values.evidence}};if(values.note){item.clarification=values.note}if(editing){g.catalog.custom[editing.index]=item}else{g.catalog.custom.push(item)}if(commitPolicy(previous,editing?"Pending custom MCP updated. It remains blocked and cannot be activated.":"Pending custom MCP added. It cannot be activated.")){state.editing=null;clearFields("custom");event.currentTarget.reset()}},true);
  const detail=function(row,label,lines){if(row.querySelector(".row-details")){return}const primary=row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const body=document.createElement("p");body.className="mono";body.textContent=lines.join(" · ");disclosure.append(summary,body);primary.append(disclosure)};
  const importedRecordText=function(record){try{return JSON.stringify(record,null,2)}catch(_error){return "[unserializable imported record]"}};
  const receiptDetail=function(row,label,type,record){if(row.querySelector(".row-details")){return}const primary=row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const notice=document.createElement("p");notice.className="mono";notice.textContent="Status: preserved/preflight-only; not verified or effective. Full imported "+type+" record (untrusted):";const body=document.createElement("pre");body.className="mono receipt-record";body.textContent=importedRecordText(record);disclosure.append(summary,notice,body);primary.append(disclosure)};
  const action=function(row,label,kind,index,framework){let actions=row.querySelector(".row-actions");if(!actions){actions=document.createElement("div");actions.className="row-actions";row.append(actions)}if(actions.querySelector("[data-workbench-action]")){return}[ ["Edit / prefill","edit"],["Remove","remove"] ].forEach(function(item){const button=document.createElement("button");button.type="button";button.textContent=item[0];button.setAttribute("aria-label",item[0]+" "+label);button.dataset.workbenchAction=item[1];button.dataset.workbenchKind=kind;button.dataset.workbenchIndex=String(index);if(framework){button.dataset.workbenchFramework=framework}actions.append(button)})};
  const enhanceRows=function(){setCurationEditState(Boolean(state.editing&&state.editing.kind==="curation"));const g=governance();Array.from(byId("custom-rows").querySelectorAll(".row")).forEach(function(row,index){const item=g.catalog.custom[index];if(!item){return}detail(row,item.id,["Status: pending and blocked; no activation affordance.","Package: "+item.source.package+" @ "+item.source.version,"Registry: "+item.source.registry,"Integrity: "+item.source.integrity,"Evidence record: "+item.evidence.record,"Clarification: "+(item.clarification||"none")]);action(row,item.id,"custom",index)});let curationIndex=0;g.externalCuration.forEach(function(group){group.items.forEach(function(item,index){const row=byId("curation-rows").querySelectorAll(".row")[curationIndex++];if(!row){return}detail(row,group.framework+" "+item.kind+" "+item.id,["Status: report-only external guidance; not enforced by AIH.","Repository: "+item.source.repository,"Commit: "+item.source.commit,"Path: "+item.source.path,"Audit record: "+item.audit.record,"Audit digest: "+item.audit.digest,"Clarification: "+(item.clarification||"none")]);action(row,item.id,"curation",index,group.framework)})});const receipt=state.receipt||{};const approvalItems=Array.isArray(receipt.approvals)?receipt.approvals:[];const evidenceItems=Array.isArray(receipt.evidence)?receipt.evidence:[];const receiptRows=byId("approval-rows").querySelectorAll(".row");approvalItems.forEach(function(item,index){const row=receiptRows[index];if(!row){return}receiptDetail(row,item.id||"approval","approval",item)});evidenceItems.forEach(function(item,index){const row=receiptRows[approvalItems.length+index];if(!row){return}receiptDetail(row,item.id||"evidence","evidence",item)})};
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest('[data-workbench-kind="curation"]');if(!button){return}if(button.dataset.workbenchAction==="edit"){setCurationEditState(true)}if(button.dataset.workbenchAction==="remove"){resetCurationEditor()}});
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-workbench-action]");if(!button){return}event.preventDefault();const g=governance();const index=Number(button.dataset.workbenchIndex);const kind=button.dataset.workbenchKind;const mode=button.dataset.workbenchAction;if(!Number.isInteger(index)){return}if(kind==="custom"){const item=g.catalog.custom[index];if(!item){return}if(mode==="edit"){byId("custom-id").value=item.id;byId("custom-package").value=item.source.package;byId("custom-version").value=item.source.version;byId("custom-integrity").value=item.source.integrity;byId("custom-evidence").value=item.evidence.record;byId("custom-note").value=item.clarification||"";state.editing={kind:"custom",index:index};announce("Editing pending custom MCP. Save validates before replacing the existing blocked candidate.")}else{const previous=structuredClone(state.policy);g.catalog.custom.splice(index,1);if(commitPolicy(previous,"Pending custom MCP removed; it was never active.")){state.editing=null}}}else if(kind==="curation"){const framework=button.dataset.workbenchFramework;const group=g.externalCuration.find(function(entry){return entry.framework===framework});const item=group&&group.items[index];if(!item){return}if(mode==="edit"){byId("curation-framework").value=framework;syncFrameworkSelect();byId("curation-kind").value=item.kind;byId("curation-id").value=item.id;byId("curation-repository").value=item.source.repository;byId("curation-commit").value=item.source.commit;byId("curation-path").value=item.source.path;byId("audit-record").value=item.audit.record;byId("audit-digest").value=item.audit.digest;byId("curation-note").value=item.clarification||"";state.editing={kind:"curation",framework:framework,index:index};announce("Editing external curation. Save validates before replacing the report-only intent.")}else{const previous=structuredClone(state.policy);group.items.splice(index,1);if(!group.items.length){g.externalCuration=g.externalCuration.filter(function(entry){return entry!==group})}if(commitPolicy(previous,"External curation intent removed; it was report-only and never enforced by AIH.")){state.editing=null}}}});
  window.__aihPolicyWorkbenchEnhanceRows=enhanceRows;[byId("custom-rows"),byId("curation-rows"),byId("approval-rows")].forEach(function(node){new MutationObserver(enhanceRows).observe(node,{childList:true})});enhanceRows();
})();
</script>
</body>
</html>`.replace("__AIH_DATA__", safeScriptJson(model));
}
