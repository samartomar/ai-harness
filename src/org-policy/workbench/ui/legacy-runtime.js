/** Recovered statically from the last successful generated Workbench browser bundle. */
import { decisionProblems, stableDecisionJson } from "./decision-json.js";
import { mountProtectedPolicyWorkbench } from "../../studio-protected-authority-runtime.js";
import { mountGenericWorkspaceShell } from "./workspace-shell.js";
import { parseNativeStrictJsonObjectV1 } from "../../../contract/native-strict-json-object-v1.js";
import { policySchemaErrors } from "../schema-validation.js";
import {
  activeManagedMcpServers,
  deploymentReadinessBlockers,
  governanceGrammarErrors,
  governanceOrDefault,
  governanceTextErrors,
  kiroRemoteMcpErrors,
  preparePolicyImport as prepareGrammarPolicyImport,
  reconcileManagedMcpProjection,
  registryOriginErrors,
  serializePolicy,
  validatePolicy,
} from "./shell/policy-grammar.js";
const xs = stableDecisionJson;
const Wv = decisionProblems;
const Hv = mountProtectedPolicyWorkbench;

export function mountLegacyWorkbench(t) {
  let r = {
      policy: structuredClone(t.initialPolicy),
      receipt: null,
      decision: null,
      managedMcpOptIn: Boolean(
        t.initialPolicy &&
          t.initialPolicy.mcp &&
          t.initialPolicy.mcp.allowManagedOnly === !0,
      ),
    },
    n = 0,
    o = function (s) {
      return document.getElementById(s);
    },
    e = function (s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c];
      });
    },
    i = xs,
    a = function (s) {
      return Wv(s, t.decisionSchema, ie);
    },
    u = 0,
    g = function (s, c) {
      let l = "tooltip-" + ++u;
      return (
        '<span class="tip-wrap"><button type="button" class="help-button" aria-label="About ' +
        e(s) +
        '" aria-describedby="' +
        l +
        '" aria-expanded="false" data-tooltip-button="' +
        l +
        '">?</button><span id="' +
        l +
        '" class="tooltip" role="tooltip" data-open="false">' +
        e(c) +
        "</span></span>"
      );
    },
    p = function (s, c) {
      let l = o("announcement");
      ((l.textContent = s),
        (l.className = "announce" + (c ? " error" : "")),
        (o("status").textContent = s));
    },
    x = function (s, c) {
      let l = o(s);
      if (!l) return;
      let d = s + "-error",
        f = o(d);
      if (!f) {
        ((f = document.createElement("span")),
          (f.id = d),
          (f.className = "field-error"));
        let v = l.closest("label") || l.parentElement;
        if (v) v.append(f);
        else return;
      }
      ((f.textContent = c),
        c ? l.setAttribute("aria-invalid", "true") : l.removeAttribute("aria-invalid"),
        c
          ? l.setAttribute("aria-describedby", d)
          : l.removeAttribute("aria-describedby"));
    },
    j = function () {
      return governanceOrDefault(r.policy.governance);
    },
    b = function () {
      return ((r.policy.governance = j()), r.policy.governance);
    },
    R = function () {
      return serializePolicy(r.policy);
    },
    grammar = {
      model: t,
      selectionValidator: function () {
        return window.__aihWorkbenchValidatePolicy;
      },
    },
    ie = policySchemaErrors,
    Pe = kiroRemoteMcpErrors,
    nt = function (s) {
      return governanceGrammarErrors(s, t);
    },
    et = registryOriginErrors,
    ot = governanceTextErrors,
    validateCurrentPolicy = function () {
      return validatePolicy(r.policy, grammar);
    },
    Ke = activeManagedMcpServers,
    preparePolicyImport = function (s, c) {
      return prepareGrammarPolicyImport(s, c, grammar);
    },
    Ye = function () {
      reconcileManagedMcpProjection(r.policy, r.managedMcpOptIn);
    },
    commitPolicy = function (s, c) {
      Ye();
      let l = validateCurrentPolicy();
      return l.length
        ? ((r.policy = s),
          p("Policy change rejected: " + l.slice(0, 3).join("; "), !0),
          Xe(),
          !1)
        : (p(c),
          Xe(),
          window.dispatchEvent(new Event("aih-workbench-policy-change")),
          !0);
    },
    m = function (s) {
      if (s.kind === "mcp" && s.source && s.source.type === "stdio")
        return ["Blocked - evidence owed at this pin", "blocked"];
      let c = j().activations.find(function (l) {
        return l.candidate === s.id;
      });
      return c && c.state === "active"
        ? ["Requested intent - runtime evaluation required", "requested"]
        : ["Disabled", "pending"];
    },
    I = function (s, c) {
      return s === "requested"
        ? "Selected"
        : s === "blocked"
          ? "Blocked"
          : s === "approval"
            ? "Approval"
            : s === "pending"
              ? c.indexOf("Disabled") === 0
                ? "Disabled"
                : "Awaiting"
              : s === "external" && c.indexOf("Selectable") === 0
                ? "Selectable"
                : "External";
    },
    ee = function (s) {
      let c = String(s).indexOf(":");
      return c === -1
        ? e(s)
        : "<u>" +
            e(String(s).slice(0, c + 1)) +
            "</u>" +
            e(String(s).slice(c + 1));
    },
    pe = function (s) {
      if (!s || s.verdict !== "blocked") return "";
      let c = s.findings[0],
        l = s.findings.reduce(function (d, f) {
          return d + (typeof f.count == "number" ? f.count : 0);
        }, 0);
      return (
        '<span class="vet" data-vet="blocked" title="' +
        e(c ? c.detail : "") +
        '">' +
        e(c ? c.code : "blocked") +
        (l > 1 ? "&#183;" + l : "") +
        "</span>"
      );
    },
    ft = function (s, c, l, d, f, v, w, y, k, _) {
      let S = w || s,
        F = I(d, l),
        T =
          ["Selected", "Selectable", "Disabled", "Available"].indexOf(F) !== -1
            ? ""
            : '<span class="row-state" title="' + e(l) + '">' + e(F) + "</span>";
      return (
        '<div class="row' +
        (d === "requested" ? " on" : "") +
        '" data-state="' +
        e(d) +
        '"' +
        (y ? ' data-vetted="' + e(y.verdict) + '"' : "") +
        ' data-row="' +
        e(s) +
        '"' +
        (k || "") +
        ">" +
        (f || '<span class="tick" aria-hidden="true"></span>') +
        "<strong>" +
        ee(S) +
        "</strong>" +
        (_ ? '<span class="source-mark">' + e(_) + "</span>" : "") +
        pe(y) +
        T +
        '<span class="badge ' +
        d +
        '">' +
        e(l) +
        "</span>" +
        (v ? '<p class="mono sr">' + e(v) + "</p>" : "") +
        '<span class="sr">' +
        e(c) +
        '</span><div class="row-slot"></div></div>'
      );
    },
    no = function (s, c) {
      return (
        c.id +
        " has no projector for the organization-sanctioned CLI set " +
        s.supportedClis.join(", ") +
        "; control projector targets: " +
        c.targets.join(", ")
      );
    },
    ri = function (s) {
      if (!Array.isArray(s.supportedClis)) return null;
      for (let c of s.activations) {
        let l = s.catalog.reviewed.find(function (f) {
          return f.id === c.candidate;
        });
        if (!l) continue;
        let d = l.targets.filter(function (f) {
          return s.supportedClis.includes(f);
        });
        if (!d.length) return no(s, l);
        c.targets = d;
      }
      return null;
    },
    $f = function (s) {
      let c = s.source || {};
      return (
        "Next: save this policy as aih-org-policy.json in the target repository, then run aih trust scan " +
        c.package +
        "@" +
        c.version +
        ". Integrity: " +
        c.integrity +
        ". AIH fetches and scans that pinned npm tarball and emits preflight evidence record " +
        s.evidence.record +
        " bound to candidate " +
        s.id +
        ". The current fence is mandatory-detector-failed; it remains blocked until an independently attested authority receipt carries that exact record."
      );
    },
    iy = function () {
      return '<div class="governance-info"><div class="cap">Hook registration information</div><p class="note">Only AIH-owned governance and telemetry identities are authorable here. Custom hooks are not supported. AIH records the supported hook policy fields; each named owner remains the executor. This Workbench does not install, run, inspect, or register custom hooks.</p><p class="help">Hook entry, overlap, and process-spawn inventories are intentionally not embedded in the portable form model. Core preparation is required to evaluate an exact target repository.</p></div>';
    },
    oy = function () {
      let s = j();
      ((o("custom-rows").innerHTML = s.catalog.custom.length
        ? s.catalog.custom
            .map(function (c) {
              let l = m(c),
                d =
                  c.source && c.source.type === "remote" ? "remote" : "custom",
                f =
                  d === "remote" &&
                  !Object.prototype.hasOwnProperty.call(c.source, "administrativeStatus")
                    ? '<span class="row-actions"><button type="button" data-workbench-action="readonly" data-workbench-kind="remote" data-workbench-id="' +
                      e(c.id) +
                      '">View preserved remote</button></span>'
                    : '<span class="row-actions"><button type="button" data-workbench-action="edit" data-workbench-kind="' +
                      e(d) +
                      '" data-workbench-id="' +
                      e(c.id) +
                      '">Edit</button><button type="button" data-workbench-action="remove" data-workbench-kind="' +
                      e(d) +
                      '" data-workbench-id="' +
                      e(c.id) +
                      '">Remove</button></span>',
                v =
                  d === "remote"
                    ? !Object.prototype.hasOwnProperty.call(c.source, "administrativeStatus")
                      ? "Remote origin: " +
                        c.source.origin +
                        " · Preserved remote declaration, read-only · Content scan: none"
                      : "Remote origin: " +
                        c.source.origin +
                        " · Administrative status: " +
                        c.source.administrativeStatus +
                        " · Content scan: none · Accountable owner: " +
                        (c.source.approval && c.source.approval.approvedBy
                          ? c.source.approval.approvedBy
                          : "unrecorded")
                    : $f(c) + " Accountable owner: " + c.accountableOwner;
              return ft(
                c.id,
                "Pinned custom source - no activation affordance",
                l[0],
                l[1],
                f,
                v,
              );
            })
            .join("")
        : '<p class="help">No custom candidates.</p>'),
        (o("curation-rows").innerHTML = s.externalCuration.length
          ? s.externalCuration
              .flatMap(function (c) {
                return c.items.map(function (l) {
                  return ft(
                    c.framework + ": " + l.kind + " / " + l.id,
                    "Repository: " +
                      l.source.repository +
                      " · Commit: " +
                      l.source.commit +
                      " · Path: " +
                      l.source.path +
                      " · Audit record: " +
                      l.audit.record +
                      " · Audit digest: " +
                      l.audit.digest +
                      " · Clarification: " +
                      (l.clarification || "none") +
                      " · report-only",
                    "External guidance - not enforced",
                    "external",
                    '<span class="row-actions"><button type="button" data-workbench-action="edit" data-workbench-kind="curation" data-workbench-id="' +
                      e(l.id) +
                      '" data-workbench-framework="' +
                      e(c.framework) +
                      '" data-workbench-curation-kind="' +
                      e(l.kind) +
                      '">Edit</button><button type="button" data-workbench-action="remove" data-workbench-kind="curation" data-workbench-id="' +
                      e(l.id) +
                      '" data-workbench-framework="' +
                      e(c.framework) +
                      '" data-workbench-curation-kind="' +
                      e(l.kind) +
                      '">Remove</button></span>',
                  );
                });
              })
              .join("")
          : '<p class="help">No external curation intent.</p>'));
    },
    sy = function () {
      let s = t.catalog.externalMcp || [],
        c = j(),
        l = Array.isArray(c.eccMcpApprovals) ? c.eccMcpApprovals : [],
        d = o("ecc-mcp-id"),
        f = d.value;
      ((d.innerHTML =
        '<option value="">Choose pinned ECC MCP</option>' +
        s
          .map(function (v) {
            return (
              '<option value="' +
              e(v.id) +
              '">' +
              e(v.id + " \u2014 " + v.addability) +
              "</option>"
            );
          })
          .join("")),
        (d.value = s.some(function (v) {
          return v.id === f;
        })
          ? f
          : ""),
        (o("ecc-mcp-approval-rows").innerHTML = l.length
          ? l
              .map(function (v) {
                return (
                  '<p class="help"><code>' +
                  e(v.id) +
                  "</code> \u2014 " +
                  e(v.state) +
                  "; " +
                  e(v.authenticationMode) +
                  '. <button type="button" class="btn sm" data-ecc-mcp-approval-remove="' +
                  e(v.id) +
                  '">Remove approval</button></p>'
                );
              })
              .join("")
          : '<p class="help">No ECC MCP approvals recorded.</p>'));
    },
    cy = function (s) {
      return s.kind === "workbench-row"
        ? "Existing Workbench row: " + s.candidate
        : s.kind === "ecc-mcp-approval"
          ? "ECC MCP approval for " +
            s.id +
            ", then configure its " +
            s.addability +
            " entry"
          : s.kind === "aih-ecc-profile-lifecycle"
            ? "AIH ECC profile lifecycle: " + s.command
            : "No route";
    },
    uy = function () {
      let s = t.adoptionRecipe;
      o("adoption-recipe-roles").innerHTML = s.roles
        .map(function (c) {
          let l =
            c.usage.kind === "mcp-server-event"
              ? "MCP server event: " + c.usage.serverId
              : "none captured";
          return (
            '<article class="adoption-role" data-adoption-role="' +
            e(c.id) +
            '"><strong>' +
            e(c.label) +
            "</strong><p>" +
            e(c.guidance) +
            '</p><p class="adoption-route"><b>Prerequisites:</b> ' +
            e(c.prerequisites.join("; ")) +
            '</p><p class="adoption-route"><b>Overlap / conflict:</b> ' +
            e(c.conflicts.join("; ")) +
            '</p><p class="adoption-route"><b>Next action:</b> ' +
            e(cy(c.route)) +
            '</p><p class="adoption-route"><b>Usage / coverage:</b> ' +
            e(l) +
            "</p></article>"
          );
        })
        .join("");
    },
    ly = function () {
      let s = r.receipt,
        c = [];
      (s &&
        Array.isArray(s.approvals) &&
        s.approvals.forEach(function (l) {
          c.push(
            ft(
              l.id || "approval",
              (l.issuer || "unknown issuer") +
                " \u2014 preserved/preflight-only",
              "Not verified / not effective",
              "pending",
            ),
          );
        }),
        s &&
          Array.isArray(s.evidence) &&
          s.evidence.forEach(function (l) {
            c.push(
              ft(
                l.id || "evidence",
                (l.state || "unknown") +
                  " evidence \u2014 preserved/preflight-only",
                "Not verified / not effective",
                "pending",
              ),
            );
          }),
        (o("approval-rows").innerHTML = c.length
          ? c.join("") +
            '<details class="receipt-details"><summary>Preserved receipt details</summary><p class="help">preserved/preflight-only; not verified or effective.</p><pre class="mono">' +
            e(JSON.stringify(s, null, 2)) +
            "</pre></details>"
          : '<p class="help">Import an authority receipt to preserve and inspect its subjects; target-repository verification decides authority.</p>'),
        (o("receipt-state").textContent = s
          ? "Receipt preserved for preflight only; this browser does not verify it or create effective approval."
          : "No authority receipt imported."),
        (o("copy-approvals").disabled = !0));
    },
    zs = function () {
      let s = r.decision;
      if (!s) {
        ((o("decision-state").textContent = "No standalone decision imported."),
          (o("decision-rows").textContent = ""),
          (o("decision-export").textContent = ""),
          (o("download-decision").disabled = !0));
        return;
      }
      ((o("decision-state").textContent =
        "Decision imported for inspection only: unverified and not effective. It does not change policy, receipt, or authority state."),
        (o("decision-rows").textContent = [
          "id: " + s.id,
          "candidate: " + s.candidate,
          "kind: " + s.kind,
          "disposition: " + s.disposition,
          "targets: " + s.targets.join(","),
          "effects: " + s.effects.join(","),
          "issuer: " + s.issuer,
          "actor: " + s.actor,
          "policyVersion: " + s.policyVersion,
          "issuedAt: " + s.issuedAt,
          "notBefore: " + s.notBefore,
          "expiresAt: " + s.expiresAt,
          "reviewBy: " + (s.reviewBy || "none"),
          "acceptedFindings: " + s.acceptedFindings.join(","),
          "acceptedGaps: " + s.acceptedGaps.join(","),
          "conditions: " + s.conditions.join(" | "),
          "reason: " + s.reason,
        ].join(`
`)),
        (o("decision-export").textContent = i(s)),
        (o("download-decision").disabled = !1));
    },
    py = function () {
      let s = t.catalog.eccHookControls,
        c = j().eccHookControls || {},
        l = c.profile || "",
        d = Array.isArray(c.disabledIds) ? c.disabledIds : [],
        f = o("ecc-hook-controls");
      if (!f) return;
      let v = Array.from(f.querySelectorAll("details[data-ecc-hook-group]")),
        w = v.length > 0,
        y = new Set(
          v
            .filter(function (O) {
              return O.open;
            })
            .map(function (O) {
              return O.getAttribute("data-ecc-hook-group");
            }),
        ),
        k = s.profiles
          .map(function (O) {
            return (
              '<label><input type="radio" name="ecc-hook-profile" value="' +
              e(O.id) +
              '" data-ecc-hook-profile="' +
              e(O.id) +
              '"' +
              (l === O.id ? " checked" : "") +
              "> " +
              e(O.label) +
              "</label>"
            );
          })
          .join(" "),
        _ = function (O) {
          let se = !!l && O.profiles.indexOf(l) !== -1,
            H = O.disableEligible && se,
            ve = d.indexOf(O.id) !== -1,
            qe = O.disableEligible
              ? '<button type="button" class="btn sm" data-ecc-hook-disable="' +
                e(O.id) +
                '"' +
                (H ? "" : " disabled") +
                ">" +
                e(ve ? "Re-enable" : "Disable") +
                "</button>"
              : '<span class="help">Required wrapper; no individual disabled setting.</span>';
          return (
            '<div class="hookreg" data-ecc-hook-id="' +
            e(O.id) +
            '"><p><b>' +
            e(O.id) +
            "</b> &mdash; " +
            e(O.event) +
            '</p><p class="help">Eligible profiles: ' +
            e(O.profiles.join(", ")) +
            ". " +
            (O.disableEligible ? "" : "This wrapper remains enabled.") +
            "</p>" +
            qe +
            "</div>"
          );
        },
        S = new Set([
          "pre:bash:block-no-verify",
          "pre:config-protection",
          "pre:edit-write:gateguard-fact-force",
          "post:quality-gate",
        ]),
        F = [
          {
            id: "pre-tool-guardrails",
            label: "Pre-tool Guardrails",
            description:
              "Critical controls that prevent unverified Bash execution or accidental overwrites of baseline configuration.",
            ids: ["pre:bash:block-no-verify", "pre:config-protection"],
          },
          {
            id: "gate-checks",
            label: "Gate Checks",
            description:
              "Validation gates before high-risk edits and after code changes.",
            ids: ["pre:edit-write:gateguard-fact-force", "post:quality-gate"],
          },
          {
            id: "additional-pre-tool",
            label: "Additional Pre-tool Controls",
            description:
              "Other pinned PreToolUse controls from ECC's exact inventory.",
            select: function (O) {
              return O.event === "PreToolUse" && !S.has(O.id);
            },
          },
          {
            id: "session-lifecycle",
            label: "Session & Lifecycle",
            description:
              "Pinned session-start, compaction, stop, and session-end lifecycle controls.",
            select: function (O) {
              return (
                ["SessionStart", "PreCompact", "Stop", "SessionEnd"].indexOf(
                  O.event,
                ) !== -1
              );
            },
          },
          {
            id: "post-tool-feedback",
            label: "Post-tool Observability & Feedback",
            description:
              "Remaining pinned PostToolUse and PostToolUseFailure observations, audit signals, and feedback controls.",
            select: function (O) {
              return (
                ["PostToolUse", "PostToolUseFailure"].indexOf(O.event) !== -1 &&
                !S.has(O.id)
              );
            },
          },
        ],
        T = 0,
        ne = F.map(function (O, se) {
          let H = O.ids
              ? O.ids
                  .map(function (qe) {
                    return s.hooks.find(function (tt) {
                      return tt.id === qe;
                    });
                  })
                  .filter(Boolean)
              : s.hooks.filter(O.select),
            ve = w ? y.has(O.id) : se < 2;
          return (
            (T += H.length),
            '<details class="ecc-hook-group" data-ecc-hook-group="' +
              e(O.id) +
              '"' +
              (ve ? " open" : "") +
              "><summary><span data-ecc-hook-group-label>" +
              e(O.label) +
              "</span><b data-ecc-hook-group-count>" +
              H.length +
              '</b></summary><p class="help">' +
              e(O.description) +
              "</p>" +
              H.map(_).join("") +
              "</details>"
          );
        }).join("");
      if (T !== s.hooks.length)
        throw new Error(
          "ECC hook grouping must render every pinned hook exactly once",
        );
      f.innerHTML =
        '<p class="help">ECC executes hooks; AIH configures the supported profile and disabled-hook list through receipt-owned Claude <code>settings.json</code> environment keys. Disabling affects ECC execution after process spawn; it is not AIH enforcement.</p><fieldset><legend>Profile</legend>' +
        k +
        '</fieldset><p class="help">' +
        e(s.disabledHooks.detail) +
        "</p>" +
        ne;
    },
    renderPolicyPreview = function () {
      let selection =
          r.policy &&
          r.policy.authoringSelections &&
          typeof r.policy.authoringSelections === "object"
            ? r.policy.authoringSelections
            : {},
        roots = Array.isArray(selection.roots) ? selection.roots.length : 0,
        requests = Array.isArray(selection.requests) ? selection.requests.length : 0,
        exclusions = Array.isArray(selection.exclusions) ? selection.exclusions.length : 0,
        drafts = Array.isArray(selection.drafts) ? selection.drafts.length : 0;
      (o("config-preview").value = R(),
        (o("report-preview").value = [
          "Policy Workbench preview",
          "",
          "Generic authoring state is represented by prepared catalog identities.",
          "Direct roots: " + roots,
          "Requests: " + requests,
          "Exclusions: " + exclusions,
          "Local drafts: " + drafts,
          "",
          "Effective: not evaluated - choose a target repository for Core evaluation.",
        ].join("\n")));
    },
    Es = function () {
      let s = o("curation-framework"),
        c = s.value,
        l = Array.isArray(t.catalog.frameworks) ? t.catalog.frameworks : [];
      ((s.innerHTML = l.map(function (d) {
        return '<option value="' + d.id + '">' + d.id.toUpperCase() + " - external guidance</option>";
      }).join("")),
        (s.value = c || (l[0] ? l[0].id : "")),
        (o("curation-asset").innerHTML = '<option value="">Manual item</option>'));
    };

  let yo = o("drawer"),
    js = o("scrim"),
    Df = o("authoring-sidebar"),
    Cs = o("authoring-scrim"),
    Tf = o("ecc-mcp-sidebar"),
    Ps = o("ecc-mcp-scrim"),
    Ey = function (s) {
      let c = o("drawer-detail"),
        l =
          '<button type="button" class="x" data-drawer-close aria-label="Close details">&#10005;</button>';
      if (s === "AIH Governance & Telemetry Hooks information") {
        c.innerHTML =
          '<div class="dhead"><h2>AIH Governance &amp; Telemetry Hooks</h2>' +
          l +
          '</div><div class="badges"><span class="b">AIH registers</span><span class="b ext">Owners vary</span></div>' +
          iy();
        return;
      }
      c.innerHTML = '<div class="dhead"><h2>' + e(s) + "</h2>" + l + "</div>";
    },
    un = function () {
      (Cs.classList.remove("open"), (Df.hidden = !0));
    },
    jy = function (s) {
      return s === "custom"
        ? "Add organization MCP"
        : s === "remote-custom"
          ? "Add remote custom MCP"
          : "Add framework curation";
    },
    Cy = function () {
      ((o("curation-kind").disabled = !1),
        (o("curation-editor").querySelector("summary").textContent =
          "Add framework curation"),
        (o("curation-purpose").textContent =
          "Add audited ECC or Superpowers guidance. This is framework curation, not an organization-owned source and not MCP. AIH records report-only policy intent and does not install, run, or enforce the source."),
        (o("curation-framework-label").textContent =
          "External framework owner"),
        (o("add-curation").textContent = "Add framework curation"));
    },
    Uf = function (s, c) {
      (Nr(),
        dn(),
        (Df.hidden = !1),
        Cs.classList.add("open"),
        Array.from(o("authoring-forms").children).forEach(function (d) {
          let f = d.id === s + "-editor";
          ((d.hidden = !f), d.tagName === "DETAILS" && (d.open = f));
        }),
        s === "curation" && Cy(),
        (o("authoring-title").textContent = c || jy(s)));
      let l = o(
        s === "curation"
          ? "curation-id"
          : s === "remote-custom"
            ? "remote-custom-id"
            : "custom-id",
      );
      l && l.focus();
    };
  (Cs.addEventListener("click", un),
    o("authoring-close").addEventListener("click", un));
  let Ds = function (s) {
      (un(),
        dn(),
        (yo.hidden = !1),
        js.classList.add("open"),
        Ey(s),
        (yo.dataset.item = s));
    },
    Nr = function () {
      (js.classList.remove("open"), (yo.hidden = !0), delete yo.dataset.item);
    };
  js.addEventListener("click", Nr);
  let Rf = function () {
      (Nr(),
        un(),
        (Tf.hidden = !1),
        Ps.classList.add("open"),
        o("ecc-mcp-id").focus());
    },
    dn = function () {
      (Ps.classList.remove("open"), (Tf.hidden = !0));
    };
  (Ps.addEventListener("click", dn),
    o("ecc-mcp-close").addEventListener("click", dn));
  let Py = function (s) {
    t.catalog.externalMcp.some(function (c) {
      return c.id === s;
    }) &&
      (Rf(),
      (o("ecc-mcp-id").value = s),
      p(
        "ECC MCP " +
          s +
          " selected for approval authoring only; it is not installed or contacted.",
      ));
  };
  (document.addEventListener("click", function (s) {
    let c = s.target.closest && s.target.closest("[data-ecc-mcp-approval]");
    c && Py(c.getAttribute("data-ecc-mcp-approval"));
  }),
    document.addEventListener("click", function (s) {
      let c = s.target.closest && s.target.closest("[data-detail]");
      if (c) {
        Ds(c.getAttribute("data-detail"));
        return;
      }
      if (s.target.closest && s.target.closest("[data-drawer-close]")) {
        Nr();
        return;
      }
      let l = s.target.closest && s.target.closest("[data-open-authoring]");
      if (l) {
        Uf(l.getAttribute("data-open-authoring"));
        return;
      }

    }),
    document.addEventListener("click", function (s) {
      let c = s.target.closest && s.target.closest("[data-copy]");
      c &&
        (navigator.clipboard &&
          navigator.clipboard.writeText(c.getAttribute("data-copy")),
        (c.textContent = "COPIED"),
        setTimeout(function () {
          c.textContent = "COPY";
        }, 1400));
    }),
    document.addEventListener("click", function (s) {
      let c = s.target.closest && s.target.closest("#theme-toggle");
      if (c) {
        let l = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        ((document.documentElement.dataset.theme = l),
          c.setAttribute(
            "aria-label",
            "Switch to " + (l === "dark" ? "light" : "dark") + " theme",
          ),
          c.setAttribute("title", c.getAttribute("aria-label")));
      }
    }));
  let Nf = o("sheet"),
    Oy = function () {
      Nf.classList.add("open");
    },
    Lf = function () {
      Nf.classList.remove("open");
    };
  document.addEventListener("click", function (s) {
    if (s.target.closest) {
      if (s.target.closest("#sheet-close")) {
        Lf();
        return;
      }
      s.target.closest("#export") && Oy();
    }
  });
  let Dy = function (s) {
    let l = { skill: "Skill", agent: "Agent", mcp: "MCP server" }[s];
    if (!l) return;
    (un(),
      Nr(),
      dn(),
      (document.body.dataset.view = "author"),
      document.querySelectorAll("[data-view-tab]").forEach(function (f) {
        f.setAttribute(
          "aria-pressed",
          f.dataset.viewTab === "author" ? "true" : "false",
        );
      }),
      (o("protected-kind").value = s),
      (o("organization-artifact-context").textContent =
        "Adding an organization-owned " +
        l +
        ". Catalog-independent route: obtain attributable scan evidence for this exact source, then add its approval and download the protected policy file. Core can observe the existing files and durable lifecycle; it does not install or run the " +
        l +
        ". The accountable owner email identifies the human responsible for this decision."),
      typeof window.__aihPolicyWorkbenchProtectedScanGuide == "function" &&
        window.__aihPolicyWorkbenchProtectedScanGuide());
    let d = o("protected-form").closest("[data-groupcard]");
    if (d) {
      d.dataset.open = "1";
      let f = d.querySelector("[data-group]");
      (f && f.setAttribute("aria-expanded", "true"),
        d.scrollIntoView && d.scrollIntoView({ block: "start" }));
    }
    (o("protected-subject-id").focus(),
      p(
        "Organization-owned " +
          l +
          " selected. Add exact source and scan evidence in the protected policy form; this is separate from ECC/Superpowers curation.",
      ));
  };
  (o("open-protected-mcp").addEventListener("click", function () {
    Dy("mcp");
  }),
    o("open-ecc-mcp").addEventListener("click", Rf));
  let Vf = function (s, c) {
    let l = t.catalog.eccHookControls,
      d = new Set(Array.isArray(c) ? c : []);
    return l.disabledHooks.eligibleIds.filter(function (f) {
      let v = l.hooks.find(function (w) {
        return w.id === f;
      });
      return d.has(f) && v && v.profiles.indexOf(s) !== -1;
    });
  };
  document.addEventListener("click", function (s) {
    let c = s.target.closest && s.target.closest("[data-ecc-hook-profile]");
    if (c) {
      let F = c.getAttribute("data-ecc-hook-profile");
      if (
        !t.catalog.eccHookControls.profiles.some(function (H) {
          return H.id === F;
        })
      )
        return;
      let T = structuredClone(r.policy),
        ne = b(),
        O =
          ne.eccHookControls && Array.isArray(ne.eccHookControls.disabledIds)
            ? ne.eccHookControls.disabledIds
            : [],
        se = Vf(F, O);
      ((ne.eccHookControls = Object.assign(
        { profile: F },
        se.length ? { disabledIds: se } : {},
      )),
        commitPolicy(
          T,
          "ECC hook profile set to " +
            F +
            ". AIH records supported Claude environment intent; ECC executes the hooks.",
        ));
      return;
    }
    let l = s.target.closest && s.target.closest("[data-ecc-hook-disable]");
    if (!l || l.disabled) return;
    let d = l.getAttribute("data-ecc-hook-disable"),
      f = j().eccHookControls;
    if (!f || !f.profile) return;
    let v = t.catalog.eccHookControls.hooks.find(function (F) {
      return F.id === d;
    });
    if (!v || !v.disableEligible || v.profiles.indexOf(f.profile) === -1)
      return;
    let w = structuredClone(r.policy),
      y = b(),
      k = Array.isArray(y.eccHookControls && y.eccHookControls.disabledIds)
        ? y.eccHookControls.disabledIds
        : [],
      _ =
        k.indexOf(d) === -1
          ? k.concat([d])
          : k.filter(function (F) {
              return F !== d;
            }),
      S = Vf(f.profile, _);
    ((y.eccHookControls = Object.assign(
      { profile: f.profile },
      S.length ? { disabledIds: S } : {},
    )),
      commitPolicy(
        w,
        (k.indexOf(d) === -1 ? "Disabled " : "Re-enabled ") +
          d +
          " for ECC's " +
          f.profile +
          " profile. ECC applies this after process spawn; it is not AIH enforcement.",
      ));
  });
  let Xe = function () {
    let c = o("posture"), l = o("managed-mcp-projection");
    (c && (c.value = r.policy.minimumPosture || "vibe"),
      l && (l.checked = r.managedMcpOptIn),
      Es(),
      uy(),
      oy(),
      py(),
      sy(),
      Jf(),
      Qf(),
      (o("dispositionable-findings").textContent =
        t.findings.dispositionable.join(" | ")),
      (o("hard-blockers").textContent = t.findings.fenced.join(" | ")),
      renderPolicyPreview(),
      typeof window.__aihPolicyWorkbenchEnhanceRows == "function" &&
        window.__aihPolicyWorkbenchEnhanceRows());
  };
  o("posture").addEventListener("change", function (s) {
    let c = s.target.value,
      l =
        r.policy.governance && Array.isArray(r.policy.governance.supportedClis)
          ? r.policy.governance.supportedClis
          : [];
    if (c === "enterprise" && !l.length) {
      (p(
        "Enterprise posture was not applied. Select at least one Allowed CLI first, or choose the Enterprise preset to explicitly sanction every supported CLI and compose Core.",
        !0,
      ),
        Xe());
      return;
    }
    let d = structuredClone(r.policy);
    ((r.policy.minimumPosture = c),
      commitPolicy(d, "Posture changed without modifying selections."));
  });
  o("managed-mcp-projection").addEventListener("change", function (s) {
    let c = Boolean(s.target.checked), l = r.managedMcpOptIn;
    if (!c && Ke(r.policy).length) {
      (p(
        "Managed MCP projection remains enabled because selected Core MCP controls need it. Remove those controls before disabling this setting.",
        !0,
      ),
        Xe());
      return;
    }
    r.managedMcpOptIn = c;
    let d = structuredClone(r.policy);
    commitPolicy(
      d,
      c
        ? "Managed MCP projection enabled for selected Core MCP controls. It is saved only when those controls are present."
        : "Managed MCP projection disabled. No server was contacted or changed.",
    ) || (r.managedMcpOptIn = l);
  });
  let ui = function () {
      (document
        .querySelectorAll(".tooltip[data-open='true']")
        .forEach(function (s) {
          s.setAttribute("data-open", "false");
        }),
        document
          .querySelectorAll("[data-tooltip-button][aria-expanded='true']")
          .forEach(function (s) {
            s.setAttribute("aria-expanded", "false");
          }));
    },
    Ts = function (s) {
      (ui(),
        s.setAttribute("aria-expanded", "true"),
        s.removeAttribute("data-tooltip-dismissed"));
      let c = o(s.getAttribute("data-tooltip-button"));
      if (c) {
        let l = s.getBoundingClientRect(),
          d = Math.min(368, Math.max(24, window.innerWidth - 32));
        ((c.style.width = d + "px"),
          (c.style.left =
            Math.max(16, Math.min(l.left, window.innerWidth - 16 - d)) + "px"),
          (c.style.top = Math.max(16, l.bottom + 4) + "px"),
          c.setAttribute("data-open", "true"));
      }
    };
  (document.addEventListener("focusin", function (s) {
    let c = s.target.closest && s.target.closest("[data-tooltip-button]");
    c && !c.hasAttribute("data-tooltip-dismissed") && Ts(c);
  }),
    document.addEventListener("focusout", function (s) {
      let c = s.target.closest && s.target.closest("[data-tooltip-button]");
      c && (c.removeAttribute("data-tooltip-dismissed"), ui());
    }),
    document.addEventListener("pointerover", function (s) {
      let c = s.target.closest && s.target.closest(".tip-wrap");
      if (c) {
        let l = c.querySelector("[data-tooltip-button]");
        l && Ts(l);
      }
    }),
    document.addEventListener("pointerout", function (s) {
      let c = s.target.closest && s.target.closest(".tip-wrap");
      c && !c.contains(s.relatedTarget) && ui();
    }),
    document.addEventListener("click", function (s) {
      let c = s.target.closest("[data-tooltip-button]");
      if (c) {
        Ts(c);
        return;
      }
      ui();
    }),
    document.addEventListener("keydown", function (s) {
      if (s.key === "Escape") {
        let c = document.activeElement;
        (ui(),
          c &&
            c.matches("[data-tooltip-button]") &&
            (c.setAttribute("data-tooltip-dismissed", "true"), c.focus()));
      }
    }),
    o("curation-framework").addEventListener("change", function () {
      Es();
    }));
  ["curation-id", "curation-owner"].forEach(function (s) {
    o(s).addEventListener("input", function () {
      o("curation-id").value.trim() && o("curation-owner").value.trim() && x("curation-id", "");
    });
  });
  o("cancel-curation-edit").addEventListener("click", function () {
    ((r.editing = null),
      (o("curation-framework").disabled = !1),
      (o("cancel-curation-edit").hidden = !0),
      Cy());
  });
  o("add-curation").addEventListener("click", function () {
      let s = o("curation-framework").value,
        c = o("curation-kind").value,
        l = o("curation-id").value.trim(),
        d = o("curation-repository").value.trim(),
        f = o("curation-commit").value.trim(),
        v = o("curation-path").value.trim(),
        w = o("audit-record").value.trim(),
        y = o("audit-digest").value.trim(),
        z = o("curation-owner").value.trim(),
        k =
          !v ||
          v.startsWith("/") ||
          v.startsWith("./") ||
          v.includes("\\") ||
          v.includes("//") ||
          v.split("/").some(function (T) {
            return !T || T === "." || T === "..";
          });
      if (
        !/^(agent|skill|command)$/.test(c) ||
        !l ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(d) ||
        !/^[0-9a-f]{40}$/.test(f) ||
        k ||
        !w ||
        !/^sha256:[0-9a-f]{64}$/.test(y) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(z)
      ) {
        (x(
          "curation-id",
          l
            ? "Correct the curation fields before adding."
            : "Use an external item identifier.",
        ),
          o("curation-id").focus(),
          p(
            "Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.",
            !0,
          ));
        return;
      }
      x("curation-id", "");
      let F = structuredClone(r.policy),
        editing = r.editing,
        _ = b();
      if (editing) {
        let previous = _.externalCuration.find(function (T) {
          return T.framework === editing.framework;
        });
        if (!previous) {
          ((r.policy = F), p("Curation edit could not find its original item.", !0));
          return;
        }
        previous.items = previous.items.filter(function (T) {
          return T.kind !== editing.kind || T.id !== editing.id;
        });
        _.externalCuration = _.externalCuration.filter(function (T) {
          return T.items.length > 0;
        });
      }
      let S = _.externalCuration.find(function (T) {
        return T.framework === s;
      });
      S || ((S = { framework: s, items: [] }), _.externalCuration.push(S));
      if (
        S.items.some(function (T) {
          return T.kind === c && T.id === l;
        })
      ) {
        ((r.policy = F), p("That external curation item is already present.", !0));
        return;
      }
      (S.items.push({
        kind: c,
        id: l,
        accountableOwner: z,
        source: { repository: d, commit: f, path: v },
        audit: { record: w, digest: y },
        ...(o("curation-note").value.trim()
          ? { clarification: o("curation-note").value.trim() }
          : {}),
      }),
        (r.editing = null),
        (o("curation-framework").disabled = !1),
        (o("cancel-curation-edit").hidden = !0),
        Cy(),
        commitPolicy(
          F,
          editing
            ? "External curation intent updated; it is report-only and not enforced by AIH."
            : "External curation intent added; it is report-only and not enforced by AIH.",
        ));
    }),
    o("custom-form").addEventListener("submit", function (s) {
      s.preventDefault();
      let c = o("custom-id").value.trim(),
        l = o("custom-package").value.trim(),
        d = o("custom-version").value.trim(),
        f = o("custom-integrity").value.trim(),
        v = o("custom-evidence").value.trim(),
        w = o("custom-note").value.trim(),
        y = o("custom-owner").value.trim(),
        k = b();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(y)) {
        (x("custom-owner", "Use an accountable owner email address."),
          o("custom-owner").focus(),
          p(
            "Use an accountable owner email address for the pending custom MCP.",
            !0,
          ));
        return;
      }
      x("custom-owner", "");
      if (
        k.catalog.custom.some(function (_) {
          return _.id === c;
        })
      ) {
        p("Custom candidate identifier already exists.", !0);
        return;
      }
      let _ = structuredClone(r.policy);
      (k.catalog.custom.push({
        id: c,
        kind: "mcp",
        accountableOwner: y,
        description: "Pending custom MCP",
        capabilities: [],
        risks: ["custom source"],
        source: {
          type: "stdio",
          resolver: "npx",
          registry: "https://registry.npmjs.org",
          package: l,
          version: d,
          integrity: f,
        },
        targets: ["claude"],
        projector: "mcp-managed-settings",
        lifecycle: "supported",
        evidence: { record: v },
        findings: [],
        autoExecute: !1,
        ...(w ? { clarification: w } : {}),
      }),
        commitPolicy(_, "Pending custom MCP added. It cannot be activated.")
          ? s.target.reset()
          : /[\p{C}]/u.test(w) &&
            (x("custom-note", "Use visible text without hidden Unicode."),
            o("custom-note").focus()));
    }),
    document.addEventListener("click", function (s) {
      let c =
        s.target.closest && s.target.closest("[data-ecc-mcp-approval-remove]");
      if (!c) return;
      let l = c.getAttribute("data-ecc-mcp-approval-remove"),
        d = structuredClone(r.policy),
        f = b();
      ((f.eccMcpApprovals = (
        Array.isArray(f.eccMcpApprovals) ? f.eccMcpApprovals : []
      ).filter(function (v) {
        return v.id !== l;
      })),
        commitPolicy(d, "ECC MCP approval removed for " + l + "."));
    });
  o("remote-custom-form").addEventListener("submit", function (event) {
    event.preventDefault();
    let id = o("remote-custom-id").value.trim(),
      origin = o("remote-custom-origin").value.trim(),
      approvedBy = o("remote-custom-approved-by").value.trim(),
      authenticationMode = o("remote-custom-authentication-mode").value.trim(),
      dataClasses = o("remote-custom-data-classes")
        .value.split(",")
        .map(function (value) {
          return value.trim();
        })
        .filter(Boolean),
      administrativeStatus = o("remote-custom-administrative-status").value,
      evidence = o("remote-custom-evidence").value.trim(),
      clarification = o("remote-custom-note").value.trim(),
      originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      originUrl = null;
    }
    let validOrigin =
      originUrl &&
      originUrl.protocol === "https:" &&
      originUrl.username === "" &&
      originUrl.password === "" &&
      originUrl.pathname === "/" &&
      originUrl.search === "" &&
      originUrl.hash === "";
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
      !validOrigin ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approvedBy) ||
      !authenticationMode ||
      !dataClasses.length ||
      !/^(approved|revoked)$/.test(administrativeStatus) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(evidence) ||
      (clarification && /[\p{C}]/u.test(clarification))
    ) {
      x(
        "remote-custom-origin",
        validOrigin
          ? ""
          : "Use an exact HTTPS origin without a path, credentials, query, or fragment.",
      );
      p("Correct the highlighted remote-endpoint fields.", !0);
      o("remote-custom-origin").focus();
      return;
    }
    [
      "remote-custom-id",
      "remote-custom-origin",
      "remote-custom-approved-by",
      "remote-custom-authentication-mode",
      "remote-custom-data-classes",
      "remote-custom-evidence",
      "remote-custom-note",
    ].forEach(function (field) {
      x(field, "");
    });
    let prior = structuredClone(r.policy),
      governance = b(),
      candidate = {
        id: id,
        kind: "mcp",
        description: "Pending remote custom MCP",
        capabilities: [],
        risks: ["hosted endpoint"],
        source: {
          type: "remote",
          origin: originUrl.origin,
          approval: {
            approvedBy: approvedBy,
            authenticationMode: authenticationMode,
            allowedDataClasses: dataClasses,
          },
          administrativeStatus: administrativeStatus,
          contentScanned: !1,
        },
        targets: ["claude"],
        projector: "mcp-managed-settings",
        lifecycle: "supported",
        evidence: { record: evidence },
        findings: [],
        autoExecute: !1,
        ...(clarification ? { clarification: clarification } : {}),
      },
      existing = governance.catalog.custom.findIndex(function (entry) {
        return entry.id === id;
      });
    if (
      existing !== -1 &&
      governance.catalog.custom[existing].source.type !== "remote"
    ) {
      p("Custom candidate identifier already exists.", !0);
      return;
    }
    existing === -1
      ? governance.catalog.custom.push(candidate)
      : (governance.catalog.custom[existing] = candidate);
    commitPolicy(
      prior,
      "Pending remote MCP recorded. It remains fenced and does not activate or contact the endpoint.",
    );
  });
  document.addEventListener("click", function (event) {
    let action =
      event.target.closest &&
      event.target.closest(
        "[data-workbench-action][data-workbench-kind][data-workbench-id]",
      );
    if (!action) return;
    let id = action.getAttribute("data-workbench-id"),
      kind = action.getAttribute("data-workbench-kind"),
      operation = action.getAttribute("data-workbench-action"),
      governance = j();
    if (kind === "curation") {
      let framework = action.getAttribute("data-workbench-framework"),
        curationKind = action.getAttribute("data-workbench-curation-kind"),
        group = governance.externalCuration.find(function (entry) {
          return entry.framework === framework;
        }),
        item =
          group &&
          group.items.find(function (entry) {
            return entry.id === id && entry.kind === curationKind;
          });
      if (!group || !item || !framework || !curationKind) return;
      if (operation === "remove") {
        let prior = structuredClone(r.policy),
          writable = b(),
          writableGroup = writable.externalCuration.find(function (entry) {
            return entry.framework === framework;
          });
        if (!writableGroup) return;
        writableGroup.items = writableGroup.items.filter(function (entry) {
          return entry.id !== id || entry.kind !== curationKind;
        });
        writable.externalCuration = writable.externalCuration.filter(function (entry) {
          return entry.items.length > 0;
        });
        commitPolicy(prior, "External curation intent removed.");
        return;
      }
      if (operation !== "edit") return;
      ((o("curation-framework").value = framework),
        (o("curation-kind").value = curationKind),
        (o("curation-id").value = item.id),
        (o("curation-owner").value = item.accountableOwner || ""),
        (o("curation-repository").value = item.source.repository),
        (o("curation-commit").value = item.source.commit),
        (o("curation-path").value = item.source.path),
        (o("audit-record").value = item.audit.record),
        (o("audit-digest").value = item.audit.digest),
        (o("curation-note").value = item.clarification || ""),
        (r.editing = { framework: framework, kind: curationKind, id: item.id }),
        (o("curation-framework").disabled = !0),
        (o("curation-framework-label").textContent = "External framework owner (locked while editing)"),
        (o("add-curation").textContent = "Save framework curation"),
        (o("cancel-curation-edit").hidden = !1),
        Uf("curation", "Edit framework curation"),
        (o("curation-framework").disabled = !0),
        (o("curation-framework-label").textContent = "External framework owner (locked while editing)"),
        (o("add-curation").textContent = "Save framework curation"),
        (o("cancel-curation-edit").hidden = !1));
      return;
    }
    let index = governance.catalog.custom.findIndex(function (candidate) {
        return (
          candidate.id === id &&
          (kind === "remote") ===
            (candidate.source && candidate.source.type === "remote")
        );
      });
    if (index === -1) return;
    let candidate = governance.catalog.custom[index];
    if (operation === "readonly") {
      p("This remote declaration is preserved read-only; record a new administrative declaration to change it.");
      return;
    }
    if (operation === "remove") {
      let prior = structuredClone(r.policy),
        writable = b();
      writable.catalog.custom.splice(index, 1);
      commitPolicy(prior, "Custom candidate removed.");
      return;
    }
    if (operation !== "edit") return;
    if (kind === "remote") {
      let source = candidate.source;
      ((o("remote-custom-id").value = candidate.id),
        (o("remote-custom-origin").value = source.origin),
        (o("remote-custom-approved-by").value = source.approval.approvedBy),
        (o("remote-custom-authentication-mode").value =
          source.approval.authenticationMode),
        (o("remote-custom-data-classes").value =
          source.approval.allowedDataClasses.join(", ")),
        (o("remote-custom-administrative-status").value =
          source.administrativeStatus),
        (o("remote-custom-evidence").value = candidate.evidence.record),
        (o("remote-custom-note").value = candidate.clarification || ""),
        Uf("remote-custom"));
      return;
    }
    ((o("custom-id").value = candidate.id),
      (o("custom-owner").value = candidate.accountableOwner || ""),
      (o("custom-package").value = candidate.source.package || ""),
      (o("custom-version").value = candidate.source.version || ""),
      (o("custom-integrity").value = candidate.source.integrity || ""),
      (o("custom-evidence").value = candidate.evidence.record || ""),
      (o("custom-note").value = candidate.clarification || ""),
      Uf("custom"));
  });
  let Wf = function (s, c, l) {
    let d = s.files && s.files[0];
    if (!d) return;
    if (d.size > 1024 * 1024) {
      p((l || "Import") + " rejected: file exceeds the 1 MiB limit.", !0);
      return;
    }
    let f = new FileReader();
    ((f.onerror = function () {
      p((l || "Import") + " rejected: unable to read file.", !0);
    }),
      (f.onload = function () {
        c(String(f.result || ""));
      }),
      f.readAsText(d));
  };
  (o("import-policy").addEventListener("click", function () {
    o("policy-file").click();
  }),
    o("policy-file").addEventListener("change", function (s) {
      Wf(s.target, function (c) {
        try {
          let l = parseNativeStrictJsonObjectV1(c, "file import");
          if (!l || typeof l != "object" || Array.isArray(l))
            throw new Error("not an object");
          let d = preparePolicyImport(l, function (f) {
            return ie(t.schema, f, "").concat(nt(f), Pe(f), et(f), ot(f));
          });
          ((r.policy = d.policy),
            (r.managedMcpOptIn = Boolean(
              r.policy.mcp && r.policy.mcp.allowManagedOnly === !0,
            )),
            p(d.message),
            Xe(),
            window.dispatchEvent(new Event("aih-workbench-policy-change")));
        } catch (l) {
          p(
            "Policy import rejected: " +
              (l && l.message ? l.message : "valid policy JSON required"),
            !0,
          );
        }
      });
    }),
    o("import-evidence").addEventListener("click", function () {
      o("evidence-file").click();
    }),
    o("evidence-file").addEventListener("change", function (s) {
      Wf(s.target, function (c) {
        try {
          let l = parseNativeStrictJsonObjectV1(c, "file import");
          if (!l || typeof l != "object" || Array.isArray(l))
            throw new Error("not an object");
          ((r.receipt = l),
            p(
              "Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.",
            ),
            ly(),
            typeof window.__aihPolicyWorkbenchEnhanceRows == "function" &&
              window.__aihPolicyWorkbenchEnhanceRows());
        } catch {
          p("Evidence import failed: valid JSON object required.", !0);
        }
      });
    }),
    o("import-decision").addEventListener("click", function () {
      o("decision-file").click();
    }),
    o("decision-file").addEventListener("change", function (s) {
      let c = s.target,
        l = c.files && c.files[0];
      if (!l) return;
      if (l.size > 1024 * 1024) {
        p("Decision import rejected: file exceeds the 1 MiB limit.", !0);
        return;
      }
      let d = ++n,
        f = r.decision === null ? null : structuredClone(r.decision),
        v = new FileReader(),
        w = function () {
          d === n &&
            ((r.decision = f),
            zs(),
            p("Decision import rejected: unable to read decision file", !0));
        };
      ((v.onerror = w),
        (v.onabort = w),
        (v.onload = function () {
          if (d === n)
            try {
              let y = parseNativeStrictJsonObjectV1(
                  String(v.result || ""),
                  "decision import",
                ),
                k = a(y);
              if (k.length) throw new Error(k.slice(0, 3).join("; "));
              ((r.decision = structuredClone(y)),
                p(
                  "Decision imported for inspection only: unverified and not effective.",
                ),
                zs());
            } catch (y) {
              ((r.decision = f),
                zs(),
                p(
                  "Decision import rejected: " +
                    (y && y.message
                      ? y.message
                      : "strict decision JSON required"),
                  !0,
                ));
            }
        }),
        v.readAsText(l));
    }),
    o("copy-approvals").addEventListener("click", function () {
      p(
        "Raw imported authority data remains an inert draft until Core prepares and verifies it; it cannot populate governance approvals.",
        !0,
      );
    }),
    o("validate").addEventListener("click", function () {
      let s = validateCurrentPolicy(),
        c = Qe(),
        v = o("validate");
      (v.classList.remove("check-failed", "check-attention"),
        s.length
          ? (v.classList.add("check-failed"),
            v.setAttribute("title", "Policy check failed: " + s.join("; ")),
            p(
              "Schema and policy-grammar validation failed: " +
                s.slice(0, 3).join("; "),
              !0,
            ))
          : c.length
            ? (v.classList.add("check-attention"),
              v.setAttribute(
                "title",
                "Deployment setup needs attention: " + c.join("; "),
              ),
              p(
                "Schema and policy-grammar validation passed, but deployment setup needs attention: " +
                  c.join("; ") +
                  ".",
                !0,
              ))
            : (v.setAttribute("title", "Validate"),
              p(
                "Schema and policy-grammar validation passed. Authority, scans, projection, and effective state require the AIH engine in a target repository.",
              )),
        renderPolicyPreview());
    }),
    o("export").addEventListener("click", function () {
      let s = validateCurrentPolicy(), c = Qe();
      if (s.length || c.length) {
        p("Export blocked: " + s.concat(c).slice(0, 3).join("; "), !0);
        return;
      }
      (renderPolicyPreview(),
        p(
          "Policy export preview refreshed from the actual policy schema and grammar.",
        ));
    }),
    o("download").addEventListener("click", function () {
      let s = validateCurrentPolicy(), q = Qe();
      if (s.length || q.length) {
        p("Download blocked: " + s.concat(q).slice(0, 3).join("; "), !0);
        return;
      }
      let c = o("policy-download-name"),
        l = c ? c.value.trim() : "aih-org-policy.json";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/.test(l)) {
        p(
          "Download blocked: Use a JSON filename without folders, spaces, or hidden characters.",
          !0,
        );
        return;
      }
      let d = new Blob([R()], { type: "application/json" }),
        f = URL.createObjectURL(d),
        v = document.createElement("a");
      ((v.href = f),
        (v.download = l),
        v.click(),
        URL.revokeObjectURL(f),
        p(
          "Policy download started. Validate this file with: aih policy validate <target-root> --policy " +
            l,
        ));
    }),
    o("download-decision").addEventListener("click", function () {
      if (!r.decision) return;
      let s = new Blob(
          [
            i(r.decision) +
              `
`,
          ],
          { type: "application/json" },
        ),
        c = URL.createObjectURL(s),
        l = document.createElement("a");
      ((l.href = c),
        (l.download = "aih-governance-decision.json"),
        l.click(),
        URL.revokeObjectURL(c),
        p(
          "Canonical decision download started; it remains unverified and not effective.",
        ));
    }));
  let Ry = function () {
      let s = j().supportedClis;
      return Array.isArray(s) ? s : [];
    },
    Qe = function () {
      return deploymentReadinessBlockers(r.policy, r.managedMcpOptIn);
    },
    Qf = function () {
      let s = o("deployment-readiness");
      if (!s) return;
      let c = Qe(), l = j(), d = l.catalog && Array.isArray(l.catalog.reviewed) ? l.catalog.reviewed : [],
        f = new Set(
          (Array.isArray(l.activations) ? l.activations : [])
            .filter(function (v) {
              return v && v.state === "active";
            })
            .map(function (v) {
              return v.candidate;
            }),
        ),
        v = d.filter(function (w) {
          return f.has(w.id) && (w.kind === "mcp" || w.kind === "hook");
        });
      let w = v
        .map(function (y) {
          let k = (Array.isArray(l.activations) ? l.activations : []).find(function (_) {
            return _ && _.state === "active" && _.candidate === y.id;
          });
          return y.id + " → " + (k && Array.isArray(k.targets) ? k.targets.join(", ") : "none");
        })
        .join("; ");
      s.textContent = v.length
        ? c.length
          ? "Deployment setup needs attention before download: " + c.join("; ") + ". Exact selected target intersections: " + w + "."
          : "Draft is ready to export. " + ((r.policy.minimumPosture || "vibe") === "vibe" ? "Governance MCP and hook projection remains disabled in Vibe; choose Enterprise for governed deployment. " : "Governed deployment still requires policy authority and target verification. ") + "Exact selected target intersections: " + w + ". Export records the managed-MCP setting."
        : "No Core controls selected. Choose controls after setting the hosts and posture you intend to use.";
    },
    Jf = function () {
      let s = t.catalog.hosts || [],
        c = s.filter(function (f) {
          return f.policyTarget;
        }),
        l = new Set(Ry()),
        d = o("supported-cli-hosts");
      d &&
        ((d.innerHTML = s
          .map(function (f) {
            let v = l.has(f.id);
            return (
              '<button type="button" class="chip" data-host="' +
              e(f.id) +
              '" data-sanctioned-cli="' +
              e(f.id) +
              '" aria-pressed="' +
              (v ? "true" : "false") +
              '" title="' +
              e(
                f.label +
                  (f.policyTarget
                    ? " - a policy activation can target this host"
                    : " - can be sanctioned by org policy, but cannot be targeted by the projector") +
                  ". MCP support: " +
                  f.mcpSupport,
              ) +
              '">' +
              e(f.id) +
              "</button>"
            );
          })
          .join("")),
        (o("supported-cli-count").textContent = l.size + " selected"),
        (o("supported-cli-note").textContent =
          "AIH supports " +
          s.length +
          " CLIs; " +
          c.length +
          " can receive policy activations. " +
          l.size +
          " are selected by this policy. Sanctioned, materialization-capable, and projector-capable are separate sets."));
    };
  (Jf(),
    document.addEventListener("click", function (s) {
      let c = s.target.closest && s.target.closest("[data-sanctioned-cli]");
      if (!c) return;
      let l = c.getAttribute("data-sanctioned-cli"),
        d = t.catalog.hosts || [];
      if (
        !d.some(function (_) {
          return _.id === l;
        })
      )
        return;
      let f = structuredClone(r.policy),
        v = b(),
        w = new Set(Array.isArray(v.supportedClis) ? v.supportedClis : []);
      w.has(l) ? w.delete(l) : w.add(l);
      let y = d
        .map(function (_) {
          return _.id;
        })
        .filter(function (_) {
          return w.has(_);
        });
      y.length ? (v.supportedClis = y) : delete v.supportedClis;
      let k = ri(v);
      if (k) {
        ((r.policy = f),
          p(
            "Policy change rejected: " +
              k +
              ". Remove that control before removing its last projectable sanctioned CLI.",
            !0,
          ),
          Xe());
        return;
      }
      commitPolicy(
        f,
        y.length
          ? "Supported CLI allow-list updated: " +
              y.join(", ") +
              ". Reviewed activation targets were rebound to their exact sanctioned projector intersections; unsanctioned selected or detected CLIs are refused by the engine."
          : "Supported CLI allow-list cleared without broadening existing activation targets. Vibe permits an omitted list; Enterprise requires an explicit list.",
      );
    }),
    o("curation-editor")
      .querySelector("summary")
      .insertAdjacentHTML(
        "afterend",
        g(
          "external curation",
          "AIH preserves audited curation intent for agents, skills and commands with a pin and an audit record. It never installs, projects or enforces them - ECC and Superpowers do.",
        ),
      ),
    o("custom-editor")
      .querySelector("summary")
      .insertAdjacentHTML(
        "afterend",
        g(
          "custom sources",
          "A custom MCP is recorded immediately as a fully pinned candidate and stays blocked until a completed scan binds to that exact pin.",
        ),
      ),
    document.addEventListener("click", function (s) {
      !s.target.closest ||
        !s.target.closest("#clear-policy") ||
        ((r.policy = structuredClone(t.initialPolicy)),
        (r.managedMcpOptIn = Boolean(
          r.policy.mcp && r.policy.mcp.allowManagedOnly === !0,
        )),
        (r.editing = null),
        p(
          "Policy cleared. All selections, requests and curation records were removed from this draft. You can start again with any source.",
        ),
        Xe(),
        window.dispatchEvent(new Event("aih-workbench-policy-change")));
    }),
    Xe(),
    Hv({
      model: t,
      byId: o,
      announce: p,
      schemaErrors: ie,
      fieldError: x,
      state: r,
    }),
    (function () {
      if (t.workbenchBundle) {
        var genericImportPolicy = function (D) {
          return preparePolicyImport(D, function (M) {
            return ie(t.schema, M, "").concat(nt(M), Pe(M), et(M), ot(M));
          });
        };

        if (
          mountGenericWorkspaceShell({
            model: t,
            byId: o,
            session: {
              snapshotPolicy: function () {
                return structuredClone(r.policy);
              },
              validatePolicy: genericImportPolicy,
              restorePolicy: function (D) {
                var M = genericImportPolicy(D);
                return (
                  (r.managedMcpOptIn =
                    r.managedMcpOptIn ||
                    Boolean(M.policy.mcp && M.policy.mcp.allowManagedOnly === !0)),
                  (r.policy = M.policy),
                  Ye(),
                  (r.editing = null),
                  window.__aihWorkbenchApplyingProjection
                    ? (renderPolicyPreview(), Jf(), Qf())
                    : Xe(),
                  window.dispatchEvent(
                    new Event("aih-workbench-policy-change"),
                  ),
                  M.message
                );
              },
            },
          })
        )
          return;
      }
      return;
    })());
}
