/* The user page chrome: the admin-sources header and sub-header strip, with the User badge and one extra strip entry,
 * the organization policy in use. Use: <script>WBU.top()</script>. ?source=project|env|none shows each case (default: env).
 * Lookup order is the product's own: --policy <file>, then AIH_ORG_POLICY, then aih-org-policy.json in the project.
 * The user's choices never go into that file: they are saved to aih-project-policy.json (proposed name). */
window.WBU = (function () {
  var q = new URLSearchParams(location.search).get("source");
  var SRC = {
    project: { chip: "aih-org-policy.json", org: "Acme Corp", file: "acme.policy.json", ver: "v[n]", step: 2, icon: "description", tone: "text-secondary", note: "An unchanged copy of the Acme policy, committed in this project." },
    env: { chip: "via AIH_ORG_POLICY", org: "Acme Corp", file: "acme.policy.json", ver: "v[n]", step: 1, icon: "settings", tone: "text-secondary", note: "Set once on this machine by IT." },
    none: { chip: "no org policy", org: "No organization", file: "aih Recommended", ver: "[version]", step: 3, icon: "info", tone: "text-tertiary", note: "Nothing found. aih’s own Recommended template is used." }
  };
  var key = SRC[q] ? q : "env", S = SRC[key];
  var ORDER = [
    ["--policy <file>", "a file named when a command runs"],
    ["AIH_ORG_POLICY", "a file path IT sets once per machine"],
    ["aih-org-policy.json", "an unchanged copy committed in this project"],
    ["nothing found", "aih’s Recommended template"]
  ];
  var SEP = '<span class="text-outline/40">•</span>';

  function lookup() {
    return '<div class="rounded bg-surface-container-low border border-surface-container-high/40 divide-y divide-surface-container-high/40">' +
      ORDER.map(function (o, i) {
        var hit = i === S.step, skipped = i < S.step;
        return '<div class="flex items-center justify-between gap-2 px-2.5 py-1.5 ' + (hit ? "bg-surface-container" : "") + '"><span class="flex items-center gap-1.5 min-w-0"><span class="font-mono text-[10px] text-outline w-3">' + (i + 1) + '</span><span class="min-w-0"><span class="block font-mono text-[10.5px] ' + (hit ? "text-on-surface font-semibold" : "text-on-surface-variant") + '">' + o[0] + '</span><span class="block text-[10px] text-outline">' + o[1] + '</span></span></span>' +
          '<span class="font-mono text-[10px] shrink-0 ' + (hit ? S.tone + " font-semibold" : "text-outline") + '">' + (hit ? "used" : skipped ? "not set" : "—") + '</span></div>';
      }).join("") + '</div>';
  }

  // the two files, and that the second never writes into the first
  function files() {
    return '<div class="rounded bg-surface-container-low border border-surface-container-high/40 divide-y divide-surface-container-high/40 text-[10.5px]">' +
      '<div class="flex items-center justify-between gap-2 px-2.5 py-1.5"><span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[13px] text-outline">lock</span><span class="font-mono text-on-surface">' + S.file + '</span></span><span class="text-outline">read only · never written</span></div>' +
      '<div class="flex items-center justify-between gap-2 px-2.5 py-1.5"><span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[13px] text-primary">edit_document</span><span class="font-mono text-on-surface">aih-project-policy.json</span></span><span class="text-outline">your choices · downloaded, then committed</span></div></div>';
  }

  function top() {
    document.write(
      // header: the admin-sources pattern with the User badge
      '<header class="h-11 w-full bg-surface-container-lowest border-b border-surface-container-high/60 px-3 flex items-center justify-between z-50 shrink-0 relative">' +
      '<div class="flex items-center gap-2.5 shrink-0">' +
      '<div class="flex items-center gap-2 pr-1"><div class="w-5 h-5 rounded bg-primary flex items-center justify-center shadow-sm"><span class="material-symbols-outlined text-white text-[14px]">shield_with_house</span></div>' +
      '<span class="font-semibold text-[13px] tracking-tight text-on-surface">aih Policy</span>' +
      '<span class="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium">User</span></div>' +
      '<div class="h-3.5 w-px bg-surface-container-high mx-0.5"></div>' +
      // organization: the admin's scope switcher, read-only here; opens where the policy came from
      '<div class="relative"><button class="flex items-center gap-1 px-2 py-1 rounded bg-surface-container-low hover:bg-surface-container text-on-surface text-[12px] font-medium transition-colors cursor-pointer" data-source-chip type="button" title="Which policy this page uses">' +
      '<span>' + S.org + '</span><span class="material-symbols-outlined text-[13px] text-outline">expand_more</span></button>' +
      '<div class="hidden absolute left-0 top-8 w-[360px] p-2.5 rounded bg-surface-container-lowest border border-surface-container-high/60 shadow-2xl space-y-2 text-[11px] text-on-surface-variant" data-source-pop>' +
      '<div class="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">Where the policy came from</div>' + lookup() +
      '<p class="text-[10.5px]">' + S.note + ' aih stops at the first one it finds. A broken file stops aih with an error; it never falls through.</p>' +
      '<div class="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold pt-1">Two files, never the same one</div>' + files() + '</div></div>' +
      // mode: set by the organization, shown read-only
      '<div class="flex items-center bg-surface-container-lowest p-0.5 rounded border border-surface-container-high/40" title="Set by your organization">' +
      '<span class="px-2 py-0.5 rounded text-[11px] ' + (key === "none" ? "bg-surface-container text-primary font-semibold shadow-xs" : "text-outline") + '">Vibe</span>' +
      '<span class="px-2 py-0.5 rounded text-[11px] ' + (key === "none" ? "text-outline" : "bg-surface-container text-primary font-semibold shadow-xs") + '">Enterprise</span></div>' +
      '<div class="h-3.5 w-px bg-surface-container-high mx-0.5"></div>' +
      // AI tools: the one place to pick them, as on the admin page
      '<div class="relative"><button class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors" data-tools-btn type="button" aria-haspopup="true">' +
      '<span class="w-1.5 h-1.5 rounded-full bg-secondary"></span><span class="font-mono text-on-surface" data-tools-count>2 of 3</span><span class="text-outline">AI tools</span><span class="material-symbols-outlined text-[13px] text-outline">arrow_drop_down</span></button>' +
      '<div class="hidden absolute left-0 top-7 w-56 p-2 rounded bg-surface-container-lowest border border-surface-container-high/60 shadow-2xl space-y-1 text-[11.5px]" data-tools-pop>' +
      '<div class="px-1 pb-1 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">Set up for</div>' +
      [["Claude Code", true], ["Codex CLI", true], ["Cursor", false]].map(function (t) {
        return '<label class="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-surface-container cursor-pointer text-on-surface"><input ' + (t[1] ? "checked " : "") + 'class="rounded-sm w-3.5 h-3.5 accent-primary" type="checkbox" data-tool="' + t[0] + '">' + t[0] + '</label>';
      }).join("") +
      '<p class="px-1 pt-1 text-[10px] text-outline">Only the AI tools Acme allows are listed.</p></div></div>' +
      '</div>' +
      '<div class="flex items-center gap-2 shrink-0">' +
      '<a class="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors" href="../index.html#admin-sources" target="_top" title="Open the admin page instead"><span class="material-symbols-outlined text-[13px]">swap_horiz</span>Admin page</a>' +
      '<button class="px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface text-[12px] font-medium transition-colors" type="button" title="Check your choices against the organization policy">Check Selection</button>' +
      '<button class="flex items-center gap-1 px-3 py-1 rounded bg-primary hover:bg-primary-bright text-white text-[12px] font-medium transition-colors shadow-xs" data-save type="button"><span>Save</span><span class="material-symbols-outlined text-[13px]">save</span></button>' +
      '<div class="h-3.5 w-px bg-surface-container-high mx-0.5"></div>' +
      '<button aria-label="Toggle theme" class="p-1 rounded bg-surface-container-low hover:bg-surface-container border border-surface-container-high/60 text-on-surface-variant hover:text-on-surface transition-colors flex items-center justify-center cursor-pointer shadow-xs mr-0.5" data-mode-toggle type="button"><span class="material-symbols-outlined text-[15px] text-[#ffb95f]">light_mode</span></button>' +
      '<div class="w-6 h-6 rounded-full bg-surface-container-highest border border-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[15px]">person</span></div>' +
      '</div></header>' +
      // sub-header strip: the admin-sources provenance, plus the policy in use and where choices are saved
      '<div class="h-8 bg-surface-container-lowest/90 border-b border-surface-container-high/40 px-3 flex items-center justify-between text-[11px] shrink-0">' +
      '<div class="flex items-center gap-2 min-w-0 font-mono text-[11px] text-on-surface-variant truncate">' +
      '<span class="material-symbols-outlined text-[14px] text-primary shrink-0">account_tree</span>' +
      '<span class="text-on-surface font-medium">@aihq/core <span class="text-outline/80">0.6.2</span></span>' + SEP +
      '<span class="flex items-center gap-1"><span class="text-on-surface font-medium">@aihq/scan <span class="text-outline/80">0.4.0</span></span><span class="px-1.5 py-0.5 rounded bg-surface-container-high/80 text-secondary text-[10px]">f0f9b4d</span></span>' + SEP +
      '<span class="flex items-center gap-1"><span class="text-on-surface font-medium">@aihq/catalog <span class="text-outline/80">0.2.0</span></span><span class="px-1.5 py-0.5 rounded bg-surface-container-high/80 text-secondary text-[10px]">f0a7e71</span></span>' + SEP +
      // the extra entry: which policy is used, and from where
      '<button class="flex items-center gap-1 hover:underline" data-source-chip type="button" title="Where the policy came from"><span class="text-outline">policy</span><span class="material-symbols-outlined text-[13px] ' + S.tone + '">' + S.icon + '</span><span class="text-on-surface font-medium">' + S.file + ' <span class="text-outline/80">' + S.ver + '</span></span>' +
      '<span class="px-1.5 py-0.5 rounded bg-surface-container-high/80 ' + S.tone + ' text-[10px]">' + S.chip + '</span>' +
      (key === "none" ? '' : '<span class="material-symbols-outlined text-[13px] text-secondary" title="Enterprise: signature verified">verified_user</span>') + '</button>' + SEP +
      '<span class="flex items-center gap-1"><span class="text-outline">saves to</span><span class="text-on-surface font-medium">aih-project-policy.json</span></span>' +
      '<span class="px-1.5 py-0.5 rounded bg-surface-container text-outline text-[10px]">read-only-mirror</span>' +
      '</div>' +
      '<div class="flex items-center gap-2.5 shrink-0"><span class="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-container-low text-[11px]"><span class="material-symbols-outlined text-[13px] text-outline">folder</span><span class="font-mono text-on-surface">payments-api</span></span>' +
      // panel toggles, the admin-sources pair: collapse the left rail, collapse the right panel
      '<div class="flex items-center rounded bg-surface-container-low border border-surface-container-high/60 p-0.5 gap-0.5">' +
      '<button class="p-1 rounded hover:bg-surface-container transition-colors flex items-center justify-center cursor-pointer text-primary" data-toggle-panel="nav-rail" type="button" title="Hide or show the left panel" aria-label="Toggle left panel" aria-pressed="true"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><rect height="18" rx="2" width="18" x="3" y="3"></rect><line x1="9" x2="9" y1="3" y2="21"></line><polyline points="13 9 16 12 13 15"></polyline></svg></button>' +
      '<button class="p-1 rounded hover:bg-surface-container transition-colors flex items-center justify-center cursor-pointer text-primary" data-toggle-panel="inspector-rail" type="button" title="Hide or show the right panel" aria-label="Toggle right panel" aria-pressed="true"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><rect height="18" rx="2" width="18" x="3" y="3"></rect><line x1="15" x2="15" y1="3" y2="21"></line><polyline points="11 9 8 12 11 15"></polyline></svg></button>' +
      '</div></div>' +
      '</div>'
    );
  }

  // two popovers: where the policy came from, and the AI tools picker; a click outside closes them
  function popover(btn, pop) {
    document.addEventListener("click", function (e) {
      var p = document.querySelector(pop); if (!p) return;
      if (e.target.closest(btn)) { p.classList.toggle("hidden"); return; }
      if (!e.target.closest(pop)) p.classList.add("hidden");
    });
  }
  popover("[data-source-chip]", "[data-source-pop]");
  // panel toggles: hide or show the page's left rail (#nav-rail) and right panel (#inspector-rail); a page without one gets no button
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-toggle-panel]"); if (!b) return;
    var p = document.getElementById(b.dataset.togglePanel); if (!p) return;
    var shown = p.classList.toggle("hidden") === false;
    b.classList.toggle("text-primary", shown); b.classList.toggle("text-on-surface-variant", !shown); b.setAttribute("aria-pressed", String(shown));
  });
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-toggle-panel]").forEach(function (b) { if (!document.getElementById(b.dataset.togglePanel)) b.remove(); });
  });
  popover("[data-tools-btn]", "[data-tools-pop]");
  document.addEventListener("change", function (e) {
    if (!e.target.matches("[data-tool]")) return;
    var all = document.querySelectorAll("[data-tool]"), on = document.querySelectorAll("[data-tool]:checked");
    var c = document.querySelector("[data-tools-count]"); if (c) c.textContent = on.length + " of " + all.length;
  });

  return { top: top, source: key, lookup: lookup, files: files };
})();
