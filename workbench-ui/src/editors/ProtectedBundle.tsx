import { useId, useState } from "react";
import type {
  AdminEngine,
  EngineOutcome,
  ProtectedFieldsV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_INPUT } from "../chrome.js";
import type { WorkbenchHost } from "../host.js";

/**
 * Protected bundle authoring (editor 23): exact artifact approvals, their
 * revocations, and the one PolicyBundle V2 file they produce. Behaviour
 * source: `src/org-policy/studio-protected-authority.ts` and its runtime.
 *
 * Every digest is computed by the HOST (`host.sha256Hex`), never by the
 * engine, and every refusal is the hand-built form's own sentence, placed
 * beside the control it names.
 */

export const PROTECTED_TITLE = "Protected Enterprise policy file";
export const PROTECTED_LEGEND = "Organization authority and exact artifact approval";
const PROTECTED_HELP =
  "Fill ordinary fields. The Workbench computes canonical Decision V2 digests and emits one PolicyBundle V2 file for a read-only administrator-controlled location. No GitHub workflow or hand-authored JSON is required.";
const PROTECTED_NOTE =
  "Organization-owned exact artifacts use this Catalog-independent route after attributable scan evidence exists. Core records exact observed state; it does not install or run the artifact.";
const PROTECTED_STORE_NOTE =
  "Store the downloaded file at an administrator-controlled read-only path and configure Core to consume that path. Core still verifies the exact bytes, validity window, decision, evidence binding, and file custody before effects.";
export const PROTECTED_PREVIEW_LABEL = "Generated protected policy file";
export const PROTECTED_SUBMIT = "Add exact artifact approval";
export const PROTECTED_DOWNLOAD = "Download protected policy file";
export const PROTECTED_EVIDENCE_DOWNLOAD = "Download organization evidence envelope";
const DIGEST_UNAVAILABLE = "This browser cannot compute protected policy digests with Web Crypto.";

/** Each control, in the hand-built form's order, with its label. */
const FIELDS: readonly {
  readonly id: string;
  readonly label: string;
  readonly options?: readonly string[];
}[] = [
  { id: "protected-bundle-version", label: "Bundle version" },
  { id: "protected-issuer-repository", label: "Issuer repository identity (attribution only)" },
  { id: "protected-issuer", label: "Authority issuer" },
  { id: "protected-issued-at", label: "Authority issued at" },
  { id: "protected-expires-at", label: "Authority expires at" },
  { id: "protected-decision-id", label: "Decision identifier" },
  {
    id: "protected-kind",
    label: "Artifact kind",
    options: ["tool", "skill", "agent", "mcp", "package", "profile"],
  },
  { id: "protected-subject-id", label: "Artifact identifier" },
  {
    id: "protected-source-type",
    label: "Source type",
    options: ["github", "npm", "pypi", "oci", "remote", "aih"],
  },
  { id: "protected-source-repository", label: "Exact GitHub repository" },
  { id: "protected-source-commit", label: "Exact commit" },
  { id: "protected-source-path", label: "Source path" },
  { id: "protected-source-registry", label: "Canonical HTTPS registry" },
  { id: "protected-source-package", label: "Exact package" },
  { id: "protected-source-version", label: "Exact version" },
  { id: "protected-source-integrity", label: "Exact sha512 SRI integrity" },
  { id: "protected-source-filename", label: "Exact distribution filename" },
  { id: "protected-source-sha256", label: "Exact distribution digest" },
  { id: "protected-source-oci-registry", label: "Canonical OCI registry" },
  { id: "protected-source-oci-repository", label: "OCI repository" },
  { id: "protected-source-index-digest", label: "Exact OCI index digest" },
  { id: "protected-source-platform-os", label: "Platform operating system" },
  { id: "protected-source-platform-architecture", label: "Platform architecture" },
  { id: "protected-source-platform-variant", label: "Platform variant (optional)" },
  { id: "protected-source-manifest-digest", label: "Exact OCI manifest digest" },
  { id: "protected-source-endpoint", label: "Canonical HTTPS endpoint" },
  { id: "protected-source-content-digest", label: "Exact content digest" },
  { id: "protected-source-release", label: "Exact AIH release" },
  { id: "protected-source-revision", label: "Exact AIH revision" },
  { id: "protected-targets", label: "Targets" },
  { id: "protected-effects", label: "Allowed effects" },
  {
    id: "protected-qualification-kind",
    label: "Qualification basis",
    options: ["organization-qualified", "aih-supported"],
  },
  { id: "protected-catalog-signer", label: "Catalog signer identity" },
  { id: "protected-catalog-digest", label: "Exact Catalog digest" },
  { id: "protected-catalog-head-digest", label: "Exact Catalog head digest" },
  { id: "protected-catalog-member-digest", label: "Exact Catalog member digest" },
  { id: "protected-evidence-id", label: "Evidence identifier" },
  { id: "protected-evidence-digest", label: "Evidence digest" },
  { id: "protected-attestor", label: "Evidence attestor" },
  { id: "protected-policy-id", label: "Policy identifier" },
  { id: "protected-policy-version", label: "Policy version" },
  { id: "protected-policy-digest", label: "Policy digest" },
  { id: "protected-control-id", label: "Control identifier" },
  { id: "protected-control-digest", label: "Control digest" },
  { id: "protected-actor", label: "Accountable owner email" },
  { id: "protected-reason", label: "Approval reason" },
  {
    id: "protected-disposition",
    label: "Decision disposition",
    options: ["approved", "accepted-with-conditions"],
  },
  { id: "protected-accepted-findings", label: "Accepted findings" },
  { id: "protected-accepted-gaps", label: "Accepted waivable gaps" },
  { id: "protected-conditions", label: "Conditions" },
  { id: "protected-review-by", label: "Review by" },
];

/** Which source fields the chosen source type shows (`protectedSourceVisibility`). */
const SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: ["protected-source-repository", "protected-source-commit", "protected-source-path"],
  npm: [
    "protected-source-registry",
    "protected-source-package",
    "protected-source-version",
    "protected-source-integrity",
  ],
  pypi: [
    "protected-source-registry",
    "protected-source-package",
    "protected-source-version",
    "protected-source-filename",
    "protected-source-sha256",
  ],
  oci: [
    "protected-source-oci-registry",
    "protected-source-oci-repository",
    "protected-source-index-digest",
    "protected-source-platform-os",
    "protected-source-platform-architecture",
    "protected-source-platform-variant",
    "protected-source-manifest-digest",
  ],
  remote: ["protected-source-endpoint", "protected-source-content-digest"],
  aih: ["protected-source-release", "protected-source-revision"],
};
const ALL_SOURCE_FIELDS = new Set(Object.values(SOURCE_FIELDS).flat());
const CATALOG_FIELDS = new Set([
  "protected-catalog-signer",
  "protected-catalog-digest",
  "protected-catalog-head-digest",
  "protected-catalog-member-digest",
]);
const CONDITIONAL_FIELDS = new Set([
  "protected-accepted-findings",
  "protected-accepted-gaps",
  "protected-conditions",
  "protected-review-by",
]);

/** The form's own starting values, as the hand-built selects start. */
export const PROTECTED_INITIAL_FIELDS: ProtectedFieldsV1 = Object.freeze(
  Object.fromEntries([...FIELDS.map((field) => [field.id, field.options?.[0] ?? ""])]) as Record<
    string,
    string
  >,
);

export function ProtectedBundle({
  engine,
  host,
  fields,
  onFields,
  setOutcome,
  onDownload,
}: {
  readonly engine: AdminEngine;
  readonly host: WorkbenchHost;
  readonly fields: ProtectedFieldsV1;
  readonly onFields: (next: ProtectedFieldsV1) => void;
  readonly setOutcome: (outcome: EngineOutcome) => void;
  /** The host hands the finished file over; the page then says so. */
  readonly onDownload: (file: { readonly name: string; readonly text: string }) => void;
}) {
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const previewId = useId();
  const view = engine.protectedAuthoring();
  const sourceType = fields["protected-source-type"] ?? "github";
  const qualification = fields["protected-qualification-kind"] ?? "organization-qualified";
  const disposition = fields["protected-disposition"] ?? "approved";

  /**
   * The engine asks the host for every digest: SHA-256 of exactly these
   * characters, as `sha256:<hex>`. A host that cannot hash refuses in words.
   */
  const digest = async (preimage: string): Promise<string> => {
    if (typeof TextEncoder === "undefined") throw new Error(DIGEST_UNAVAILABLE);
    const bytes = new TextEncoder().encode(preimage);
    return `sha256:${await host.sha256Hex(bytes.buffer as ArrayBuffer)}`;
  };

  const show = (outcome: { ok: boolean; message: string; issues: Record<string, string> }) => {
    setIssues(outcome.issues);
    setOutcome({ ok: outcome.ok, message: outcome.message });
    setTick((value) => value + 1);
  };

  const runProtected = (
    call: () => Promise<{
      ok: boolean;
      message: string;
      issues: Readonly<Record<string, string>>;
    }>,
  ) => {
    setBusy(true);
    void call()
      .then((outcome) => {
        show({ ...outcome, issues: { ...outcome.issues } });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const visible = (id: string): boolean => {
    if (ALL_SOURCE_FIELDS.has(id)) return (SOURCE_FIELDS[sourceType] ?? []).includes(id);
    if (CATALOG_FIELDS.has(id)) return qualification === "aih-supported";
    if (CONDITIONAL_FIELDS.has(id)) return disposition === "accepted-with-conditions";
    return true;
  };

  return (
    <section aria-label={PROTECTED_TITLE} className="space-y-2" key={tick}>
      <h2 className="m-0 text-[13px] font-semibold text-on-surface">{PROTECTED_TITLE}</h2>
      <fieldset className="m-0 p-0 border-0 space-y-2">
        <legend className="text-[11.5px] font-semibold text-on-surface">{PROTECTED_LEGEND}</legend>
        <p className="m-0 text-[10.5px] text-outline leading-relaxed">{PROTECTED_HELP}</p>
        <p className="m-0 text-[10.5px] text-outline leading-relaxed">{PROTECTED_NOTE}</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {FIELDS.filter((field) => visible(field.id)).map((field) => (
            <ProtectedField
              field={field}
              issue={issues[field.id]}
              key={field.id}
              onChange={(next) => onFields({ ...fields, [field.id]: next })}
              value={fields[field.id] ?? ""}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => {
              runProtected(() => engine.addProtectedDecision(fields, digest));
            }}
            type="button"
          >
            {PROTECTED_SUBMIT}
          </button>
          <button
            className={SECONDARY_BUTTON}
            disabled={busy || view.downloadDisabled}
            onClick={() => {
              setBusy(true);
              void engine
                .downloadProtectedBundle(fields)
                .then((result) => {
                  setIssues({ ...result.issues });
                  if (!result.ok) {
                    setOutcome({ ok: false, message: result.errors.join("; ") });
                    return;
                  }
                  onDownload(result.value);
                })
                .finally(() => {
                  setBusy(false);
                  setTick((value) => value + 1);
                });
            }}
            type="button"
          >
            {PROTECTED_DOWNLOAD}
          </button>
          {/* Pinned as the hand-built runtime behaves: no envelope is generated,
           * so this control is never available. It keeps its words. */}
          <button className={SECONDARY_BUTTON} disabled type="button">
            {PROTECTED_EVIDENCE_DOWNLOAD}
          </button>
        </div>
      </fieldset>

      {view.rows.length === 0 ? null : (
        <ul aria-label="Exact artifact approvals" className="list-none m-0 p-0 space-y-1.5">
          {view.rows.map((row, index) => (
            <li
              className="flex flex-wrap items-center gap-2 px-2.5 py-2 rounded border border-surface-container-high/40 bg-surface-container-low text-[11px]"
              key={row.id}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <strong className="block font-mono text-on-surface break-all">{row.id}</strong>
                <p className="m-0 font-mono text-[10.5px] text-on-surface-variant break-all">
                  {row.summary}
                </p>
              </div>
              <button
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={() => {
                  runProtected(() => engine.removeProtectedDecision(index, fields, digest));
                }}
                type="button"
              >
                {`Remove ${row.id}`}
              </button>
              <button
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={() => {
                  runProtected(() => engine.revokeProtectedDecision(index, fields, digest));
                }}
                type="button"
              >
                {`Revoke ${row.id}`}
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="block text-[10.5px] text-outline" htmlFor={previewId}>
        {`${PROTECTED_PREVIEW_LABEL} (read-only preview)`}
      </label>
      <textarea
        aria-label={PROTECTED_PREVIEW_LABEL}
        className="w-full h-40 p-2 rounded bg-surface-container-lowest border border-surface-container-high/40 font-mono text-[10.5px] text-on-surface"
        id={previewId}
        readOnly
        value={view.bundlePreview}
      />
      <p className="m-0 text-[10.5px] text-outline leading-relaxed">{PROTECTED_STORE_NOTE}</p>
    </section>
  );
}

function ProtectedField({
  field,
  value,
  issue,
  onChange,
}: {
  readonly field: {
    readonly id: string;
    readonly label: string;
    readonly options?: readonly string[];
  };
  readonly value: string;
  readonly issue: string | undefined;
  readonly onChange: (next: string) => void;
}) {
  const id = useId();
  const issueId = useId();
  return (
    <label className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant" htmlFor={id}>
      {field.label}
      {field.options === undefined ? (
        <input
          aria-describedby={issue === undefined ? undefined : issueId}
          aria-invalid={issue === undefined ? undefined : true}
          className={`${TEXT_INPUT} w-full`}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          type="text"
          value={value}
        />
      ) : (
        <select
          aria-describedby={issue === undefined ? undefined : issueId}
          aria-invalid={issue === undefined ? undefined : true}
          className={`${TEXT_INPUT} w-full`}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {/* The refusal sits beside its own control, in words, never by colour. */}
      {issue === undefined ? null : (
        <span className="text-[10px] text-tertiary" id={issueId}>
          {issue}
        </span>
      )}
    </label>
  );
}
