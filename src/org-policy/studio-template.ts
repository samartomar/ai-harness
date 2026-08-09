import type { PolicyStudioModel } from "./studio-model.js";

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

/** Portable, dependency-free policy authoring surface. */
export function policyStudioHtml(model: PolicyStudioModel): string {
  const hookRegistryOwners = safeHtmlAttribute(
    [...new Set(model.catalog.hookRegistry.entries.map((entry) => entry.ownerLabel))].join(" "),
  );
  return String.raw`<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIH Policy Workbench</title>
<style>
/* Policy Workbench - Sahara, warm minimalism. Ported verbatim in structure from
   the owner-accepted acceptance artifact and wired to the real catalog.

   Sun-baked simplicity: burnt sienna on warm linen, EB Garamond headings against
   Manrope labels, whitespace as the primary tool. The whole palette is warm-shifted;
   even the grays carry warm undertones, and there is no cold white anywhere.

   The state ramp stays semantic while going warm. Selected and requested are the
   same sienna hue at different strengths, because requested is a weaker form of the
   same intent; gold means evidence is still owed; the dusty rose tertiary is spent
   on blocked, which is the one state that must stop you; taupe means the catalog
   cannot reach it at all.

   No blur anywhere, by measurement rather than taste: three drifting blur(90px)
   layers spend a 63ms frame per row toggle and 18ms without them. The field is the
   same three radial gradients painted straight onto the background.

   Fonts are stacks, not webfonts: this artifact opens with no repository and no
   network, so a remote font would be a dependency it must not have.

   Interactive floors are this repository's, not the artifact's: controls stay at
   32px and chips at 24px (WCAG 2.2 target size). Compactness does not lower a
   tap target. */
:root{
  --ease-out:cubic-bezier(.16,1,.3,1);
  --spring:cubic-bezier(.34,1.35,.44,1);
  --display:"EB Garamond",Georgia,"Times New Roman",serif;
  --sans:"Manrope","Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  --shadow-soft:0 2px 16px rgba(58,48,42,.04);
}
html[data-theme="light"]{
  color-scheme:light;
  --bg:#faf5ee;--bg-deep:#f2ebe1;
  --glass:rgba(255,252,247,.72);--glass-strong:#fffcf7;--glass-line:rgba(216,208,200,.6);
  --fill:rgba(58,48,42,.045);--fill-2:rgba(58,48,42,.09);
  --ink:#3a302a;--ink-2:#6b5d52;--ink-3:#7d6f62;
  --accent:#c2652a;--accent-ink:#a8541f;--accent-soft:rgba(194,101,42,.1);--accent-line:rgba(194,101,42,.34);
  --cyan:#a8541f;--cyan-soft:rgba(194,101,42,.1);
  --amber:#8a6316;--amber-soft:rgba(169,123,31,.12);
  --danger:#8c3c3c;--danger-soft:rgba(140,60,60,.1);
  --on-accent:#fffcf7;
  --s-sel:#c2652a;--s-req:#c98a4f;--s-wait:#a9871f;--s-blk:#8c3c3c;
  --s-uns:#8f8474;--s-avail:rgba(58,48,42,.13);
  --blob-1:rgba(194,101,42,.09);--blob-2:rgba(201,162,39,.07);--blob-3:rgba(140,60,60,.06);
  --shadow-lg:0 8px 40px -12px rgba(58,48,42,.14);
  --b-pending-bg:#f5e9c8;--b-pending-fg:#6b4c08;
  --b-blocked-bg:#f3dcdc;--b-blocked-fg:#7a2f2f;
  --b-external-bg:#eae3d8;--b-external-fg:#544a3e;
  --b-requested-bg:#f7e0cf;--b-requested-fg:#8f4517;
}
/* Sahara after sundown: the same warmth, inverted. Warm charcoal, never blue-black. */
html[data-theme="dark"]{
  color-scheme:dark;
  --bg:#1c1714;--bg-deep:#15110f;
  --glass:rgba(46,38,33,.66);--glass-strong:#2a231e;--glass-line:rgba(216,208,200,.14);
  --fill:rgba(240,228,214,.07);--fill-2:rgba(240,228,214,.13);
  --ink:#f4ece1;--ink-2:#cbbdad;--ink-3:#a2937f;
  --accent:#e08344;--accent-ink:#eda468;--accent-soft:rgba(224,131,68,.14);--accent-line:rgba(224,131,68,.4);
  --cyan:#eda468;--cyan-soft:rgba(224,131,68,.12);
  --amber:#d9b23f;--amber-soft:rgba(217,178,63,.14);
  --danger:#c96363;--danger-soft:rgba(201,99,99,.14);
  --on-accent:#231c17;
  --s-sel:#e08344;--s-req:#a9754c;--s-wait:#d9b23f;--s-blk:#c96363;
  --s-uns:#8a7f72;--s-avail:rgba(240,228,214,.16);
  --blob-1:rgba(224,131,68,.1);--blob-2:rgba(217,178,63,.07);--blob-3:rgba(201,99,99,.06);
  --shadow-lg:0 12px 48px -14px rgba(0,0,0,.5);
  --b-pending-bg:#40361c;--b-pending-fg:#e8cd7a;
  --b-blocked-bg:#45272a;--b-blocked-fg:#f0b3b3;
  --b-external-bg:#332c25;--b-external-fg:#cbbdad;
  --b-requested-bg:#4a2f1c;--b-requested-fg:#f0a670;
}
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%}
/* vh first, dvh second: dynamic viewport units resolve to 0 in engines with no
   live visual viewport, which collapses the whole stage to nothing. The vh
   declaration is the floor; dvh upgrades it wherever it actually resolves. */
body{margin:0;min-height:100vh;min-height:100dvh;overflow:hidden;font:400 13px/1.5 var(--sans);
  color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
h1,h2,h3,p{margin:0}
button{font-family:inherit;color:inherit;cursor:pointer;border:0;background:none}
code{font-family:var(--mono)}
input,select,textarea{font:inherit}
*:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px}
.skip:focus{left:.75rem;top:.75rem;z-index:999;background:var(--glass-strong);padding:.5rem;
  border-radius:8px;border:1px solid var(--glass-line)}
.hidden{display:none}

/* ── field ───────────────────────────────────────────── */
.field{position:fixed;inset:0;overflow:hidden;
  background:
    radial-gradient(56vw 56vw at 14% -6%,var(--blob-1),transparent 65%),
    radial-gradient(44vw 44vw at 92% 22%,var(--blob-2),transparent 65%),
    radial-gradient(40vw 40vw at 44% 118%,var(--blob-3),transparent 65%),
    var(--bg)}
.grain{position:absolute;inset:0;pointer-events:none;opacity:.5;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.16'/%3E%3C/svg%3E")}

/* ── stage ───────────────────────────────────────────── */
.stage{position:relative;z-index:1;height:100vh;height:100dvh;display:grid;grid-template-rows:56px auto auto minmax(0,1fr) 34px}
/* Owner ticker: one surface at a time, above everything. Its entries come from
   a list, not from markup, so a new owner is a data change. */
.ticker{display:flex;align-items:center;gap:6px;padding:0 18px 8px;flex-wrap:wrap}
.ticker button{height:28px;padding:0 12px;border-radius:999px;background:transparent;color:var(--ink-3);
  font:600 12px/1 var(--sans);border:1px solid transparent;display:inline-flex;align-items:center;gap:6px;
  transition:color 160ms ease,background 160ms ease}
.ticker button:hover{color:var(--ink);background:var(--fill)}
.ticker button[aria-pressed="true"]{color:var(--accent-ink);background:var(--accent-soft);border-color:var(--accent-line)}
.ticker button b{font-family:var(--mono);font-weight:700;font-size:11px}
.ticker button[data-empty="true"]{opacity:.5}
.ticker .sep{color:var(--glass-line);user-select:none}
.ticker .soon{font:600 9.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-3);opacity:.7;margin-left:auto;display:inline-flex;align-items:center;gap:6px}
.bar{display:flex;align-items:center;gap:10px;padding:0 16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;min-width:0}
.brand-mark{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:0 0 auto;
  background:var(--accent);box-shadow:var(--shadow-soft)}
.brand-mark svg{width:15px;height:15px}
.brand-name{font:600 13.5px/1.2 var(--display);letter-spacing:-.01em;white-space:nowrap}
.brand-name span{color:var(--ink-3);font-weight:400;font-family:var(--sans);font-size:11px}
.pill{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;
  border:1px solid var(--glass-line);background:var(--glass)}
.pill button{height:26px;min-width:44px;padding:0 11px;border-radius:999px;color:var(--ink-3);
  font-weight:600;font-size:11.5px;transition:color 180ms ease,background 180ms ease}
.pill button:hover{color:var(--ink-2)}
.pill button[aria-pressed="true"]{color:var(--ink);background:var(--fill-2)}
.bar .sp{flex:1}
.btn{height:32px;padding:0 12px;border-radius:999px;background:var(--fill);color:var(--ink);
  font-weight:600;font-size:12px;display:inline-flex;align-items:center;gap:6px;
  transition:background 180ms ease,transform 120ms var(--ease-out)}
.btn:hover{background:var(--fill-2)}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.sm{height:32px;padding:0 10px;font-size:11.5px}
.btn.danger{color:var(--danger);background:var(--danger-soft)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.seek{display:flex;align-items:center;gap:8px;height:32px;padding:0 8px 0 12px;border-radius:999px;
  border:1px solid var(--glass-line);background:var(--glass);
  color:var(--ink-3);font-size:12px;min-width:200px;transition:border-color 200ms ease}
.seek:hover{border-color:var(--accent-line)}
.seek kbd{font:500 10px/1 var(--mono);background:var(--fill-2);border-radius:4px;padding:3px 6px;margin-left:auto}
.bar label{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)}
.bar select{height:32px;border-radius:999px;border:1px solid var(--glass-line);background:var(--glass);
  color:var(--ink);padding:0 8px;font-size:12px}
.announce{grid-row:2;min-height:20px;padding:0 18px 4px;font-size:12px;color:var(--ink-2)}
.announce.error{color:var(--danger)}
/* The announcement is already shown in full under the bar, so a truncated copy
   of it in the bar was noise. Kept in the DOM as a live region for assistive
   technology, which is the only reader it was ever serving. */
#status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ── body layout ─────────────────────────────────────── */
.work{display:grid;grid-template-columns:236px minmax(0,1fr);gap:12px;padding:0 16px 10px;min-height:0}
@media(max-width:880px){.work{grid-template-columns:1fr}.rail{display:none}}
.gcard{border-radius:16px;border:1px solid var(--glass-line);background:var(--glass);
  box-shadow:var(--shadow-soft)}

/* rail */
.rail{overflow:auto;padding:2px 2px 8px;display:grid;gap:8px;align-content:start;min-height:0}
.rail::-webkit-scrollbar,.plane::-webkit-scrollbar,.drawer::-webkit-scrollbar{width:8px}
.rail::-webkit-scrollbar-thumb,.plane::-webkit-scrollbar-thumb,.drawer::-webkit-scrollbar-thumb{background:var(--fill-2);border-radius:9px}
.sect{padding:10px 11px;display:grid;gap:7px}
.cap{font:600 9.5px/1.3 var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--ink-3);
  display:flex;align-items:center;gap:7px}
.cap .end{margin-left:auto;color:var(--accent-ink);font-size:9.5px;letter-spacing:0;text-transform:none}
.preset{display:grid;gap:2px;text-align:left;padding:7px 9px;border-radius:10px;background:var(--fill);
  transition:background 160ms ease;min-height:32px}
.preset:hover{background:var(--fill-2)}
.preset[aria-pressed="true"]{background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-line)}
.preset b{font:600 12px/1.3 var(--display)}
.preset[aria-pressed="true"] b{color:var(--accent-ink)}
.preset span{font-size:10.5px;color:var(--ink-3);line-height:1.35}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:999px;
  background:var(--fill);color:var(--ink-2);font-size:11px;font-weight:600;
  transition:background 160ms ease,color 160ms ease}
.chip:hover{background:var(--fill-2);color:var(--ink)}
.chip[aria-pressed="true"]{background:var(--cyan-soft);color:var(--cyan);box-shadow:inset 0 0 0 1px var(--cyan)}
.chip[aria-disabled="true"]{opacity:.55;cursor:default}
.chip[data-host][aria-disabled="false"]{color:var(--cyan);box-shadow:inset 0 0 0 1px var(--cyan)}

/* plane */
/* flex column, not grid: as direct grid items these cards resolved to a 2px
   border box while the same markup nested one level deeper laid out correctly.
   A column stack is what this is, and it sizes to content without ambiguity. */
.plane{overflow:auto;padding:2px 2px 8px;display:flex;flex-direction:column;gap:7px;min-height:0}
.plane>*{flex:0 0 auto}
#framework-rows{display:flex;flex-direction:column;gap:7px}
.planetop{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 11px}
.f{height:24px;padding:0 10px;border-radius:999px;background:var(--fill);color:var(--ink-3);
  font-size:11px;font-weight:600;transition:background 160ms ease,color 160ms ease}
.f:hover{color:var(--ink-2)}
.f[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent-ink);box-shadow:inset 0 0 0 1px var(--accent-line)}
.f[data-empty="true"]{opacity:.55}
.f b{font-family:var(--mono);font-weight:700}
#plane-empty{padding:14px 14px;color:var(--ink-2)}
.planetop .sp{flex:1}
.planetop .n{font:500 11px/1 var(--mono);color:var(--ink-3)}
.planetop .n b{color:var(--ink);font-weight:600}

/* group */
.grp{overflow:hidden}
.grphead{display:flex;align-items:center;gap:10px;width:100%;padding:9px 11px;text-align:left;
  transition:background 160ms ease;min-height:32px}
.grphead:hover{background:var(--fill)}
.grphead .tw{width:10px;color:var(--ink-3);font-size:9px;transition:transform 220ms var(--ease-out);flex:0 0 auto}
.grp[data-open="1"] .grphead .tw{transform:rotate(90deg)}
.grphead h2{font:600 12.5px/1 var(--display);letter-spacing:-.01em;white-space:nowrap}
.grphead .own{font:500 9.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.grphead .ct{font:500 11px/1 var(--mono);color:var(--ink-3);margin-left:auto;flex:0 0 auto}
.meter{display:flex;gap:1px;height:5px;width:104px;border-radius:999px;overflow:hidden;
  background:var(--s-avail);flex:0 0 auto}
.meter i{display:block;height:100%}
.meter i[data-s="requested"]{background:var(--s-sel)}
.meter i[data-s="pending"]{background:var(--s-wait)}
.meter i[data-s="blocked"]{background:var(--s-blk)}
.meter i[data-s="external"]{background:var(--s-uns)}
.grp[data-open="0"] .grpbody{display:none}
.grpbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:0 14px;
  padding:0 11px 8px}
.grpbody.stack{grid-template-columns:minmax(0,1fr)}
.grpnote{padding:0 11px 9px;font-size:11.5px;color:var(--ink-2);line-height:1.5;max-width:88ch}
.grpnote code{font-size:11px;color:var(--cyan)}

/* row - compact */
.row{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:8px;
  min-height:26px;padding:0 4px;border-radius:7px;transition:background 130ms ease}
.row:hover{background:var(--fill)}
.row.evidence-linked{outline:1px solid var(--accent);outline-offset:2px;background:var(--fill)}
.row.on{background:var(--accent-soft)}
.row[hidden]{display:none}
.rid{font:400 11.5px/1.2 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--ink-2);text-align:left;min-width:0;padding:5px 0;min-height:26px}
.row.on .rid{color:var(--ink)}
/* Verdict is a separate axis from selection, so it reads as a separate mark:
   a rule on the row's leading edge plus a mono flag, never a restyled tick.
   Colour alone would not carry it, so the blocked flag also states its code. */
.row[data-vetted="blocked"]{box-shadow:inset 2px 0 0 var(--warn,#b4541f)}
.vet{font:400 10px/1 var(--mono);flex:0 0 auto;padding:4px 5px;border-radius:5px;
  min-height:24px;display:grid;place-items:center;white-space:nowrap}
.vet[data-vet="pass"]{color:var(--ink-3);background:transparent}
.vet[data-vet="blocked"]{color:var(--warn,#b4541f);background:color-mix(in srgb,var(--warn,#b4541f) 12%,transparent)}
.row[data-vetted="blocked"] .rid strong{text-decoration:underline;text-decoration-style:dotted;
  text-underline-offset:3px;text-decoration-color:var(--warn,#b4541f)}
.rid strong{font-weight:400}
.rid u{text-decoration:none;color:var(--ink-3)}
.tick{width:24px;height:24px;border-radius:6px;background:var(--fill-2);display:grid;place-items:center;
  font-size:10px;color:transparent;flex:0 0 auto;transition:background 160ms var(--spring),color 160ms ease}
.row.on .tick{background:var(--accent);color:var(--on-accent)}
.row.on:hover .tick{background:var(--accent)}
.more{width:24px;height:24px;border-radius:6px;color:var(--ink-3);font-size:12px;line-height:1;
  display:grid;place-items:center;opacity:.35;transition:opacity 140ms ease,color 140ms ease}
.row:hover .more,.row:focus-within .more{opacity:1}
.more:hover{color:var(--accent-ink);background:var(--fill-2)}
.badge{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.cust{display:flex;gap:2px;flex:0 0 auto}
.cust i{width:11px;height:5px;border-radius:2px;background:var(--s-avail);display:block}
.cust i[data-s="fill"]{background:var(--s-sel)}
.cust i[data-s="ext"]{background:var(--s-req)}
.cust i[data-s="wait"]{background:var(--s-wait)}
.cust i[data-s="struck"]{background:var(--s-blk)}
.cust i[data-s="hatch"]{background:repeating-linear-gradient(45deg,var(--s-uns) 0 1px,transparent 1px 3px);
  box-shadow:inset 0 0 0 1px var(--s-uns)}

/* ── drawer ──────────────────────────────────────────── */
.scrim{position:fixed;inset:0;z-index:800;background:rgba(58,48,42,.42);
  opacity:0;pointer-events:none;transition:opacity 200ms var(--ease-out)}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:810;width:min(460px,94vw);overflow:auto;
  background:var(--glass-strong);border-left:1px solid var(--glass-line);
  box-shadow:var(--shadow-lg);padding:16px 18px 28px;display:grid;gap:12px;align-content:start;
  transform:translateX(24px);opacity:0;transition:transform 260ms var(--spring),opacity 180ms var(--ease-out)}
.scrim.open+.drawer{transform:none;opacity:1}
.drawer[hidden]{display:none}
.dhead{display:flex;align-items:flex-start;gap:10px}
.dhead h2{font:600 15px/1.25 var(--mono);letter-spacing:-.01em;word-break:break-all}
.dhead .x{margin-left:auto;color:var(--ink-3);font-size:15px;line-height:1;width:32px;height:32px;
  display:grid;place-items:center;border-radius:8px;flex:0 0 auto}
.dhead .x:hover{background:var(--fill-2);color:var(--ink)}
.badges{display:flex;gap:5px;flex-wrap:wrap}
.b{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;
  background:var(--fill);color:var(--ink-2);font:600 10.5px/1 var(--sans)}
.b.ok{color:var(--cyan);background:var(--cyan-soft)}
.b.ext{color:var(--accent-ink);background:var(--accent-soft)}
.b.warn{color:var(--amber);background:var(--amber-soft)}
.b.bad{color:var(--danger);background:var(--danger-soft)}
.kv{display:grid;gap:0}
.kv div{display:flex;justify-content:space-between;gap:14px;padding:7px 0;
  border-bottom:1px solid var(--glass-line);align-items:baseline}
.kv div:last-child{border-bottom:0}
.kv span{color:var(--ink-3);font-size:11.5px;flex:0 0 auto}
.kv b{font:500 11.5px/1.45 var(--mono);text-align:right;word-break:break-word}
.note{font-size:12px;line-height:1.55;color:var(--ink-2);border-left:2px solid var(--accent-line);padding-left:9px}
.note.bad{border-left-color:var(--danger)}
.note.ok{border-left-color:var(--cyan)}
.note b{color:var(--ink);font-weight:600}
.cmdline{display:flex;align-items:center;gap:9px;background:var(--fill);border-radius:10px;padding:8px 10px}
.cmdline code{color:var(--cyan);font-size:11.5px;flex:1;overflow-wrap:anywhere}
.copy{border-radius:999px;background:var(--fill-2);color:var(--ink-2);font:700 9.5px/1 var(--sans);
  letter-spacing:.06em;padding:0 10px;height:32px;transition:color 150ms ease,background 150ms ease}
.copy:hover{color:var(--accent-ink);background:var(--accent-soft)}
.brow{display:flex;gap:6px;flex-wrap:wrap}
.dform{display:grid;gap:7px}
.dform label{display:grid;gap:3px;color:var(--ink-3);font-size:11px}
.dform input,.dform select,.form-grid input,.form-grid select{border:1px solid var(--glass-line);border-radius:9px;
  background:var(--fill);color:var(--ink);font:400 12px/1.4 var(--sans);padding:0 10px;height:32px;width:100%}
.dform input:focus,.form-grid input:focus{border-color:var(--accent-line);outline:none}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.form-grid label{display:grid;gap:3px;color:var(--ink-3);font-size:11px}
fieldset{border:1px solid var(--glass-line);border-radius:12px;margin:0;padding:10px}
legend{padding:0 5px;color:var(--ink-3);font-size:11px}
[aria-invalid="true"]{border-color:var(--danger)!important}
.field-error{display:block;color:var(--danger);font-size:10.5px;line-height:1.3}
.help{color:var(--ink-2);font-size:11.5px;line-height:1.5;max-width:88ch}
.mono{font-family:var(--mono);font-size:10.5px;overflow-wrap:anywhere;color:var(--ink-2)}
.error{color:var(--danger)}
textarea{width:100%;min-height:8rem;resize:vertical;border:1px solid var(--glass-line);border-radius:10px;
  background:var(--fill);color:var(--ink);font:400 11px/1.5 var(--mono);padding:8px 10px}
details{margin:0}
summary{cursor:pointer;color:var(--accent-ink);font-size:11.5px;display:flex;align-items:center}
summary{min-height:32px}
.row-actions{display:flex;gap:5px;flex-wrap:wrap}
.row-details{margin:0}
.row-slot{grid-column:1/-1}
.row-slot:empty{display:none}
.receipt-record{white-space:pre-wrap;max-width:100%;max-height:20rem;overflow:auto}
.tip-wrap{display:inline-flex;position:relative;vertical-align:middle;margin-left:.3rem}
.help-button{min-width:24px;min-height:24px;padding:0;border-radius:999px;font-weight:700;
  line-height:1;font-size:11px;background:var(--fill-2);color:var(--ink-2)}
.help-button:hover{color:var(--accent-ink)}
.tooltip{display:none;position:fixed;left:1rem;right:auto;width:auto;z-index:900;
  max-width:calc(100vw - 2rem);padding:.5rem .6rem;border:1px solid var(--glass-line);border-radius:9px;
  background:var(--glass-strong);color:var(--ink);font-size:11.5px;line-height:1.45;box-shadow:var(--shadow-lg)}
.tip-wrap .tooltip[data-open="true"]{display:block}

/* ── spotlight ───────────────────────────────────────── */
.spot-bd{position:fixed;inset:0;z-index:900;background:rgba(58,48,42,.5);
  display:grid;place-items:start center;padding:10vh 24px 24px;opacity:0;pointer-events:none;
  transition:opacity 200ms var(--ease-out)}
.spot-bd.open{opacity:1;pointer-events:auto}
.spot{width:min(100%,620px);border-radius:18px;border:1px solid var(--glass-line);
  background:var(--glass-strong);box-shadow:var(--shadow-lg);
  padding:16px;display:grid;gap:11px;transform:scale(.95) translateY(10px);opacity:0;
  transition:transform 220ms var(--spring),opacity 180ms var(--ease-out)}
.spot-bd.open .spot{transform:none;opacity:1}
.spot input{border:0;background:transparent;color:var(--ink);font:400 16px/1.5 var(--sans);
  outline:none;width:100%;border-bottom:1px solid var(--glass-line);padding-bottom:10px}
.hits{display:grid;gap:2px;max-height:46vh;overflow:auto}
.hit{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;text-align:left;
  min-height:32px;transition:background 130ms ease}
.hit:hover,.hit.sel{background:var(--fill-2)}
.hit .hid{font:400 12px/1 var(--mono);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hit .hg{font-size:10.5px;color:var(--ink-3);flex:0 0 auto}
.spot-foot{display:flex;gap:11px;color:var(--ink-3);font-size:11px;flex-wrap:wrap}
.spot-foot kbd{font:500 10px/1 var(--mono);background:var(--fill-2);border-radius:4px;padding:3px 5px}

/* ── ledger ──────────────────────────────────────────── */
.ledger{display:flex;align-items:center;gap:14px;padding:0 18px;font-size:11.5px;flex-wrap:wrap;
  border-top:1px solid var(--glass-line);background:var(--glass)}
.ledger i{font-style:normal;color:var(--ink-3)}
.ledger b{font-weight:700;font-family:var(--mono)}
.l-req b{color:var(--accent-ink)}.l-wait b{color:var(--amber)}.l-blk b{color:var(--danger)}
.l-ext b{color:var(--ink-2)}
.ledger .sp{flex:1}
.ledger .eff{color:var(--ink-3)}

/* ── sheet ───────────────────────────────────────────── */
.sheet{position:fixed;inset:auto 0 0 0;z-index:850;height:min(70vh,560px);display:none;flex-direction:column;
  background:var(--glass-strong);border-top:1px solid var(--accent-line);
  box-shadow:var(--shadow-lg);border-radius:18px 18px 0 0}
.sheet.open{display:flex}
.sheet header{display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid var(--glass-line)}
.sheet h3{font:600 12.5px/1 var(--display)}
.sheet .sub{font-size:11px;color:var(--ink-3)}
.sheet .sbody{flex:1;margin:0;overflow:auto;padding:13px 16px;display:grid;gap:10px;align-content:start}
.sheet textarea{min-height:16rem}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;
  transition-duration:.01ms!important}}
</style>
</head>
<body>
<a class="skip" href="#workbench">Skip to policy workbench</a>
<div class="field" aria-hidden="true"><div class="grain"></div></div>

<div class="stage">
  <header class="bar" aria-label="Policy workbench toolbar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.4" fill="none" stroke="#fffcf7" stroke-opacity=".92" stroke-width="1.7"/><circle cx="12" cy="12" r="2.7" fill="#fffcf7"/><circle cx="17.3" cy="6.7" r="2.1" fill="#fffcf7"/></svg></span>
      <h1 class="brand-name">Policy Workbench <span>&middot; no repository required</span></h1>
    </span>
    <button type="button" class="seek" id="seek">Find any item&hellip; <kbd>/</kbd></button>
    <span class="sp"></span>
    <span id="status">Ready - no repository is required.</span>
    <label>Preset <select id="profile"><option value="">Custom</option><option value="vibe">Vibe</option><option value="enterprise">Enterprise</option></select></label>
    <label>Posture <select id="posture"><option value="vibe">Vibe</option><option value="enterprise">Enterprise</option></select></label>
    <span class="pill" role="group" aria-label="Theme">
      <button type="button" data-theme-set="light" aria-pressed="true">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
    </span>
    <button type="button" class="btn" id="clear-policy">Clear</button>
    <button type="button" class="btn" id="import-policy">Import policy (replaces current)</button>
    <button type="button" class="btn" id="import-evidence">Import evidence (non-destructive preflight)</button>
    <button type="button" class="btn" id="validate">Validate</button>
    <button type="button" class="btn" id="download">Download</button>
    <button type="button" class="btn primary" id="export">Policy JSON</button>
    <input class="hidden" id="policy-file" type="file" accept="application/json">
    <input class="hidden" id="evidence-file" type="file" accept="application/json">
  </header>

  <p id="announcement" class="announce" aria-live="polite"></p>

  <nav class="ticker" id="owner-ticker" aria-label="Focus one surface"></nav>

  <div class="work">
    <aside class="rail" aria-label="Presets and quick selection">
      <section class="gcard sect">
        <div class="cap">Preset <span class="end" id="rail-posture">vibe</span></div>
        <div id="presets" style="display:grid;gap:4px"></div>
      </section>
      <section class="gcard sect"><div class="cap">Languages</div><div class="chips" id="rail-langs"></div></section>
      <section class="gcard sect"><div class="cap">Frameworks</div><div class="chips" id="rail-frameworks"></div></section>
      <section class="gcard sect"><div class="cap">Capabilities</div><div class="chips" id="rail-caps"></div></section>
      <section class="gcard sect"><div class="cap">ECC modules</div><div class="chips" id="rail-modules"></div></section>
      <section class="gcard sect">
        <div class="cap">Hosts <span class="end" id="rail-host-count"></span></div>
        <div class="chips" id="rail-hosts"></div>
        <p class="help" id="rail-host-note"></p>
      </section>
      <section class="gcard sect">
        <div class="cap">Your sources</div>
        <button type="button" class="btn sm" id="open-custom" style="justify-content:center">Add custom MCP</button>
      </section>
    </aside>

    <main class="plane" id="workbench" tabindex="-1">
      <div class="gcard planetop" role="group" aria-label="Filter inventory">
        <button type="button" class="f" data-filter="all" data-label="All" aria-pressed="true">All</button>
        <button type="button" class="f" data-filter="requested" data-label="Selected" aria-pressed="false">Selected</button>
        <button type="button" class="f" data-filter="external" data-label="Selectable" aria-pressed="false">Selectable</button>
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

      <section class="gcard grp group" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH MCP servers</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="mcp-rows"></div><p class="grpnote">AIH ships and projects these. A requested control still needs target-repository identity, evidence, authority, safety, ownership and a supported projector before it can become effective. ECC separately declares its own MCP components — see <b>ECC MCP declarations</b>. Those are ECC's declarations, not servers AIH runs: selecting the AIH server above is what makes one effective, and <code>mcp:exa</code> has no AIH server at all.</p></section>

      <section class="gcard grp group" data-open="1" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>AIH hooks</h2><span class="own">AIH</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody" id="hook-rows"></div><p class="grpnote">Only AIH-owned hook identities are authorable. Custom hooks are not supported. Open a hook to see exactly what it runs, what it writes, and what removing it does. AIH ships exactly one hook today. ECC has its own hook surface — <code>baseline:hooks</code> and <code>module:hooks-runtime</code> — which ECC installs and runs. AIH registers and revokes those entries without executing them; see the hook registrar below.</p></section>
      <section class="gcard grp group" data-open="1" data-owner="${hookRegistryOwners}" data-groupcard><button type="button" class="grphead" data-group aria-expanded="true"><span class="tw" aria-hidden="true">&#9654;</span><h2>Hook registrar</h2><span class="own">AIH registers &middot; owners vary</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody"><p class="grpnote">AIH is the sole registrar of hook entries in a client's native configuration; third-party runtimes stay the executors. Every entry below is emitted and revocable by AIH. A third-party command is written byte-for-byte as its source declares it — AIH does not interpret, wrap, or run it. This is a read-only projection view: registrations are authored in the policy document (<code>governance.hookRegistrations</code>) and hook components on their own inventory rows, never here.</p><div id="hook-registry-rows"></div><h3>Third-party controls, recorded read-only</h3><div id="hook-registry-controls"></div><h3>Overlaps</h3><div id="hook-registry-overlaps"></div><h3>Entries and process spawns</h3><div id="hook-registry-spawns"></div></div></section>

      <p class="gcard grpnote" id="plane-empty" hidden></p>
      <div id="framework-rows"></div>

      <section class="gcard grp group" data-open="0" data-owner="ECC" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Enterprise composition</h2><span class="own">ECC</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="composition-parts"></div></section>

      <section class="gcard grp group" data-open="0" data-owner="You" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Your sources</h2><span class="own">You</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="custom-rows"></div><p class="grpnote">Custom MCP can only be authored as a fully pinned pending candidate. It has no activation affordance until supported scanning, evidence and projection exist.</p></section>

      <section class="gcard grp group" data-open="0" data-owner="ECC Superpowers" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>ECC / Superpowers curation</h2><span class="own">recorded</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="curation-rows"></div><p class="grpnote">AIH preserves audited curation intent for agents, skills and commands. It does not install, project or enforce those external assets. A selection becomes curation once it carries an audit record and digest.</p></section>

      <section class="gcard grp group" data-open="0" data-owner="AIH" data-groupcard><button type="button" class="grphead" data-group aria-expanded="false"><span class="tw" aria-hidden="true">&#9654;</span><h2>Approval / evidence</h2><span class="own">preflight</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody stack" id="approval-rows"></div><div class="grpnote"><p id="receipt-state" class="help">No authority receipt imported.</p><p><button type="button" class="btn sm" id="copy-approvals" disabled>Preserve approval subjects in policy (not effective)</button></p><details><summary>Finding model: 8 administrator-dispositionable, 6 hard blockers</summary><p class="help">A completed scan reports these 8. The accountable administrator decides each one, because a detector label is evidence and not a verdict. They stay visible and authorable; this workbench does not dispose of them.</p><p id="dispositionable-findings" class="mono"></p><p class="help">These 6 are missing or untrustworthy prerequisites rather than detector findings. No approval substitutes for one, and this workbench cannot waive, approve or downgrade them.</p><p id="hard-blockers" class="mono"></p></details></div></section>
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
<aside class="drawer" id="drawer" hidden aria-label="Item detail and authoring">
  <div id="drawer-detail"></div>
  <div id="drawer-forms">
    <details id="curation-editor"><summary>Record external curation intent</summary>
      <div class="dform" style="margin-top:8px">
        <p class="help">AIH preserves audited curation intent for agents, skills and commands. It never installs or enforces them.</p>
        <div class="form-grid">
          <label><span id="curation-framework-label">Framework</span> <select id="curation-framework"></select></label>
          <label>Catalog prefill (optional) <select id="curation-asset"></select></label>
          <label>Item kind <select id="curation-kind"><option value="agent">Agent</option><option value="skill">Skill</option><option value="command">Command</option></select></label>
          <label>Item identifier <input id="curation-id" required></label>
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
    <details id="custom-editor"><summary>Add a pending custom MCP</summary>
      <form id="custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Pinned custom source</legend>
          <p class="help">It is recorded immediately and stays blocked until a completed scan binds to this exact pin.</p>
          <div class="form-grid">
            <label>Identifier <input id="custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>Package <input id="custom-package" placeholder="@scope/package" required></label>
            <label>Exact version <input id="custom-version" placeholder="1.2.3" required></label>
            <label>Integrity digest <input id="custom-integrity" placeholder="sha256:..." required></label>
            <label>Evidence record <input id="custom-evidence" required></label>
            <label>Clarification <input id="custom-note"></label>
          </div>
          <div class="brow" style="margin-top:8px"><button type="submit" class="btn sm primary">Add pending custom MCP</button></div>
        </fieldset>
      </form>
    </details>
    <details id="remote-custom-editor"><summary>Record a pending remote custom MCP</summary>
      <form id="remote-custom-form" style="margin-top:8px">
        <fieldset>
          <legend>Fenced remote endpoint</legend>
          <p class="help">AIH records the exact HTTPS origin, approval-shaped metadata, and a pinned tool-surface digest. No content scan occurs and the endpoint remains blocked.</p>
          <div class="form-grid">
            <label>Identifier <input id="remote-custom-id" pattern="[a-z][a-z0-9-]{0,63}" required></label>
            <label>HTTPS origin <input id="remote-custom-origin" placeholder="https://mcp.example.com" required></label>
            <label>Approved by <input id="remote-custom-approved-by" placeholder="security-admin" required></label>
            <label>Authentication mode <input id="remote-custom-authentication-mode" placeholder="oauth" required></label>
            <label>Allowed data classes <input id="remote-custom-data-classes" placeholder="design-metadata, issue-metadata" required></label>
            <label>Tool-surface digest <input id="remote-custom-tool-surface-digest" placeholder="sha256:..." required></label>
            <label>Verdict <select id="remote-custom-verdict"><option value="approved">approved</option><option value="drifted">drifted</option><option value="revoked">revoked</option></select></label>
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
const state={policy:structuredClone(model.initialPolicy),receipt:null};
const byId=function(id){return document.getElementById(id)};
const esc=function(value){return String(value).replace(/[&<>"']/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]})};
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
const candidateSemantics=function(candidate,path,collection,errors){if(!candidate||typeof candidate!=="object"){return}safePolicyText(candidate.description,path+".description",errors);(candidate.capabilities||[]).forEach(function(value,index){safePolicyText(value,path+".capabilities["+index+"]",errors)});(candidate.risks||[]).forEach(function(value,index){safePolicyText(value,path+".risks["+index+"]",errors)});if(candidate.clarification!==undefined){safePolicyText(candidate.clarification,path+".clarification",errors)}if(candidate.annotation!==undefined){safePolicyText(candidate.annotation,path+".annotation",errors)}const source=candidate.source||{};sourceSemantics(source,path+".source",errors);if(candidate.kind==="mcp"&&(source.type!=="mcp"&&source.type!=="stdio"&&source.type!=="remote")){errors.push(validationError(path+".source","MCP candidates require exact catalog, pinned stdio, or fenced remote identity"))}if(candidate.kind==="mcp"&&source.type==="mcp"&&candidate.id!==source.server){errors.push(validationError(path+".id","must match built-in MCP source.server"))}if(candidate.kind==="mcp"&&Array.isArray(candidate.targets)&&candidate.targets.some(function(target){return target!=="claude"})){errors.push(validationError(path+".targets","MCP candidates support Claude only"))}if(candidate.kind==="hook"&&source.type!=="hook"){errors.push(validationError(path+".source","hook candidates require an AIH-owned hook identity"))}if(candidate.kind==="hook"&&source.type==="hook"&&candidate.id!==source.handler){errors.push(validationError(path+".id","must match AIH hook handler"))}if(candidate.kind==="framework"&&!candidate.framework){errors.push(validationError(path+".framework","is required for framework candidates"))}if(candidate.kind!=="framework"&&candidate.framework!==undefined){errors.push(validationError(path+".framework","is only valid for framework candidates"))}if(candidate.kind==="framework"&&(candidate.projector!=="framework-contract"||candidate.autoExecute||!Array.isArray(candidate.targets)||candidate.targets.length!==1||candidate.targets[0]!=="claude")){errors.push(validationError(path,"framework candidates must be Claude-only, non-autoexecuting framework-contract records"))}if(collection==="reviewed"&&source.type!=="mcp"&&source.type!=="hook"){errors.push(validationError(path+".source","reviewed candidates must reference AIH-shipped MCP or hook identities"))}if(collection==="custom"&&candidate.kind==="mcp"&&source.type!=="stdio"&&source.type!=="remote"){errors.push(validationError(path+".source","custom MCP candidates must use pinned stdio or fenced remote identity"))}if(collection==="custom"&&candidate.kind==="hook"){errors.push(validationError(path,"custom hooks are unsupported"))}};
const policySemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;const registryIds=(model.catalog.hosts||[]).map(function(host){return host.id});if(policy&&policy.minimumPosture==="enterprise"&&(!governanceValue||typeof governanceValue!=="object"||!Array.isArray(governanceValue.supportedClis)||governanceValue.supportedClis.length===0)){errors.push(validationError("policy.governance.supportedClis","enterprise posture requires a non-empty explicit allow-list; current registry ids: "+registryIds.join(", ")+". Paste every id to sanction all supported CLIs; wildcard sentinels are not supported"))}if(!governanceValue||typeof governanceValue!=="object"){return errors}const supportedClis=Array.isArray(governanceValue.supportedClis)?governanceValue.supportedClis:[];if(new Set(supportedClis).size!==supportedClis.length){errors.push(validationError("policy.governance.supportedClis","supported CLI entries must be unique"))}const catalog=governanceValue.catalog||{};const reviewed=Array.isArray(catalog.reviewed)?catalog.reviewed:[];const custom=Array.isArray(catalog.custom)?catalog.custom:[];reviewed.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.reviewed["+index+"]","reviewed",errors)});custom.forEach(function(item,index){candidateSemantics(item,"policy.governance.catalog.custom["+index+"]","custom",errors)});const candidates=reviewed.concat(custom);const ids=candidates.map(function(item){return item.id});if(new Set(ids).size!==ids.length){errors.push(validationError("policy.governance.catalog","candidate identifiers must be unique"))}const activations=Array.isArray(governanceValue.activations)?governanceValue.activations:[];const activeIds=activations.map(function(item){return item.candidate});if(new Set(activeIds).size!==activeIds.length){errors.push(validationError("policy.governance.activations","candidate decisions must be unique"))}activations.forEach(function(activation,index){const candidate=candidates.find(function(item){return item.id===activation.candidate});if(!candidate){errors.push(validationError("policy.governance.activations["+index+"]","references an unknown candidate"))}else if(Array.isArray(activation.targets)&&activation.targets.some(function(target){return !candidate.targets.includes(target)})){errors.push(validationError("policy.governance.activations["+index+"]","targets exceed candidate support"))}});const frameworks=activations.filter(function(activation){return activation.state==="active"&&candidates.some(function(candidate){return candidate.id===activation.candidate&&candidate.kind==="framework"})});if(frameworks.length>1){errors.push(validationError("policy.governance.activations","only one framework intent may be active"))}const approvals=governanceValue.authority&&Array.isArray(governanceValue.authority.approvals)?governanceValue.authority.approvals:[];if(new Set(approvals.map(function(item){return item.id})).size!==approvals.length){errors.push(validationError("policy.governance.authority.approvals","approval identifiers must be unique"))}approvals.forEach(function(approval,index){sourceSemantics(approval.source,"policy.governance.authority.approvals["+index+"].source",errors);isoTime(approval.notBefore,"policy.governance.authority.approvals["+index+"].notBefore",errors);isoTime(approval.expiresAt,"policy.governance.authority.approvals["+index+"].expiresAt",errors)});const curation=Array.isArray(governanceValue.externalCuration)?governanceValue.externalCuration:[];if(new Set(curation.map(function(item){return item.framework})).size!==curation.length){errors.push(validationError("policy.governance.externalCuration","framework records must be unique"))}curation.forEach(function(group,groupIndex){const itemKeys=(group.items||[]).map(function(item){safePolicyText(item.id,"policy.governance.externalCuration["+groupIndex+"].items id",errors);safePath(item.source&&item.source.path,"policy.governance.externalCuration["+groupIndex+"].items path",errors);safePolicyText(item.audit&&item.audit.record,"policy.governance.externalCuration["+groupIndex+"].items audit record",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.externalCuration["+groupIndex+"].items clarification",errors)}return item.kind+"\\u0000"+item.id});if(new Set(itemKeys).size!==itemKeys.length){errors.push(validationError("policy.governance.externalCuration["+groupIndex+"].items","kind/id pairs must be unique"))}});(policy.trust&&Array.isArray(policy.trust.baselineOverrides)?policy.trust.baselineOverrides:[]).forEach(function(item,index){safePath(item.bundle,"policy.trust.baselineOverrides["+index+"].bundle",errors);isoTime(item.approvedAt,"policy.trust.baselineOverrides["+index+"].approvedAt",errors)});return errors};
const policyTextSemantics=function(policy){const errors=[];const governanceValue=policy&&policy.governance;if(!governanceValue||typeof governanceValue!=="object"){return errors}if(governanceValue.policyVersion!==undefined){safePolicyText(governanceValue.policyVersion,"policy.governance.policyVersion",errors)}(governanceValue.activations||[]).forEach(function(item,index){if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.activations["+index+"].clarification",errors)}});const approvals=governanceValue.authority&&governanceValue.authority.approvals||[];approvals.forEach(function(item,index){safePolicyText(item.policyVersion,"policy.governance.authority.approvals["+index+"].policyVersion",errors);safePolicyText(item.reason,"policy.governance.authority.approvals["+index+"].reason",errors);if(item.clarification!==undefined){safePolicyText(item.clarification,"policy.governance.authority.approvals["+index+"].clarification",errors)}safePolicyText(item.github&&item.github.attestationId,"policy.governance.authority.approvals["+index+"].github.attestationId",errors)});return errors};
const policyProblems=function(){return schemaErrors(model.schema,state.policy,"").concat(policySemantics(state.policy),policyTextSemantics(state.policy))};
let policyValidator=policyProblems;
const commitPolicy=function(previous,message){const problems=policyValidator();if(problems.length){state.policy=previous;announce("Policy change rejected: "+problems.slice(0,3).join("; "),true);render();return false}announce(message);render();return true};
const candidateStatus=function(candidate){if(candidate.kind==="mcp"&&candidate.source&&candidate.source.type==="stdio"){return ["Blocked - evidence owed at this pin","blocked"]}const activation=governance().activations.find(function(item){return item.candidate===candidate.id});return activation&&activation.state==="active"?["Requested intent - runtime evaluation required","requested"]:["Disabled","pending"]};
/* The note sits inside the first cell so the status badge stays the row's first
   .badge, which is what the inventory contract reads as a row's status. */
/* The artifact's compact row: a tick that is the whole selection affordance, the
   id in mono, a four-mark custody strip, and a chevron into the drawer where all
   detail lives. The status badge and the provenance note stay in the DOM as
   screen-reader text - the custody strip is a graphic, and a state an assistive
   technology cannot read is not a state that was disclosed. */
const CUSTODY={requested:["fill","fill","ext",""],pending:["fill","fill","wait",""],
  blocked:["fill","struck","",""],external:["","","",""]};
const custody=function(kind){return (CUSTODY[kind]||CUSTODY.external).map(function(mark){return '<i'+(mark?' data-s="'+mark+'"':"")+'></i>'}).join("")};
/* The visible label is the component id alone with its namespace dimmed: the
   group card already states the framework and the owner, so repeating them on
   every row is noise. The full title stays the drawer key and the accessible
   name. */
/* ECC's catalog carries no per-component description - a component is
   {id, paths, skillContent} and nothing else - so a per-name tooltip would have
   to be invented. These are kind-level and true of every member, which is the
   most that can be said without making prose up. Recorded as ECC_PR_01. */
const KIND_HELP={agent:"An ECC agent definition: a specialised reviewer or resolver ECC installs and runs.",
  skill:"A packaged workflow the framework installs and runs.",
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
const vetFlag=function(vet){if(!vet)return "";
  if(vet.verdict!=="blocked")return '<span class="vet" data-vet="pass" title="Vetted clean by '+esc(vet.analyzers.map(function(a){return a.name}).join(", "))+'" aria-hidden="true">&#10003;</span>';
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
const row=function(title,detail,status,kind,action,note,label,vet){
  return '<div class="row'+(kind==="requested"?" on":"")+'" data-state="'+esc(kind)+'"'+(vet?' data-vetted="'+esc(vet.verdict)+'"':"")+' data-row="'+esc(title)+'">'+
    (action||'<span class="tick" aria-hidden="true"></span>')+
    '<button type="button" class="rid" data-detail="'+esc(title)+'" aria-label="'+esc(title)+'" title="'+esc(detail)+'"><strong>'+ridLabel(label||title)+'</strong></button>'+
    vetFlag(vet)+
    '<span class="cust" aria-hidden="true">'+custody(kind)+'</span>'+
    '<button type="button" class="more" data-detail="'+esc(title)+'" aria-label="Details for '+esc(title)+'">&rsaquo;</button>'+
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
const toggleReviewed=function(id){const control=aihControls().find(function(item){return item.id===id});if(!control){return}const previous=structuredClone(state.policy);const g=ensureGovernance();const existing=g.catalog.reviewed.some(function(item){return item.id===id});if(!existing){requestControl(g,control,"administrator");commitPolicy(previous,"Requested intent added; it is not active until runtime evaluation.");return}const activation=g.activations.find(function(item){return item.candidate===id});const origins=activationOrigins(activation);const administrator=origins.indexOf("administrator");if(activation&&administrator!==-1&&origins.length>1){origins.splice(administrator,1);activation.clarification=PROVENANCE_PREFIX+origins.join(", ");commitPolicy(previous,"Administrator request removed; "+id+" remains requested by "+origins.join(", ")+".");return}activePreset="";g.catalog.reviewed=g.catalog.reviewed.filter(function(item){return item.id!==id});g.activations=g.activations.filter(function(item){return item.candidate!==id});commitPolicy(previous,"Requested intent removed; the exported policy no longer records "+id+".")};
/* Vibe is "everything this catalog offers", and it means it: every AIH control
   is requested and every framework-owned component is selected as requested
   intent. A selection carries the component's pinned source and no audit
   fields, so composing one invents no evidence - which is what kept this
   profile from offering the catalog while third-party rows were unselectable.
   External curation still needs an audit record and a digest, and no preset may
   author one. */
const composeVibeProfile=function(){const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const controls=aihControls();controls.forEach(function(control){requestControl(g,control,"vibe profile")});/* Bounded by the one-framework rule: Vibe composes the whole of the framework
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
const toggleFrameworkSelection=function(key){const parts=String(key).split("|");const found=frameworkAsset(parts[0],parts[2]);if(!found){return}const previous=structuredClone(state.policy);const g=ensureGovernance();if(!Array.isArray(g.externalSelections)){g.externalSelections=[]}const group=g.externalSelections.find(function(item){return item.framework===found.framework.id});if(group&&group.items.some(function(item){return item.id===found.asset.id})){group.items=group.items.filter(function(item){return item.id!==found.asset.id});if(!group.items.length){g.externalSelections=g.externalSelections.filter(function(item){return item.framework!==found.framework.id})}commitPolicy(previous,"Deselected "+found.asset.id+"; the exported policy no longer records it.");return}const conflict=selectionConflict(g,found.framework.id);
  if(conflict){state.policy=previous;announce("A policy selects from only one framework at a time, and "+conflict+" is already selected. Clear the policy, or deselect the "+conflict+" items, before selecting from "+found.framework.id+".",true);render();return}
  if(!selectFrameworkAsset(g,found.framework,found.asset)){state.policy=previous;announce(found.asset.id+" already carries curation evidence; remove that record first to hold it as a bare selection.",true);render();return}commitPolicy(previous,"Selected "+found.asset.id+": requested intent recorded with its pinned source. "+found.framework.id+" installs and runs it; its audit evidence is still owed.")};
/* The inventory is grouped by the catalog's own namespaces, the way the accepted
   artifact groups it, so 151 components read as a structure rather than a list. */
const GROUP_LABEL={lang:"Languages",framework:"Frameworks",capability:"Capabilities",
  module:"ECC modules",baseline:"ECC baselines",agent:"ECC agents",skill:"ECC skills",
  mcp:"ECC MCP declarations",runtime:"ECC runtime"};
const assetGroup=function(framework,asset){return framework.id==="superpowers"?"Superpowers":(GROUP_LABEL[asset.kind]||asset.kind)};
const openGroups={};
/* The line break after button is intentional: older row rendering tries to
   inject disabled by replacing the literal "<button ". A selected control
   must remain its own inverse, so no rendered tick exposes that match. */
const tick=function(attr,key,selected,label){return '<button\n type="button" class="tick" '+attr+'="'+esc(key)+'" aria-pressed="'+(selected?"true":"false")+'" aria-label="'+(selected?"Deselect ":"Select ")+esc(label)+'">&#10003;</button>'};
const frameworkGroups=function(){const groups=[];const index={};
  model.catalog.frameworks.forEach(function(framework){framework.assets.forEach(function(asset){
    const label=assetGroup(framework,asset);
    if(!index[label]){index[label]={label:label,framework:framework.id,owner:framework.id==="superpowers"?"Superpowers":"ECC",rows:[]};groups.push(index[label])}
    index[label].rows.push({framework:framework,asset:asset})})});
  return groups};
/* Once a framework is chosen the other one's groups come out of the plane: a
   policy that cannot select them should not present them as inventory to work
   through. Nothing is lost silently - the count and the way back are stated,
   and Clear restores the full catalog. */
const frameworkInventoryRows=function(){const active=activeSelectionFramework(governance());
  const all=frameworkGroups();const shown=all.filter(function(group){return !active||group.framework===active});
  const hidden=all.length-shown.length;
  const hiddenRows=all.filter(function(group){return active&&group.framework!==active}).reduce(function(total,group){return total+group.rows.length},0);
  const notice=hidden?'<section class="gcard" data-framework-notice><p class="grpnote">A policy selects from one framework at a time, and <b>'+esc(active)+'</b> is selected. The other framework’s <b>'+hiddenRows+'</b> component(s) in '+hidden+' group(s) are not shown while it is. Use <b>Clear</b> to start over and choose the other one.</p></section>':"";
  return shown.map(function(group){
  const open=openGroups[group.label]?1:0;
  const rows=group.rows.map(function(entry){const framework=entry.framework,asset=entry.asset;
    const selected=isFrameworkSelected(framework.id,asset.id);
    /* Fulfillment is stated only once selected, and only when the selected
       entry's own kind agrees with the catalog's kind for this id - an
       unselected row has nothing to say about materialization yet, and a
       kind-mismatched selection is exactly what the engine refuses as
       malformed, so this layer states none of the three claims for it
       rather than overstating one. "Selectable - ... installs and runs it"
       stays exactly as true as it always was either way. */
    const fulfillment=selected&&selectedAssetAuthorizable(framework.id,asset)?fulfillmentNote(framework,asset.vet):"";
    return row(framework.id+" / "+asset.kind+": "+asset.id,
      (KIND_HELP[asset.kind]||"A framework-owned component.")+" By default, "+framework.id+" installs and runs it; AIH records the selection with its pinned source."+(asset.riders&&asset.riders.length?" Declares "+asset.riders.length+" rider(s): "+asset.riders.join(", ")+".":""),
      selected?"Selected - requested intent recorded":"Selectable - "+framework.id+" installs and runs it",
      selected?"requested":"external",
      tick("data-framework-select",framework.id+"|"+asset.kind+"|"+asset.id,selected,asset.id),
      "Owned by "+framework.repository+" at "+framework.commit+", source "+asset.source.path+"."+(asset.riders&&asset.riders.length?" Also brings in "+asset.riders.join(", ")+".":"")+" Evidence: "+evidenceCommand(framework,asset)+(asset.vet?" Already vetted at this pin by "+asset.vet.analyzers.map(function(a){return a.name+" "+a.version}).join(", ")+"; tree "+asset.vet.treeSha256.slice(0,12)+".":"")+vetNote(asset.vet)+(fulfillment?" "+fulfillment:""),
      asset.id,asset.vet)}).join("");
  return '<section class="gcard grp group" data-owner="'+esc(group.owner)+'" data-open="'+open+'" data-groupcard><button type="button" class="grphead" data-group aria-expanded="'+(open?"true":"false")+'"><span class="tw" aria-hidden="true">&#9654;</span><h2>'+esc(group.label)+'</h2><span class="own">'+esc(group.owner)+'</span><span class="ct"></span><span class="meter" aria-hidden="true"></span></button><div class="grpbody">'+rows+'</div></section>'}).join("")+notice};
/* A pinned custom candidate must name the published package it actually vets.
   The tarball is the exact content pin; a source checkout cannot stand in for it. */
const customNextAction=function(item){const source=item.source||{};return "Next: save this policy as aih-org-policy.json in the target repository, then run aih trust scan "+source.package+String.fromCharCode(64)+source.version+". AIH fetches and scans that pinned npm tarball, verifies "+source.integrity+", and emits preflight evidence record "+item.evidence.record+" bound to candidate "+item.id+". The current fence is mandatory-detector-failed; it remains blocked until an independently attested authority receipt carries that exact record."};
const renderHookRegistry=function(){const reg=model.catalog.hookRegistry;byId("hook-registry-rows").innerHTML=reg.entries.map(function(e){const label=e.owner==="aih"?"AIH-owned":"Third party - owned by "+e.ownerLabel;const enforce=e.enforcement==="aih-enforced"?"AIH-enforced":"Not AIH-enforced - the source installs and runs it; AIH registers and revokes the entry";return "<div class=\"hookreg\"><p><b>"+esc(e.id)+"</b> &mdash; "+esc(label)+"</p>"+"<p class=\"help\">"+esc(e.description)+"</p>"+"<p class=\"help\">Source: "+esc(e.source)+"</p>"+"<p class=\"help\">"+esc(enforce)+".</p><p class=\"help\">Counted under "+esc(e.ownerLabel)+" on its own inventory row. Authored there, not here — this panel is a read-only view of what the destination will contain.</p></div>"}).join("");byId("hook-registry-controls").innerHTML=reg.declaredControls.length?reg.declaredControls.map(function(c){return "<p class=\"help\"><code>"+esc(c.name)+"</code> (declared by "+esc(c.owner)+", not owned by AIH): "+esc(c.detail)+"</p>"}).join(""):"<p class=\"help\">No third-party hook controls declared.</p>";byId("hook-registry-overlaps").innerHTML=reg.overlaps.length?reg.overlaps.map(function(o){return "<p class=\"help\">Overlap on <code>"+esc(o.event)+"</code> / <code>"+esc(o.functionTag)+"</code> between "+esc(o.owners.join(" and "))+". AIH reports it and does not resolve it; you decide.</p>"}).join(""):"<p class=\"help\">No overlap between the selected hooks. AIH never merges an overlap on your behalf: silent merging causes capability loss that cannot be diagnosed from the resulting configuration.</p>";byId("hook-registry-spawns").innerHTML=reg.spawnProjection.events.map(function(ev){return "<p class=\"help\"><code>"+esc(ev.event)+"</code>: "+ev.entries+" entries, "+ev.spawns+" expected process spawns (nested launcher spawns included).</p>"}).join("")+"<p class=\"help\">Total: "+reg.spawnProjection.totalEntries+" entries, "+reg.spawnProjection.totalSpawns+" process spawns per full firing. A hook a source reports as disabled still spawns a process: that control is read inside the launcher, after the process exists ("+reg.spawnProjection.sourceDisabledSpawns+" spawns here)."+(reg.entries.some(function(e){return e.owner!=="aih"})?" The pinned catalog carries third-party hook components with provenance but no per-hook registration table, so these counts cover only the registrations recorded here — a small number is not a complete one.":"")+"</p>"};const renderRows=function(){const g=governance();byId("mcp-rows").innerHTML=model.catalog.mcp.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];return row(item.id,item.description,status[0],status[1],tick("data-reviewed",item.id,Boolean(existing),item.id).replace("<button ",existing?"<button disabled ":"<button "),controlProvenance(item.id))}).join("");byId("hook-rows").innerHTML=model.catalog.hooks.map(function(item){const existing=g.catalog.reviewed.find(function(c){return c.id===item.id});const status=existing?candidateStatus(existing):["Disabled","pending"];const provenance=controlProvenance(item.id);return row(item.id,item.description,status[0],status[1],tick("data-reviewed",item.id,Boolean(existing),item.id).replace("<button ",existing?"<button disabled ":"<button "),hookDisclosure(item)+(provenance?" "+provenance:""))}).join("");byId("custom-rows").innerHTML=g.catalog.custom.length?g.catalog.custom.map(function(item){const status=candidateStatus(item);return row(item.id,"Pinned custom source - no activation affordance",status[0],status[1],"",customNextAction(item))}).join(""):"<p class=\"help\">No custom candidates.</p>";byId("curation-rows").innerHTML=g.externalCuration.length?g.externalCuration.flatMap(function(group){return group.items.map(function(item){return row(group.framework+": "+item.kind+" / "+item.id,"Audit "+item.audit.record+" - report-only", "External guidance - not enforced","external")})}).join(""):"<p class=\"help\">No external curation intent.</p>";byId("framework-rows").innerHTML=frameworkInventoryRows();renderHookRegistry()};
const compositionNamedCount=function(){return model.catalog.enterpriseComposition.parts.reduce(function(total,part){return total+part.componentIds.length},0)};
const partSelectedCount=function(part){const ids=selectedItems(model.catalog.enterpriseComposition.framework).map(function(item){return item.id});return part.componentIds.filter(function(id){return ids.indexOf(id)!==-1}).length};
const renderComposition=function(){const composition=model.catalog.enterpriseComposition;byId("composition-parts").innerHTML='<p class="help">Every component below is owned by '+esc(composition.framework)+', which installs and runs it; AIH records the selection with its pinned source. Choosing Enterprise selects the Core parts. The additive parts are yours to add, here or from any inventory row.</p>'+composition.parts.map(function(part){const selected=partSelectedCount(part);const complete=selected===part.componentIds.length;const action=part.selection==="additive"?'<button type="button" data-composition-add="'+esc(part.id)+'">'+(complete?"Remove these":"Add these")+'</button>':"";return '<div class="row"><div><strong>'+esc(part.label)+'</strong><p>Derived from '+esc(part.rule)+'.</p><p class="mono">'+esc(part.componentIds.join(" "))+'</p></div><span class="badge '+(complete?"requested":"external")+'">'+esc(selected+" of "+part.componentIds.length+" selected"+(part.selection==="additive"?" - additive":" - Core"))+'</span>'+action+'</div>'}).join("")};
const renderReceipt=function(){const receipt=state.receipt;const rows=[];if(receipt&&Array.isArray(receipt.approvals)){receipt.approvals.forEach(function(item){rows.push(row(item.id||"approval",(item.issuer||"unknown issuer")+" — preserved/preflight-only", "Not verified / not effective","pending"))})}if(receipt&&Array.isArray(receipt.evidence)){receipt.evidence.forEach(function(item){rows.push(row(item.id||"evidence",(item.state||"unknown")+" evidence — preserved/preflight-only", "Not verified / not effective","pending"))})}byId("approval-rows").innerHTML=rows.length?rows.join(""):"<p class=\"help\">Import an authority receipt to preserve and inspect its subjects; target-repository verification decides authority.</p>";byId("receipt-state").textContent=receipt?"Receipt preserved for preflight only; this browser does not verify it or create effective approval.":"No authority receipt imported.";byId("copy-approvals").disabled=!(receipt&&Array.isArray(receipt.approvals))};
/* The report preview's fulfillment summary extends the same three states as
   three counts, over exactly the rows the plane actually annotates - walking
   the identical (activeSelectionFramework, frameworkGroups,
   isFrameworkSelected, selectedAssetAuthorizable) primitives the rows above
   are built from, so a row and this tally can never disagree about the same
   component (previously they could: this used to walk the raw selections
   directly, which could count a selection shadowed by a duplicate framework
   group, a selection for the framework not currently shown, or an id the pin
   does not carry, none of which render as an annotated row at all).
   Anything selected in the raw policy this pass does not recognize is never
   folded into "evidence owed", which the engine reserves for a component the
   pin DOES carry - it gets its own, honestly-named count instead. */
const fulfillmentCounts=function(){
  const counts={materializes:0,vetBlocked:0,evidenceOwed:0,notShownAsRow:0};
  const active=activeSelectionFramework(governance());
  const recognized=new Set();
  frameworkGroups().filter(function(group){return !active||group.framework===active})
    .forEach(function(group){group.rows.forEach(function(entry){
      const framework=entry.framework,asset=entry.asset;
      if(!isFrameworkSelected(framework.id,asset.id))return;
      if(!selectedAssetAuthorizable(framework.id,asset))return;
      recognized.add(framework.id+"|"+asset.id);
      const classification=classifyFulfillment(asset.vet);
      if(classification===FULFILLMENT_VET_BLOCKED){counts.vetBlocked++}
      else if(classification===FULFILLMENT_MATERIALIZES){counts.materializes++}
      else{counts.evidenceOwed++}
    })});
  externalSelectionGroups().forEach(function(group){group.items.forEach(function(item){
    if(!recognized.has(group.framework+"|"+item.id)){counts.notShownAsRow++}
  })});
  return counts};
const renderPreview=function(){byId("config-preview").value=policyText();const g=governance();const requested=g.activations.filter(function(item){return item.state==="active"}).map(function(item){return item.candidate});const custom=g.catalog.custom.map(function(item){return item.id+": Blocked - custom MCP has no supported projector/scanning/evidence"});const fulfillment=fulfillmentCounts();byId("report-preview").value=["Policy Workbench preview", "", "Requested intent: "+(requested.join(", ")||"none"), "Effective: not evaluated - import this policy into a target repository for engine verification.", "", "External selections: "+externalSelectionGroups().reduce(function(total,item){return total+item.items.length},0)+" requested item(s), audit evidence still owed.","External curation: "+g.externalCuration.reduce(function(total,item){return total+item.items.length},0)+" report-only item(s).", "", "Fulfillment summary (governed projection, engine-evaluated): "+fulfillment.materializes+" would materialize directly, "+fulfillment.vetBlocked+" vet-blocked and recorded as intent only, "+fulfillment.evidenceOwed+" with evidence still owed, "+fulfillment.notShownAsRow+" selected but not shown as a row at this pin.", "", "Hard blocked:",].concat(custom.length?custom:["none"]).join("\n")};
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
/* The owner ticker. One surface at a time, so an administrator can look at what
   AIH owns without ECC's 136 components in the way.

   OWNERS is the whole contract: a new surface is one entry here plus group
   cards carrying its data-owner, and nothing about the layout changes. That is
   where VibeSec and Voice land when they arrive - they are AIH-owned
   capability surfaces, so they sit after AIH and before the third-party
   frameworks, which keeps the ticker ordered first-party then third-party.
   UPCOMING renders them as declared-but-not-yet-shipped rather than leaving the
   administrator to wonder whether the surface exists and is empty. */
const OWNERS=[["all","All"],["AIH","AIH"],["ECC","ECC"],["Superpowers","Superpowers"],["You","Your sources"]];
const UPCOMING=["VibeSec","Voice"];
let ownerFocus="all";
let activePreset="";
const PRESETS=[["vibe","Vibe","Everything this catalog offers. Nothing is hidden for want of AIH enforcement."],
  ["enterprise","Enterprise","ECC Core selected; languages and security offered as additive choices."]];
const railKinds=[["rail-langs","lang"],["rail-frameworks","framework"],["rail-caps","capability"],["rail-modules","module"]];
const buildRail=function(){const framework=eccFramework();if(!framework){return}railKinds.forEach(function(entry){const host=byId(entry[0]);if(!host){return}host.innerHTML=framework.assets.filter(function(asset){return asset.kind===entry[1]}).map(function(asset){return '<button type="button" class="chip" data-framework-select="'+esc(framework.id+"|"+asset.kind+"|"+asset.id)+'" aria-pressed="false">'+esc(asset.id.slice(asset.id.indexOf(":")+1))+'</button>'}).join("")})};
const syncRail=function(){const framework=eccFramework();if(!framework){return}const chosen=selectedItems(framework.id).map(function(item){return item.id});document.querySelectorAll(".chip[data-framework-select]").forEach(function(chip){const id=String(chip.getAttribute("data-framework-select")).split("|")[2];chip.setAttribute("aria-pressed",chosen.indexOf(id)===-1?"false":"true")});const posture=byId("rail-posture");if(posture){posture.textContent=state.policy.minimumPosture||"vibe"}
  document.querySelectorAll("[data-preset]").forEach(function(node){node.setAttribute("aria-pressed",node.getAttribute("data-preset")===activePreset?"true":"false")})};
/* One pass over the rendered rows: it applies the filter, counts each group,
   paints its meter, and totals the ledger. Reading the DOM keeps the tally
   honest about what an administrator can actually see. */
const paintShell=function(){const totals={requested:0,pending:0,blocked:0,external:0};let shown=0,total=0,vetBlocked=0;
  document.querySelectorAll(".grp").forEach(function(group){const counts={requested:0,pending:0,blocked:0,external:0};let rows=0,visible=0;
    group.querySelectorAll(".row[data-state]").forEach(function(node){const kindState=node.getAttribute("data-state");rows++;if(counts[kindState]!==undefined){counts[kindState]++;totals[kindState]++}
      const vetted=node.getAttribute("data-vetted")==="blocked";if(vetted){vetBlocked++}
      const match=planeFilter==="all"||(planeFilter==="vet-blocked"?vetted:planeFilter===kindState);node.hidden=!match;if(match){visible++}});
    total+=rows;shown+=visible;
    const count=group.querySelector(".ct");if(count){count.textContent=rows?(planeFilter==="all"?String(rows):visible+" / "+rows):""}
    const meter=group.querySelector(".meter");if(meter){meter.innerHTML=rows?ROW_STATES.filter(function(s){return counts[s]}).map(function(s){return '<i data-s="'+s+'" style="width:'+(counts[s]/rows*100)+'%"></i>'}).join(""):""}});
  byId("c-shown").textContent=shown;byId("c-total").textContent=total;
  ROW_STATES.forEach(function(s){const node=byId(s==="requested"?"t-req":s==="pending"?"t-wait":s==="blocked"?"t-blk":"t-ext");if(node){node.textContent=totals[s]}});
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
  pending:"No AIH control is awaiting a request.",
  blocked:"Nothing is blocked. A row lands here when an AIH-owned gate fails - a custom source without a completed scan bound to its exact pin is the usual one."};
document.addEventListener("click",function(event){const head=event.target.closest&&event.target.closest("[data-group]");if(!head){return}const group=head.closest(".grp");const next=group.dataset.open==="1"?"0":"1";group.dataset.open=next;head.setAttribute("aria-expanded",next==="1"?"true":"false");const label=head.querySelector("h2");if(label){openGroups[label.textContent]=next==="1"}});
/* ── drawer: every detail the compact row deliberately does not carry ────── */
const drawerNode=byId("drawer"),scrimNode=byId("scrim");
const kv=function(key,value){return '<div><span>'+esc(key)+'</span><b>'+value+'</b></div>'};
const describeRow=function(id){
  const mcp=model.catalog.mcp.find(function(item){return item.id===id});
  if(mcp){return {id:id,owner:"AIH",enforce:true,desc:mcp.description,control:mcp.control,server:mcp.server}}
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
  const item=describeRow(id);const host=byId("drawer-detail");
  const close='<button type="button" class="x" data-drawer-close aria-label="Close details">&#10005;</button>';
  if(!item){host.innerHTML='<div class="dhead"><h2>'+esc(id)+'</h2>'+close+'</div>';return}
  const selected=item.asset?isFrameworkSelected(item.framework.id,item.asset.id):
    (item.control?governance().catalog.reviewed.some(function(entry){return entry.id===item.id}):false);
  const state=item.custom?"blocked":selected?(item.enforce?"selected":"requested"):"available";
  let html='<div class="dhead"><h2>'+esc(item.id)+'</h2>'+close+'</div>'+
    '<div class="badges"><span class="b '+(item.owner==="AIH"?"ok":"ext")+'">'+esc(item.owner)+(item.enforce?" enforces":" &mdash; records only")+'</span>'+
    '<span class="b '+(state==="blocked"?"bad":state==="selected"?"ok":state==="requested"?"ext":"")+'">'+esc(state)+'</span></div>';
  html+='<div class="kv">'+kv("Requested",(selected||item.custom)?"yes":"no")+
    kv("Gate",item.custom?"blocked":state==="requested"?"records intent only":state==="selected"?"pass":"n/a");
  if(item.control){html+=kv("Projector",esc(item.control.projector)+" &rarr; "+esc(item.control.targets.join(", ")))+kv("Lifecycle",esc(item.control.lifecycle))}
  if(item.asset){html+=kv("Kind",esc(item.asset.kind))+kv("Repository",esc(item.asset.source.repository))+kv("Pinned commit",esc(item.asset.source.commit))+kv("Source path",esc(item.asset.source.path))}
  html+='</div>';
  if(item.desc){html+='<p class="note ok">'+esc(item.desc)+'</p>'}
  if(item.asset){html+='<p class="note">'+esc(item.framework.id)+' owns this component; by default it installs and runs it. AIH records the selection with its pinned source; recording intent is not enforcement.</p>'}
  /* The row and its detail state the fulfillment consequence once selected -
     the drawer is exactly the "detail" the compact row deliberately does not
     carry (see the comment above paintDrawer). Gated the same way the row's
     own annotation is: never for a kind-mismatched (malformed) selection. */
  if(item.asset&&selected&&selectedAssetAuthorizable(item.framework.id,item.asset)){
    const classification=classifyFulfillment(item.asset.vet);
    const fulfillment=fulfillmentNote(item.framework,item.asset.vet);
    html+='<p class="note'+(classification===FULFILLMENT_VET_BLOCKED?" bad":classification===FULFILLMENT_MATERIALIZES?" ok":"")+'">'+esc(fulfillment)+'</p>'}
  /* ECC's own declaration riders, stated before the click rather than
     discovered after it. Adding them is a separate, explicit action: the
     policy document has no field in which to refcount who pulled what in, so
     inventing an implicit cascade would author state it cannot represent. */
  if(item.asset&&item.asset.riders&&item.asset.riders.length){const missing=item.asset.riders.filter(function(id){return !isFrameworkSelected(item.framework.id,id)});
    html+='<div class="cap">Brings in with it</div><div class="kv">'+item.asset.riders.map(function(id){return kv(id,isFrameworkSelected(item.framework.id,id)?"selected":"not selected")}).join("")+'</div>'+
      '<p class="note">'+esc(item.framework.id)+' declares these alongside '+esc(item.asset.id)+'. Selecting it does not pull them in on its own - add them here so every selection in the policy is one you made.</p>'+
      (missing.length?'<div class="brow"><button type="button" class="btn sm" data-add-riders="'+esc(item.framework.id+"|"+item.asset.id)+'">Add '+missing.length+' rider(s) too</button></div>':"")}
  if(item.hook){html+='<div class="cap">Hook disclosure</div><div class="kv">'+
    kv("Trigger / event",esc(item.hook.behaviour.trigger))+kv("Records",esc(item.hook.behaviour.records))+
    kv("Artifact written",esc(item.hook.behaviour.artifact))+kv("Failure behaviour",esc(item.hook.behaviour.failureMode))+
    kv("Host targets",esc(item.control.targets.join(", ")))+
    kv("Script identity","<code>"+esc(item.control.source.scriptDigest)+"</code>")+
    kv("Ownership","AIH authored, AIH enforced")+'</div>'}
  if(item.asset){const command=evidenceCommand(item.framework,item.asset);
    html+='<div class="cmdline"><code>'+esc(command)+'</code><button type="button" class="copy" data-copy="'+esc(command)+'">COPY</button></div>'+
      '<p class="note">Run this where you have repository access. Evidence returns to <code>.aih/evidence/</code> in the governed repository, and is what moves this selection into external curation.</p>'+
      '<div class="brow"><button type="button" class="btn sm '+(selected?"danger":"primary")+'" data-framework-select="'+esc(item.framework.id+"|"+item.asset.kind+"|"+item.asset.id)+'">'+(selected?"Remove from policy":"Add to policy")+'</button>'+
      (item.asset.curationKind?'<button type="button" class="btn sm" data-curation-prefill="'+esc(item.framework.id+"|"+item.asset.curationKind+"|"+item.asset.id)+'">Record curation evidence</button>':"")+'</div>'}
  if(item.control&&!item.hook){html+='<div class="brow"><button type="button" class="btn sm '+(selected?"danger":"primary")+'" data-reviewed="'+esc(item.id)+'">'+(selected?"Remove request":"Request intent")+'</button></div>'}
  if(item.custom){html+='<p class="note bad">'+esc(customNextAction(item.custom))+'</p>'}
  host.innerHTML=html};
const openDrawer=function(id){drawerNode.hidden=false;scrimNode.classList.add("open");paintDrawer(id);drawerNode.dataset.item=id};
const closeDrawer=function(){scrimNode.classList.remove("open");drawerNode.hidden=true;delete drawerNode.dataset.item};
scrimNode.addEventListener("click",closeDrawer);
/* data-detail, not data-open: the group cards carry data-open for their own
   collapsed state, so an opener keyed on it matched the enclosing card from
   every click inside a group and opened a stub drawer whose scrim then blocked
   the toolbar. Distinct attributes for distinct jobs. */
document.addEventListener("click",function(event){const opener=event.target.closest&&event.target.closest("[data-detail]");if(opener){openDrawer(opener.getAttribute("data-detail"));return}
  if(event.target.closest&&event.target.closest("[data-drawer-close]")){closeDrawer()}});
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
byId("open-custom").addEventListener("click",function(){openDrawer("Your sources");byId("custom-editor").open=true;byId("custom-id").focus()});
const spotNode=byId("spot-bd"),spotQuery=byId("spot-q"),hitsNode=byId("hits");
let spotIndex=0;
const spotItems=function(){const list=[];
  model.catalog.mcp.forEach(function(item){list.push({id:item.id,group:"AIH MCP servers"})});
  model.catalog.hooks.forEach(function(item){list.push({id:item.id,group:"AIH hooks"})});
  model.catalog.frameworks.forEach(function(framework){framework.assets.forEach(function(asset){
    list.push({id:framework.id+" / "+asset.kind+": "+asset.id,group:assetGroup(framework,asset)})})});
  return list};
const spotMatches=function(){const text=spotQuery.value.trim().toLowerCase();
  return spotItems().filter(function(item){return !text||item.id.toLowerCase().indexOf(text)!==-1}).slice(0,40)};
const paintHits=function(){const matches=spotMatches();
  hitsNode.innerHTML=matches.map(function(item,index){return '<button type="button" class="hit'+(index===spotIndex?" sel":"")+'" data-hit="'+esc(item.id)+'"><span class="hid">'+esc(item.id)+'</span><span class="hg">'+esc(item.group)+'</span></button>'}).join("")||'<p class="spot-foot">No item matches. Every id stays searchable.</p>';
  byId("spot-count").textContent="searches all "+spotItems().length+" items"};
const openSpot=function(){spotNode.classList.add("open");spotQuery.value="";spotIndex=0;paintHits();spotQuery.focus()};
const closeSpot=function(){spotNode.classList.remove("open")};
byId("seek").addEventListener("click",openSpot);
spotQuery.addEventListener("input",function(){spotIndex=0;paintHits()});
spotNode.addEventListener("click",function(event){if(event.target===spotNode){closeSpot();return}
  const hit=event.target.closest&&event.target.closest("[data-hit]");if(hit){closeSpot();openDrawer(hit.getAttribute("data-hit"))}});
document.addEventListener("keydown",function(event){
  if(event.key==="/"&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){event.preventDefault();openSpot();return}
  if(event.key==="Escape"){closeSpot();closeDrawer();closeSheet();return}
  if(!spotNode.classList.contains("open")){return}
  const matches=spotMatches();
  if(event.key==="ArrowDown"){event.preventDefault();spotIndex=Math.min(spotIndex+1,matches.length-1);paintHits()}
  if(event.key==="ArrowUp"){event.preventDefault();spotIndex=Math.max(spotIndex-1,0);paintHits()}
  if(event.key==="Enter"&&matches[spotIndex]){event.preventDefault();closeSpot();openDrawer(matches[spotIndex].id)}});
document.addEventListener("click",function(event){const filter=event.target.closest&&event.target.closest(".f[data-filter]");if(!filter){return}planeFilter=filter.getAttribute("data-filter");document.querySelectorAll(".f[data-filter]").forEach(function(node){node.setAttribute("aria-pressed",node===filter?"true":"false")});paintShell()});
const render=function(){byId("posture").value=state.policy.minimumPosture||"vibe";byId("profile").value=activePreset;syncFrameworkSelect();renderRows();renderComposition();renderReceipt();renderPreview();syncRail();paintHosts();paintShell();byId("dispositionable-findings").textContent=model.findings.dispositionable.join(" | ");byId("hard-blockers").textContent=model.findings.fenced.join(" | ");if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}};
byId("profile").addEventListener("change",function(event){const value=event.target.value;activePreset=value;if(value==="vibe"){composeVibeProfile();return}if(value==="enterprise"){composeEnterpriseProfile()}});
byId("posture").addEventListener("change",function(event){const value=event.target.value;activePreset="";state.policy.minimumPosture=value;announce("Posture changed without modifying selections. Enterprise requires an explicit supported-CLI allow-list before export.");render()});
const closeTooltips=function(){document.querySelectorAll(".tooltip[data-open='true']").forEach(function(tip){tip.setAttribute("data-open","false")});document.querySelectorAll("[data-tooltip-button][aria-expanded='true']").forEach(function(button){button.setAttribute("aria-expanded","false")})};
const openTooltip=function(button){closeTooltips();button.setAttribute("aria-expanded","true");button.removeAttribute("data-tooltip-dismissed");const tip=byId(button.getAttribute("data-tooltip-button"));if(tip){const rect=button.getBoundingClientRect();const width=Math.min(368,Math.max(24,window.innerWidth-32));tip.style.width=width+"px";tip.style.left=Math.max(16,Math.min(rect.left,window.innerWidth-16-width))+"px";tip.style.top=Math.max(16,rect.bottom+4)+"px";tip.setAttribute("data-open","true")}};
document.addEventListener("focusin",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton&&!helpButton.hasAttribute("data-tooltip-dismissed")){openTooltip(helpButton)}});
document.addEventListener("focusout",function(event){const helpButton=event.target.closest&&event.target.closest("[data-tooltip-button]");if(helpButton){helpButton.removeAttribute("data-tooltip-dismissed");closeTooltips()}});
document.addEventListener("pointerover",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper){const helpButton=wrapper.querySelector("[data-tooltip-button]");if(helpButton){openTooltip(helpButton)}}});
document.addEventListener("pointerout",function(event){const wrapper=event.target.closest&&event.target.closest(".tip-wrap");if(wrapper&&!wrapper.contains(event.relatedTarget)){closeTooltips()}});
document.addEventListener("click",function(event){const helpButton=event.target.closest("[data-tooltip-button]");if(helpButton){openTooltip(helpButton);return}const target=event.target.closest("[data-reviewed]");if(target){toggleReviewed(target.getAttribute("data-reviewed"));return}closeTooltips()});
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
byId("import-evidence").addEventListener("click",function(){byId("evidence-file").click()});byId("evidence-file").addEventListener("change",function(event){readFile(event.target,function(text){try{const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value)){throw new Error("not an object")}state.receipt=value;announce("Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.");renderReceipt();if(typeof window.__aihPolicyWorkbenchEnhanceRows==="function"){window.__aihPolicyWorkbenchEnhanceRows()}}catch(error){announce("Evidence import failed: valid JSON object required.",true)}})});
byId("copy-approvals").addEventListener("click",function(){if(state.receipt&&Array.isArray(state.receipt.approvals)){const previous=structuredClone(state.policy);governance().authority.approvals=structuredClone(state.receipt.approvals);commitPolicy(previous,"Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.")}});
byId("validate").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Schema and policy-grammar validation failed: "+problems.slice(0,3).join("; "),true)}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.")}renderPreview()});
byId("export").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Export blocked: "+problems.slice(0,3).join("; "),true);return}renderPreview();announce("Policy export preview refreshed from the actual policy schema and grammar.")});
byId("download").addEventListener("click",function(){const problems=policyProblems();if(problems.length){announce("Download blocked: "+problems.slice(0,3).join("; "),true);return}const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started.")});
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
byId("curation-editor").querySelector("summary").insertAdjacentHTML("beforeend",help("external curation","AIH preserves audited curation intent for agents, skills and commands with a pin and an audit record. It never installs, projects or enforces them - ECC and Superpowers do."));
byId("custom-editor").querySelector("summary").insertAdjacentHTML("beforeend",help("custom sources","A custom MCP is recorded immediately as a fully pinned candidate and stays blocked until a completed scan binds to that exact pin."));
/* Acceptance step 3 opens with "Reset, select Enterprise, ...", so starting over
   has to be one control. It restores the generated starting policy exactly,
   which is also what makes the one-framework rule escapable. */
document.addEventListener("click",function(event){if(!event.target.closest||!event.target.closest("#clear-policy")){return}
  state.policy=structuredClone(model.initialPolicy);state.editing=null;activePreset="";
  announce("Policy cleared. Every selection, requested control and curation record is gone, and either framework can be selected again.");render()});
byId("owner-ticker").innerHTML=OWNERS.map(function(entry,index){
  return (index?'<span class="sep" aria-hidden="true">|</span>':"")+
    '<button type="button" data-owner-focus="'+esc(entry[0])+'" aria-pressed="'+(entry[0]==="all"?"true":"false")+'">'+esc(entry[1])+' <b>0</b></button>'}).join("")+
  '<span class="soon">soon '+UPCOMING.map(esc).join(" &middot; ")+'</span>';
document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-owner-focus]");if(!button){return}
  ownerFocus=button.getAttribute("data-owner-focus");paintShell()});
byId("presets").innerHTML=PRESETS.map(function(entry){return '<button type="button" class="preset" data-preset="'+esc(entry[0])+'" aria-pressed="false"><b>'+esc(entry[1])+'</b><span>'+esc(entry[2])+'</span></button>'}).join("");
document.addEventListener("click",function(event){const preset=event.target.closest&&event.target.closest("[data-preset]");if(!preset){return}const select=byId("profile");select.value=preset.getAttribute("data-preset");select.dispatchEvent(new Event("change",{bubbles:true}))});
buildRail();
render();
</script>
<script>
/* Enhancements kept separate so the portable workbench remains dependency-free. */
(function(){
  const ids={curation:["curation-kind","curation-id","curation-repository","curation-commit","curation-path","audit-record","audit-digest","curation-note"],custom:["custom-id","custom-package","custom-version","custom-integrity","custom-evidence","custom-note"],remote:["remote-custom-id","remote-custom-origin","remote-custom-approved-by","remote-custom-authentication-mode","remote-custom-data-classes","remote-custom-tool-surface-digest","remote-custom-verdict","remote-custom-evidence","remote-custom-note"]};
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
  const exportNarration=function(){const g=governance();const controls=g.activations.filter(function(item){return item.state==="active"}).length;const external=externalSelectionGroups().reduce(function(total,group){return total+group.items.length},0);return (controls+external)+" requested item(s), 0 effective in this browser; import into a target repository for engine evaluation."};
  const narrateReport=function(){const report=byId("report-preview");report.value=report.value+"\n\nExport summary: "+exportNarration()};
  const runValidation=function(event,mode){event.preventDefault();event.stopImmediatePropagation();const problems=browserProblems();if(problems.length){announce((mode==="download"?"Download blocked: ":mode==="export"?"Export blocked: ":"Schema and policy-grammar validation failed: ")+problems.slice(0,3).join("; "),true);return false}if(mode==="download"){const blob=new Blob([policyText()],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="aih-org-policy.json";link.click();URL.revokeObjectURL(url);announce("Policy download started. "+exportNarration())}else if(mode==="export"){renderPreview();narrateReport();openSheet();announce("Policy export preview refreshed from the actual policy schema and grammar. "+exportNarration())}else{announce("Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.");renderPreview()}return true};
  ["validate","export","download"].forEach(function(id){byId(id).addEventListener("click",function(event){runValidation(event,id)},true)});
byId("copy-approvals").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();if(!(state.receipt&&Array.isArray(state.receipt.approvals))){return}const previous=structuredClone(state.policy);ensureGovernance().authority.approvals=structuredClone(state.receipt.approvals);if(browserProblems().length){state.policy=previous;announce("Approval preservation rejected: imported subjects do not satisfy the actual policy grammar.",true);render();return}announce("Approval subjects preserved in governance.authority.approvals; no signature or effective-approval claim is made.");render()},true);
  const curationIssues=function(){const values={kind:byId("curation-kind").value,id:byId("curation-id").value.trim(),repository:byId("curation-repository").value.trim(),commit:byId("curation-commit").value.trim(),path:byId("curation-path").value.trim(),record:byId("audit-record").value.trim(),digest:byId("audit-digest").value.trim(),note:byId("curation-note").value.trim()};const issues={};if(!/^(agent|skill|command)$/.test(values.kind)){issues["curation-kind"]="Choose agent, skill, or command."}if(!visible(values.id)){issues["curation-id"]="Use visible text with no hidden Unicode."}if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)){issues["curation-repository"]="Use owner/repository."}if(!/^[0-9a-f]{40}$/.test(values.commit)){issues["curation-commit"]="Use a lowercase 40-character commit."}if(!values.path||values.path.startsWith("/")||values.path.startsWith("./")||values.path.includes("\\")||values.path.includes("//")||values.path.split("/").some(function(part){return !part||part==="."||part===".."})){issues["curation-path"]="Use a safe repo-relative POSIX path."}if(!visible(values.record)){issues["audit-record"]="Use visible audit-record text."}if(!/^sha256:[0-9a-f]{64}$/.test(values.digest)){issues["audit-digest"]="Use sha256: followed by 64 lowercase hex characters."}if(values.note&&!visible(values.note)){issues["curation-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const customIssues=function(){const values={id:byId("custom-id").value.trim(),pkg:byId("custom-package").value.trim(),version:byId("custom-version").value.trim(),integrity:byId("custom-integrity").value.trim(),evidence:byId("custom-evidence").value.trim(),note:byId("custom-note").value.trim()};const issues={};if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.id)){issues["custom-id"]="Use a lowercase stable identifier."}if(!/^@?[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(values.pkg)){issues["custom-package"]="Use a package identity."}if(!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(values.version)){issues["custom-version"]="Use an exact package version."}if(!/^sha256:[0-9a-f]{64}$/.test(values.integrity)){issues["custom-integrity"]="Use sha256: followed by 64 lowercase hex characters."}if(!/^[a-z][a-z0-9-]{0,63}$/.test(values.evidence)){issues["custom-evidence"]="Use a lowercase evidence record identifier."}if(values.note&&!visible(values.note)){issues["custom-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const remoteIssues=function(){const values={id:byId("remote-custom-id").value.trim(),origin:byId("remote-custom-origin").value.trim(),approvedBy:byId("remote-custom-approved-by").value.trim(),authenticationMode:byId("remote-custom-authentication-mode").value.trim(),allowedDataClasses:byId("remote-custom-data-classes").value.split(",").map(function(value){return value.trim()}).filter(Boolean),toolSurfaceDigest:byId("remote-custom-tool-surface-digest").value.trim(),verdict:byId("remote-custom-verdict").value,evidence:byId("remote-custom-evidence").value.trim(),note:byId("remote-custom-note").value.trim()};const issues={};const identifier=/^[a-z][a-z0-9-]{0,63}$/;if(!identifier.test(values.id)){issues["remote-custom-id"]="Use a lowercase stable identifier."}if(!safeBrowserHttpsOrigin(values.origin)){issues["remote-custom-origin"]="Use an exact HTTPS origin with no path, query, or credentials."}if(!identifier.test(values.approvedBy)){issues["remote-custom-approved-by"]="Use a lowercase approval identifier."}if(!visible(values.authenticationMode)){issues["remote-custom-authentication-mode"]="Use visible authentication text with no hidden Unicode."}if(!values.allowedDataClasses.length||values.allowedDataClasses.length>20||values.allowedDataClasses.some(function(value){return !identifier.test(value)})){issues["remote-custom-data-classes"]="Use one to 20 comma-separated lowercase data-class identifiers."}if(!/^sha256:[0-9a-f]{64}$/.test(values.toolSurfaceDigest)){issues["remote-custom-tool-surface-digest"]="Use sha256: followed by 64 lowercase hex characters."}if(!/^(approved|drifted|revoked)$/.test(values.verdict)){issues["remote-custom-verdict"]="Choose approved, drifted, or revoked."}if(!identifier.test(values.evidence)){issues["remote-custom-evidence"]="Use a lowercase evidence record identifier."}if(values.note&&!visible(values.note)){issues["remote-custom-note"]="Use visible clarification text with no hidden Unicode."}return {values:values,issues:issues}};
  const setCurationEditState=function(editing){byId("curation-framework").disabled=editing;byId("curation-framework-label").textContent=editing?"Framework (locked; remove and re-add to change)":"Framework";byId("cancel-curation-edit").hidden=!editing};
  byId("remote-custom-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const result=remoteIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="remote"?state.editing:null;const duplicate=governance().catalog.custom.some(function(item,index){return item.id===values.id&&(!editing||editing.index!==index)});if(duplicate){result.issues["remote-custom-id"]="That pending custom candidate already exists."}if(Object.keys(result.issues).length){recover("remote",result.issues,"Correct the highlighted remote-endpoint fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const item={id:values.id,kind:"mcp",description:"Pending remote custom MCP",capabilities:[],risks:["remote source"],source:{type:"remote",origin:values.origin,approval:{approvedBy:values.approvedBy,authenticationMode:values.authenticationMode,allowedDataClasses:values.allowedDataClasses},toolSurfaceDigest:values.toolSurfaceDigest,verdict:values.verdict,contentScanned:false},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:values.evidence}};if(values.note){item.clarification=values.note}if(editing){g.catalog.custom[editing.index]=item}else{g.catalog.custom.push(item)}if(commitPolicy(previous,editing?"Pending remote MCP updated. It remains blocked and cannot be activated.":"Pending remote MCP recorded. It remains blocked and cannot be activated.")){state.editing=null;clearFields("remote");event.currentTarget.reset()}},true);
  const resetCurationEditor=function(){state.editing=null;setCurationEditState(false);clearFields("curation")};
  ids.curation.forEach(function(id){byId(id).addEventListener("input",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")});byId(id).addEventListener("change",function(){const result=curationIssues();fieldError(id,result.issues[id]||"")})});
  ids.custom.forEach(function(id){byId(id).addEventListener("input",function(){const result=customIssues();fieldError(id,result.issues[id]||"")})});
  ids.remote.forEach(function(id){byId(id).addEventListener("input",function(){const result=remoteIssues();fieldError(id,result.issues[id]||"")})});
  byId("add-curation").addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();const result=curationIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="curation"?state.editing:null;const frameworkId=editing?editing.framework:byId("curation-framework").value;const existingGroup=governance().externalCuration.find(function(item){return item.framework===frameworkId});const duplicate=existingGroup&&existingGroup.items.some(function(item,index){return item.kind===values.kind&&item.id===values.id&&(!editing||editing.framework!==existingGroup.framework||editing.index!==index)});if(duplicate){result.issues["curation-id"]="That framework item already exists."}if(Object.keys(result.issues).length){recover("curation",result.issues,"Correct the highlighted curation fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const group=g.externalCuration.find(function(item){return item.framework===frameworkId});const item={kind:values.kind,id:values.id,source:{repository:values.repository,commit:values.commit,path:values.path},audit:{record:values.record,digest:values.digest}};if(values.note){item.clarification=values.note}if(editing){const target=g.externalCuration.find(function(entry){return entry.framework===editing.framework});if(!target||!target.items[editing.index]){state.policy=previous;announce("The curation item changed before it could be saved; nothing was replaced.",true);return}target.items[editing.index]=item}else if(group){group.items.push(item)}else{g.externalCuration.push({framework:frameworkId,items:[item]})}if(commitPolicy(previous,editing?"External curation intent updated; it remains report-only and not enforced by AIH.":"External curation intent added; it is report-only and not enforced by AIH.")){resetCurationEditor();byId("curation-id").value="";byId("curation-note").value=""}},true);
  byId("cancel-curation-edit").addEventListener("click",function(){if(!(state.editing&&state.editing.kind==="curation")){return}resetCurationEditor();announce("Curation edit cancelled. Select a framework to add a new report-only item.")});
  byId("custom-form").addEventListener("submit",function(event){event.preventDefault();event.stopImmediatePropagation();const result=customIssues();const values=result.values;const editing=state.editing&&state.editing.kind==="custom"?state.editing:null;const duplicate=governance().catalog.custom.some(function(item,index){return item.id===values.id&&(!editing||editing.index!==index)});if(duplicate){result.issues["custom-id"]="That pending custom candidate already exists."}if(Object.keys(result.issues).length){recover("custom",result.issues,"Correct the highlighted custom-candidate fields.");return}const previous=structuredClone(state.policy);const g=ensureGovernance();const item={id:values.id,kind:"mcp",description:"Pending custom MCP",capabilities:[],risks:["custom source"],source:{type:"stdio",resolver:"npx",registry:"https://registry.npmjs.org",package:values.pkg,version:values.version,integrity:values.integrity},targets:["claude"],projector:"mcp-managed-settings",lifecycle:"supported",evidence:{record:values.evidence}};if(values.note){item.clarification=values.note}if(editing){g.catalog.custom[editing.index]=item}else{g.catalog.custom.push(item)}if(commitPolicy(previous,editing?"Pending custom MCP updated. It remains blocked and cannot be activated.":"Pending custom MCP added. It cannot be activated.")){state.editing=null;clearFields("custom");event.currentTarget.reset()}},true);
  const detail=function(row,label,lines){if(row.querySelector(".row-details")){return}const primary=row.querySelector(".row-slot")||row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const body=document.createElement("p");body.className="mono";body.textContent=lines.join(" · ");disclosure.append(summary,body);primary.append(disclosure)};
  const importedRecordText=function(record){try{return JSON.stringify(record,null,2)}catch(_error){return "[unserializable imported record]"}};
  const receiptDetail=function(row,label,type,record){if(row.querySelector(".row-details")){return}const primary=row.querySelector(".row-slot")||row.firstElementChild;if(!primary){return}const disclosure=document.createElement("details");disclosure.className="row-details";const summary=document.createElement("summary");summary.textContent="Details for "+label;const notice=document.createElement("p");notice.className="mono";notice.textContent="Status: preserved/preflight-only; not verified or effective. Full imported "+type+" record (untrusted):";const body=document.createElement("pre");body.className="mono receipt-record";body.textContent=importedRecordText(record);disclosure.append(summary,notice,body);primary.append(disclosure)};
  const action=function(row,label,kind,index,framework){let actions=row.querySelector(".row-actions");if(!actions){actions=document.createElement("div");actions.className="row-actions";row.append(actions)}if(actions.querySelector("[data-workbench-action]")){return}[ ["Edit / prefill","edit"],["Remove","remove"] ].forEach(function(item){const button=document.createElement("button");button.type="button";button.textContent=item[0];button.setAttribute("aria-label",item[0]+" "+label);button.dataset.workbenchAction=item[1];button.dataset.workbenchKind=kind;button.dataset.workbenchIndex=String(index);if(framework){button.dataset.workbenchFramework=framework}actions.append(button)})};
  const enhanceRows=function(){setCurationEditState(Boolean(state.editing&&state.editing.kind==="curation"));const g=governance();Array.from(byId("custom-rows").querySelectorAll(".row")).forEach(function(row,index){const item=g.catalog.custom[index];if(!item){return}row.dataset.evidenceRecord=item.evidence.record;const remote=item.source.type==="remote";detail(row,item.id,remote?["Status: pending and blocked; no activation affordance.","Remote origin: "+item.source.origin,"Approved by: "+item.source.approval.approvedBy,"Authentication: "+item.source.approval.authenticationMode,"Allowed data classes: "+item.source.approval.allowedDataClasses.join(", "),"Tool-surface digest: "+item.source.toolSurfaceDigest,"Remote verdict: "+item.source.verdict,"Content scan: none","Evidence record: "+item.evidence.record,"Clarification: "+(item.clarification||"none")]:["Status: pending and blocked; no activation affordance.","Package: "+item.source.package+" @ "+item.source.version,"Registry: "+item.source.registry,"Integrity: "+item.source.integrity,"Evidence record: "+item.evidence.record,"Clarification: "+(item.clarification||"none")]);action(row,item.id,remote?"remote":"custom",index)});let curationIndex=0;g.externalCuration.forEach(function(group){group.items.forEach(function(item,index){const row=byId("curation-rows").querySelectorAll(".row")[curationIndex++];if(!row){return}detail(row,group.framework+" "+item.kind+" "+item.id,["Status: report-only external guidance; not enforced by AIH.","Repository: "+item.source.repository,"Commit: "+item.source.commit,"Path: "+item.source.path,"Audit record: "+item.audit.record,"Audit digest: "+item.audit.digest,"Clarification: "+(item.clarification||"none")]);action(row,item.id,"curation",index,group.framework)})});const receipt=state.receipt||{};const approvalItems=Array.isArray(receipt.approvals)?receipt.approvals:[];const evidenceItems=Array.isArray(receipt.evidence)?receipt.evidence:[];const receiptRows=byId("approval-rows").querySelectorAll(".row");approvalItems.forEach(function(item,index){const row=receiptRows[index];if(!row){return}receiptDetail(row,item.id||"approval","approval",item)});evidenceItems.forEach(function(item,index){const row=receiptRows[approvalItems.length+index];if(!row){return}const evidenceId=typeof item.id==="string"?item.id:"evidence";row.dataset.evidenceRecord=evidenceId;const customRow=Array.from(byId("custom-rows").querySelectorAll(".row")).find(function(candidateRow){return candidateRow.dataset.evidenceRecord===evidenceId});if(customRow){row.classList.add("evidence-linked");customRow.classList.add("evidence-linked");row.dataset.evidenceAssociation="pending-custom";customRow.dataset.evidenceAssociation="preflight-receipt";row.setAttribute("aria-label","Preflight evidence record "+evidenceId+" matches a pending custom MCP; it is not verified or effective.");customRow.setAttribute("aria-label","Pending custom MCP has matching preflight evidence record "+evidenceId+"; it is not verified or effective.")}receiptDetail(row,evidenceId,"evidence",item)})};
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest('[data-workbench-kind="curation"]');if(!button){return}if(button.dataset.workbenchAction==="edit"){setCurationEditState(true)}if(button.dataset.workbenchAction==="remove"){resetCurationEditor()}});
  document.addEventListener("click",function(event){const button=event.target.closest&&event.target.closest("[data-workbench-action]");if(!button){return}event.preventDefault();const g=governance();const index=Number(button.dataset.workbenchIndex);const kind=button.dataset.workbenchKind;const mode=button.dataset.workbenchAction;if(!Number.isInteger(index)){return}if(kind==="custom"){const item=g.catalog.custom[index];if(!item){return}if(mode==="edit"){byId("custom-id").value=item.id;byId("custom-package").value=item.source.package;byId("custom-version").value=item.source.version;byId("custom-integrity").value=item.source.integrity;byId("custom-evidence").value=item.evidence.record;byId("custom-note").value=item.clarification||"";state.editing={kind:"custom",index:index};announce("Editing pending custom MCP. Save validates before replacing the existing blocked candidate.")}else{const previous=structuredClone(state.policy);g.catalog.custom.splice(index,1);if(commitPolicy(previous,"Pending custom MCP removed; it was never active.")){state.editing=null}}}else if(kind==="remote"){const item=g.catalog.custom[index];if(!item||item.source.type!=="remote"){return}if(mode==="edit"){byId("remote-custom-id").value=item.id;byId("remote-custom-origin").value=item.source.origin;byId("remote-custom-approved-by").value=item.source.approval.approvedBy;byId("remote-custom-authentication-mode").value=item.source.approval.authenticationMode;byId("remote-custom-data-classes").value=item.source.approval.allowedDataClasses.join(", ");byId("remote-custom-tool-surface-digest").value=item.source.toolSurfaceDigest;byId("remote-custom-verdict").value=item.source.verdict;byId("remote-custom-evidence").value=item.evidence.record;byId("remote-custom-note").value=item.clarification||"";state.editing={kind:"remote",index:index};announce("Editing pending remote MCP. Save validates before replacing the existing blocked candidate.")}else{const previous=structuredClone(state.policy);g.catalog.custom.splice(index,1);if(commitPolicy(previous,"Pending remote MCP removed; it was never active.")){state.editing=null}}}else if(kind==="curation"){const framework=button.dataset.workbenchFramework;const group=g.externalCuration.find(function(entry){return entry.framework===framework});const item=group&&group.items[index];if(!item){return}if(mode==="edit"){byId("curation-framework").value=framework;syncFrameworkSelect();byId("curation-kind").value=item.kind;byId("curation-id").value=item.id;byId("curation-repository").value=item.source.repository;byId("curation-commit").value=item.source.commit;byId("curation-path").value=item.source.path;byId("audit-record").value=item.audit.record;byId("audit-digest").value=item.audit.digest;byId("curation-note").value=item.clarification||"";state.editing={kind:"curation",framework:framework,index:index};announce("Editing external curation. Save validates before replacing the report-only intent.")}else{const previous=structuredClone(state.policy);group.items.splice(index,1);if(!group.items.length){g.externalCuration=g.externalCuration.filter(function(entry){return entry!==group})}if(commitPolicy(previous,"External curation intent removed; it was report-only and never enforced by AIH.")){state.editing=null}}}});
  const detailKey=function(frameworkId,id){const framework=model.catalog.frameworks.find(function(item){return item.id===frameworkId});const asset=framework&&framework.assets.find(function(item){return item.id===id});return asset?framework.id+" / "+asset.kind+": "+asset.id:null};
  const idReference=function(id,key){const button=document.createElement("button");button.type="button";button.className="rid";button.dataset.idReference=id;button.dataset.detail=key;button.textContent=id;return button};
  const enhanceIdReferences=function(){const composition=model.catalog.enterpriseComposition;Array.from(byId("composition-parts").querySelectorAll(":scope > .row")).forEach(function(row,index){const part=composition.parts[index];const host=row.querySelector("p.mono");if(!part||!host||host.querySelector("[data-id-reference]")){return}host.textContent="";part.componentIds.forEach(function(id,itemIndex){const key=detailKey(composition.framework,id);if(!key){return}if(itemIndex){host.append(document.createTextNode(" "))}host.append(idReference(id,key))})});Array.from(byId("hook-registry-rows").querySelectorAll(".hookreg")).forEach(function(row,index){const entry=model.catalog.hookRegistry.entries[index];const host=row.querySelector("b");if(!entry||!host||host.querySelector("[data-id-reference]")){return}const framework=entry.owner==="aih"?null:model.catalog.frameworks.find(function(item){return item.assets.some(function(asset){return asset.id===entry.id})&&((item.id==="superpowers"?"Superpowers":"ECC")===entry.ownerLabel)});const key=entry.owner==="aih"?entry.id:(framework&&detailKey(framework.id,entry.id));if(!key){return}host.textContent="";host.append(idReference(entry.id,key))})};
  window.__aihPolicyWorkbenchEnhanceRows=function(){enhanceRows();enhanceIdReferences()};[byId("custom-rows"),byId("curation-rows"),byId("approval-rows")].forEach(function(node){new MutationObserver(enhanceRows).observe(node,{childList:true})});[byId("composition-parts"),byId("hook-registry-rows")].forEach(function(node){new MutationObserver(enhanceIdReferences).observe(node,{childList:true})});enhanceRows();enhanceIdReferences();
})();
</script>
</body>
</html>`.replace("__AIH_DATA__", () => safeScriptJson(model));
}
