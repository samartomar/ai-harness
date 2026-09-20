import { governanceOrDefault } from "../../ui/shell/policy-grammar.js";
import { type EngineOutcome, errorMessage, record } from "../shared.js";
import type { AdminEngineContext } from "./context.js";

/**
 * The Additions screen's feature (acceptance rule section 7, rows 15, 16, 17):
 * framework curation, the pending custom and remote MCP forms, and the ECC MCP
 * approvals the policy already carries.
 *
 * Every rule and every message here is `ui/shell/acme-screen.ts`, which copied
 * them from the legacy runtime (`Es`, `Cy`, `oy`, `m`, `$f` and the row, form
 * and approval handlers). Pure, like everything under `engine/`: the view is
 * given text and asked for values; nothing here touches the DOM.
 */

// biome-ignore lint/suspicious/noExplicitAny: policy JSON is validated by the grammar, not by TypeScript
type Loose = any;

/** `acme-screen.ts` line 87. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The exact announcements of `acme-screen.ts`. */
const CURATION_INVALID_MESSAGE =
  "Use a kind, identifier, pinned repository/40-character commit/safe path, audit record, and sha256 digest.";
const CURATION_ID_MISSING_MESSAGE = "Use an external item identifier.";
const CURATION_FIELDS_MESSAGE = "Correct the curation fields before adding.";
const CURATION_ADDED_MESSAGE =
  "External curation intent added; it is report-only and not enforced by AIH.";
const CURATION_UPDATED_MESSAGE =
  "External curation intent updated; it is report-only and not enforced by AIH.";
const CURATION_REMOVED_MESSAGE = "External curation intent removed.";
const CURATION_DUPLICATE_MESSAGE = "That external curation item is already present.";
const CURATION_LOST_MESSAGE = "Curation edit could not find its original item.";
const CUSTOM_OWNER_MESSAGE = "Use an accountable owner email address for the pending custom MCP.";
const CUSTOM_OWNER_FIELD_MESSAGE = "Use an accountable owner email address.";
const CUSTOM_DUPLICATE_MESSAGE = "Custom candidate identifier already exists.";
const CUSTOM_ADDED_MESSAGE = "Pending custom MCP added. It cannot be activated.";
const CUSTOM_NOTE_FIELD_MESSAGE = "Use visible text without hidden Unicode.";
const CUSTOM_REMOVED_MESSAGE = "Custom candidate removed.";
const REMOTE_INVALID_MESSAGE = "Correct the highlighted remote-endpoint fields.";
const REMOTE_ORIGIN_FIELD_MESSAGE =
  "Use an exact HTTPS origin without a path, credentials, query, or fragment.";
const REMOTE_RECORDED_MESSAGE =
  "Pending remote MCP recorded. It remains fenced and does not activate or contact the endpoint.";
const REMOTE_READ_ONLY_MESSAGE =
  "This remote declaration is preserved read-only; record a new administrative declaration to change it.";

/** The row detail of `acme-screen.ts` lines 1138 and 1154. */
const CUSTOM_ROW_DETAIL = "Pinned custom source - no activation affordance";
const CURATION_ROW_BADGE = "External guidance - not enforced";

/** A field a refusal points at, so the view can mark exactly that input. */
export type AdditionFieldV1 =
  | "curation-id"
  | "custom-owner"
  | "custom-note"
  | "remote-custom-origin";

export interface AdditionFieldProblemV1 {
  readonly field: AdditionFieldV1;
  readonly message: string;
}

/** An outcome that may also name the field the hand-built page marks. */
export interface AdditionsOutcomeV1 extends EngineOutcome {
  readonly fieldErrors?: readonly AdditionFieldProblemV1[];
}

export interface CurationInputV1 {
  readonly framework: string;
  readonly kind: string;
  readonly id: string;
  readonly accountableOwner: string;
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly auditRecord: string;
  readonly auditDigest: string;
  readonly clarification: string;
}

/** The item an edit replaces (the legacy `r.editing`). */
export interface CurationTargetV1 {
  readonly framework: string;
  readonly kind: string;
  readonly id: string;
}

export interface CustomMcpInputV1 {
  readonly id: string;
  readonly accountableOwner: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly evidence: string;
  readonly clarification: string;
}

export interface RemoteMcpInputV1 {
  readonly id: string;
  readonly origin: string;
  readonly approvedBy: string;
  readonly authenticationMode: string;
  /** The comma-separated field of the hand-built form, split by the engine. */
  readonly allowedDataClasses: string;
  readonly administrativeStatus: string;
  readonly evidence: string;
  readonly clarification: string;
}

export interface CurationRowV1 {
  /** `${framework}: ${kind} / ${id}`, as the hand-built row's label. */
  readonly label: string;
  readonly badge: string;
  readonly detail: string;
  readonly item: CurationInputV1;
}

export interface CustomRowV1 {
  readonly id: string;
  readonly kind: "custom" | "remote";
  /** The badge of the legacy `m`: the state this candidate is in. */
  readonly badge: string;
  readonly tone: "blocked" | "requested" | "pending";
  readonly detail: string;
  readonly note: string;
  /** A remote declaration without an administrative status: read-only. */
  readonly preserved: boolean;
  /** The form values an Edit puts back, absent for a preserved remote. */
  readonly custom?: CustomMcpInputV1;
  readonly remote?: RemoteMcpInputV1;
}

export interface EccMcpOptionV1 {
  readonly id: string;
  /** `${id} — ${addability}`, the hand-built option text. */
  readonly label: string;
}

export interface EccMcpApprovalRowV1 {
  readonly id: string;
  readonly state: string;
  readonly authenticationMode: string;
}

/** Everything the Additions screen renders, as a fresh read. */
export interface AdditionsViewV1 {
  /** The framework owners of the prepared catalog, in its order. */
  readonly frameworks: readonly EccMcpOptionV1[];
  readonly curationRows: readonly CurationRowV1[];
  readonly customRows: readonly CustomRowV1[];
  readonly eccPinned: readonly EccMcpOptionV1[];
  readonly eccApprovals: readonly EccMcpApprovalRowV1[];
  /** The rail's counts (`acme-screen.ts` lines 600-617). */
  readonly counts: {
    readonly customMcp: number;
    readonly remoteMcp: number;
    readonly curation: number;
    readonly eccApprovals: number;
  };
}

export interface AdditionsFeature {
  /** Everything the Additions screen shows; a fresh read each call. */
  additions(): AdditionsViewV1;
  /** The fields the hand-built page refuses before it commits anything. */
  curationProblems(input: CurationInputV1): readonly AdditionFieldProblemV1[];
  /** Add, or replace `target`, one external curation item. */
  saveCuration(input: CurationInputV1, target?: CurationTargetV1): AdditionsOutcomeV1;
  removeCuration(target: CurationTargetV1): AdditionsOutcomeV1;
  /** Record one fully pinned pending custom MCP. It cannot be activated. */
  addCustomMcp(input: CustomMcpInputV1): AdditionsOutcomeV1;
  /** Record, or replace by id, one fenced pending remote MCP. */
  saveRemoteMcp(input: RemoteMcpInputV1): AdditionsOutcomeV1;
  removeCustomCandidate(id: string, kind: "custom" | "remote"): AdditionsOutcomeV1;
  /** A preserved remote declaration: the page explains, and changes nothing. */
  readPreservedRemote(): AdditionsOutcomeV1;
  /** Remove one recorded ECC MCP approval. */
  removeEccMcpApproval(id: string): AdditionsOutcomeV1;
  /** An adoption route preselects a pinned entry; an unknown id is refused. */
  selectEccMcp(id: string): AdditionsOutcomeV1;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): Loose[] {
  return Array.isArray(value) ? (value as Loose[]) : [];
}

/** `acme-screen.ts` lines 110-113. */
function writableGovernance(policy: Loose): Loose {
  policy.governance = governanceOrDefault(policy.governance);
  return policy.governance;
}

/** The legacy `m` (`acme-screen.ts` lines 125-134). */
function candidateState(governance: Loose, candidate: Loose): [string, CustomRowV1["tone"]] {
  if (candidate.kind === "mcp" && candidate.source && candidate.source.type === "stdio")
    return ["Blocked - evidence owed at this pin", "blocked"];
  const activation = list(governance.activations).find(
    (entry: Loose) => entry.candidate === candidate.id,
  );
  return activation && activation.state === "active"
    ? ["Requested intent - runtime evaluation required", "requested"]
    : ["Disabled", "pending"];
}

/** The legacy `$f` (`acme-screen.ts` lines 154-157). */
function customNextStep(candidate: Loose): string {
  const source = candidate.source || {};
  return `Next: save this policy as aih-org-policy.json in the target repository, then run aih trust scan ${source.package}@${source.version}. Integrity: ${source.integrity}. AIH fetches and scans that pinned npm tarball and emits preflight evidence record ${candidate.evidence.record} bound to candidate ${candidate.id}. The current fence is mandatory-detector-failed; it remains blocked until an independently attested authority receipt carries that exact record.`;
}

/** `acme-screen.ts` lines 775-781: the path rule of the curation form. */
function unsafeCurationPath(path: string): boolean {
  return (
    !path ||
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** `acme-screen.ts` lines 782-802, with the same field message. */
function curationFieldProblems(input: CurationInputV1): AdditionFieldProblemV1[] {
  const values = trimmedCuration(input);
  const invalid =
    !/^(agent|skill|command)$/.test(values.kind) ||
    !values.id ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository) ||
    !/^[0-9a-f]{40}$/.test(values.commit) ||
    unsafeCurationPath(values.path) ||
    !values.auditRecord ||
    !/^sha256:[0-9a-f]{64}$/.test(values.auditDigest) ||
    !EMAIL.test(values.accountableOwner);
  if (!invalid) return [];
  return [
    {
      field: "curation-id",
      message: values.id ? CURATION_FIELDS_MESSAGE : CURATION_ID_MISSING_MESSAGE,
    },
  ];
}

function trimmedCuration(input: CurationInputV1): CurationInputV1 {
  return {
    framework: text(input.framework),
    kind: text(input.kind),
    id: text(input.id).trim(),
    accountableOwner: text(input.accountableOwner).trim(),
    repository: text(input.repository).trim(),
    commit: text(input.commit).trim(),
    path: text(input.path).trim(),
    auditRecord: text(input.auditRecord).trim(),
    auditDigest: text(input.auditDigest).trim(),
    clarification: text(input.clarification).trim(),
  };
}

/** `acme-screen.ts` lines 920-933: an exact HTTPS origin, nothing else. */
function exactHttpsOrigin(origin: string): URL | null {
  let parsed: URL | null;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = null;
  }
  return parsed !== null &&
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === ""
    ? parsed
    : null;
}

function dataClassList(value: string): string[] {
  return text(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function additionsFeature(ctx: AdminEngineContext): AdditionsFeature {
  const active = ctx.active;
  const catalog = (record(ctx.model.catalog) ?? {}) as Loose;
  const governance = (): Loose =>
    governanceOrDefault(record(active.snapshotPolicy())?.governance) as Loose;

  /** Run one session edit and report exactly what the session announced. */
  const commit = (
    change: (draft: Loose) => string | undefined,
    message: string,
  ): { readonly committed: boolean; readonly outcome: EngineOutcome } => {
    ctx.resetOutcome();
    const committed = active.edit(change, message);
    return { committed, outcome: ctx.outcome(message) };
  };

  const curationRows = (): CurationRowV1[] =>
    list(governance().externalCuration).flatMap((group: Loose) =>
      list(group.items).map((item: Loose) => ({
        label: `${group.framework}: ${item.kind} / ${item.id}`,
        badge: CURATION_ROW_BADGE,
        detail: `Repository: ${item.source.repository} · Commit: ${item.source.commit} · Path: ${item.source.path} · Audit record: ${item.audit.record} · Audit digest: ${item.audit.digest} · Clarification: ${item.clarification || "none"} · report-only`,
        item: {
          framework: text(group.framework),
          kind: text(item.kind),
          id: text(item.id),
          accountableOwner: text(item.accountableOwner),
          repository: text(item.source.repository),
          commit: text(item.source.commit),
          path: text(item.source.path),
          auditRecord: text(item.audit.record),
          auditDigest: text(item.audit.digest),
          clarification: text(item.clarification),
        },
      })),
    );

  const customRows = (): CustomRowV1[] => {
    const recorded = governance();
    return list(recorded.catalog?.custom).map((candidate: Loose) => {
      const [badge, tone] = candidateState(recorded, candidate);
      const kind: "custom" | "remote" =
        candidate.source && candidate.source.type === "remote" ? "remote" : "custom";
      const preserved =
        kind === "remote" && !Object.hasOwn(candidate.source, "administrativeStatus");
      const detail =
        kind === "remote"
          ? preserved
            ? `Remote origin: ${candidate.source.origin} · Preserved remote declaration, read-only · Content scan: none`
            : `Remote origin: ${candidate.source.origin} · Administrative status: ${candidate.source.administrativeStatus} · Content scan: none · Accountable owner: ${candidate.source.approval?.approvedBy ? candidate.source.approval.approvedBy : "unrecorded"}`
          : `${customNextStep(candidate)} Accountable owner: ${candidate.accountableOwner}`;
      return {
        id: text(candidate.id),
        kind,
        badge,
        tone,
        detail,
        note: CUSTOM_ROW_DETAIL,
        preserved,
        ...(preserved
          ? {}
          : kind === "remote"
            ? {
                remote: {
                  id: text(candidate.id),
                  origin: text(candidate.source.origin),
                  approvedBy: text(candidate.source.approval?.approvedBy),
                  authenticationMode: text(candidate.source.approval?.authenticationMode),
                  allowedDataClasses: list(candidate.source.approval?.allowedDataClasses).join(
                    ", ",
                  ),
                  administrativeStatus: text(candidate.source.administrativeStatus),
                  evidence: text(candidate.evidence?.record),
                  clarification: text(candidate.clarification),
                },
              }
            : {
                custom: {
                  id: text(candidate.id),
                  accountableOwner: text(candidate.accountableOwner),
                  packageName: text(candidate.source?.package),
                  version: text(candidate.source?.version),
                  integrity: text(candidate.source?.integrity),
                  evidence: text(candidate.evidence?.record),
                  clarification: text(candidate.clarification),
                },
              }),
      };
    });
  };

  return {
    additions() {
      const recorded = governance();
      const rows = customRows();
      const approvals = list(recorded.eccMcpApprovals);
      return {
        // The legacy `Es`: `${id.toUpperCase()} - external guidance`.
        frameworks: list(catalog.frameworks).map((framework: Loose) => ({
          id: text(framework.id),
          label: `${text(framework.id).toUpperCase()} - external guidance`,
        })),
        curationRows: curationRows(),
        customRows: rows,
        // The legacy `sy`: `${id} — ${addability}`.
        eccPinned: list(catalog.externalMcp).map((entry: Loose) => ({
          id: text(entry.id),
          label: `${text(entry.id)} — ${text(entry.addability)}`,
        })),
        eccApprovals: approvals.map((approval: Loose) => ({
          id: text(approval.id),
          state: text(approval.state),
          authenticationMode: text(approval.authenticationMode),
        })),
        counts: {
          customMcp: rows.filter((row) => row.kind === "custom").length,
          remoteMcp: rows.filter((row) => row.kind === "remote").length,
          curation: list(recorded.externalCuration).reduce(
            (total: number, group: Loose) => total + list(group.items).length,
            0,
          ),
          eccApprovals: approvals.length,
        },
      };
    },

    curationProblems: curationFieldProblems,

    // acme-screen.ts lines 763-846.
    saveCuration(input, target) {
      try {
        const values = trimmedCuration(input);
        const problems = curationFieldProblems(values);
        if (problems.length)
          return { ok: false, message: CURATION_INVALID_MESSAGE, fieldErrors: problems };
        const message = target === undefined ? CURATION_ADDED_MESSAGE : CURATION_UPDATED_MESSAGE;
        return commit((draft: Loose) => {
          const writable = writableGovernance(draft);
          if (target !== undefined) {
            const previous = writable.externalCuration.find(
              (group: Loose) => group.framework === target.framework,
            );
            if (!previous) return CURATION_LOST_MESSAGE;
            previous.items = previous.items.filter(
              (item: Loose) => item.kind !== target.kind || item.id !== target.id,
            );
            writable.externalCuration = writable.externalCuration.filter(
              (group: Loose) => group.items.length > 0,
            );
          }
          let group = writable.externalCuration.find(
            (entry: Loose) => entry.framework === values.framework,
          );
          if (!group) {
            group = { framework: values.framework, items: [] };
            writable.externalCuration.push(group);
          }
          if (group.items.some((item: Loose) => item.kind === values.kind && item.id === values.id))
            return CURATION_DUPLICATE_MESSAGE;
          group.items.push({
            kind: values.kind,
            id: values.id,
            accountableOwner: values.accountableOwner,
            source: {
              repository: values.repository,
              commit: values.commit,
              path: values.path,
            },
            audit: { record: values.auditRecord, digest: values.auditDigest },
            ...(values.clarification ? { clarification: values.clarification } : {}),
          });
          return undefined;
        }, message).outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The curation change was rejected.") };
      }
    },

    // acme-screen.ts lines 1017-1032.
    removeCuration(target) {
      try {
        return commit((draft: Loose) => {
          const writable = writableGovernance(draft);
          const group = writable.externalCuration.find(
            (entry: Loose) => entry.framework === target.framework,
          );
          if (!group) return undefined;
          group.items = group.items.filter(
            (entry: Loose) => entry.id !== target.id || entry.kind !== target.kind,
          );
          writable.externalCuration = writable.externalCuration.filter(
            (entry: Loose) => entry.items.length > 0,
          );
          return undefined;
        }, CURATION_REMOVED_MESSAGE).outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The curation change was rejected.") };
      }
    },

    // acme-screen.ts lines 848-902.
    addCustomMcp(input) {
      try {
        const id = text(input.id).trim();
        const packageName = text(input.packageName).trim();
        const version = text(input.version).trim();
        const integrity = text(input.integrity).trim();
        const evidence = text(input.evidence).trim();
        const note = text(input.clarification).trim();
        const owner = text(input.accountableOwner).trim();
        if (!EMAIL.test(owner))
          return {
            ok: false,
            message: CUSTOM_OWNER_MESSAGE,
            fieldErrors: [{ field: "custom-owner", message: CUSTOM_OWNER_FIELD_MESSAGE }],
          };
        if (list(governance().catalog?.custom).some((candidate: Loose) => candidate.id === id))
          return { ok: false, message: CUSTOM_DUPLICATE_MESSAGE };
        const done = commit((draft: Loose) => {
          writableGovernance(draft).catalog.custom.push({
            id,
            kind: "mcp",
            accountableOwner: owner,
            description: "Pending custom MCP",
            capabilities: [],
            risks: ["custom source"],
            source: {
              type: "stdio",
              resolver: "npx",
              registry: "https://registry.npmjs.org",
              package: packageName,
              version,
              integrity,
            },
            targets: ["claude"],
            projector: "mcp-managed-settings",
            lifecycle: "supported",
            evidence: { record: evidence },
            findings: [],
            autoExecute: false,
            ...(note ? { clarification: note } : {}),
          });
          return undefined;
        }, CUSTOM_ADDED_MESSAGE);
        if (done.committed) return done.outcome;
        // The hand-built page names the one field a refusal is usually about.
        return /[\p{C}]/u.test(note)
          ? {
              ...done.outcome,
              fieldErrors: [{ field: "custom-note", message: CUSTOM_NOTE_FIELD_MESSAGE }],
            }
          : done.outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The custom MCP was rejected.") };
      }
    },

    // acme-screen.ts lines 904-996.
    saveRemoteMcp(input) {
      try {
        const id = text(input.id).trim();
        const approvedBy = text(input.approvedBy).trim();
        const authenticationMode = text(input.authenticationMode).trim();
        const dataClasses = dataClassList(input.allowedDataClasses);
        const administrativeStatus = text(input.administrativeStatus);
        const evidence = text(input.evidence).trim();
        const clarification = text(input.clarification).trim();
        const originUrl = exactHttpsOrigin(text(input.origin).trim());
        if (
          !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
          originUrl === null ||
          !EMAIL.test(approvedBy) ||
          !authenticationMode ||
          !dataClasses.length ||
          !/^(approved|revoked)$/.test(administrativeStatus) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(evidence) ||
          (clarification !== "" && /[\p{C}]/u.test(clarification))
        )
          return {
            ok: false,
            message: REMOTE_INVALID_MESSAGE,
            // The hand-built form clears the origin error when the origin is
            // the one thing that is right (lines 944-949).
            fieldErrors:
              originUrl === null
                ? [{ field: "remote-custom-origin", message: REMOTE_ORIGIN_FIELD_MESSAGE }]
                : [{ field: "remote-custom-origin", message: "" }],
          };
        const existing = list(governance().catalog?.custom).findIndex(
          (entry: Loose) => entry.id === id,
        );
        if (
          existing !== -1 &&
          list(governance().catalog?.custom)[existing].source?.type !== "remote"
        )
          return { ok: false, message: CUSTOM_DUPLICATE_MESSAGE };
        const candidate = {
          id,
          kind: "mcp",
          description: "Pending remote custom MCP",
          capabilities: [],
          risks: ["hosted endpoint"],
          source: {
            type: "remote",
            origin: originUrl.origin,
            approval: { approvedBy, authenticationMode, allowedDataClasses: dataClasses },
            administrativeStatus,
            contentScanned: false,
          },
          targets: ["claude"],
          projector: "mcp-managed-settings",
          lifecycle: "supported",
          evidence: { record: evidence },
          findings: [],
          autoExecute: false,
          ...(clarification ? { clarification } : {}),
        };
        return commit((draft: Loose) => {
          const writable = writableGovernance(draft);
          if (existing === -1) writable.catalog.custom.push(candidate);
          else writable.catalog.custom[existing] = candidate;
          return undefined;
        }, REMOTE_RECORDED_MESSAGE).outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The remote MCP was rejected.") };
      }
    },

    // acme-screen.ts lines 1056-1075.
    removeCustomCandidate(id, kind) {
      try {
        const index = list(governance().catalog?.custom).findIndex(
          (candidate: Loose) =>
            candidate.id === id &&
            (kind === "remote") === (candidate.source && candidate.source.type === "remote"),
        );
        if (index === -1) return { ok: false, message: `Unknown custom candidate: ${id}` };
        return commit((draft: Loose) => {
          writableGovernance(draft).catalog.custom.splice(index, 1);
          return undefined;
        }, CUSTOM_REMOVED_MESSAGE).outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The custom candidate was kept.") };
      }
    },

    readPreservedRemote() {
      return { ok: true, message: REMOTE_READ_ONLY_MESSAGE };
    },

    // acme-screen.ts lines 669-682.
    removeEccMcpApproval(id) {
      try {
        return commit((draft: Loose) => {
          const writable = writableGovernance(draft);
          writable.eccMcpApprovals = list(writable.eccMcpApprovals).filter(
            (entry: Loose) => entry.id !== id,
          );
          return undefined;
        }, `ECC MCP approval removed for ${id}.`).outcome;
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The approval was kept.") };
      }
    },

    // acme-screen.ts lines 655-668: an unknown id changes nothing.
    selectEccMcp(id) {
      const pinned = list(catalog.externalMcp).some((entry: Loose) => entry.id === id);
      return pinned
        ? {
            ok: true,
            message: `ECC MCP ${id} selected for approval authoring only; it is not installed or contacted.`,
          }
        : { ok: false, message: `Unknown pinned ECC MCP: ${id}` };
    },
  };
}
