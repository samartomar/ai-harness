/**
 * Lane E of the editor port: artifact intake (row 22), GitHub Skill intake
 * (row 18) and protected bundle authoring (row 23) of the acceptance rule's
 * section 7 inventory.
 *
 * Behaviour source: `ui/artifact-intake-runtime.js` and
 * `studio-protected-authority-runtime.js`. Every message below is that page's
 * own text. Pure, like everything under `engine/`: file reading, the local
 * server call and SHA-256 stay with the host.
 */

import { policySchemaErrors } from "../../schema-validation.js";
import { canonicalJson } from "../../ui/artifact-intake-serialization.js";
import {
  ARTIFACT_INTAKE_FILENAME,
  jsonFileText,
  PROTECTED_BUNDLE_FILENAME,
} from "../../ui/shell/download-format.js";
import {
  protectedCanonicalTimestamp,
  protectedDigestPreimage,
  protectedStrictStrings,
} from "../../ui/shell/protected-digest.js";
import type { EngineFile, EngineOutcome, EngineResult } from "../shared.js";
import { errorMessage } from "../shared.js";
import { strictJson, validateIntake } from "./artifact-intake-validation.js";
import type { AdminEngineContext } from "./context.js";
import {
  connectedSkillPinV1,
  parseSkillDiscoveryV1,
  type SkillDiscoveryV1,
} from "./github-skill-discovery.js";
import {
  PROTECTED_FIELD_IDS,
  type ProtectedDecisionV1,
  type ProtectedDigestFn,
  type ProtectedFieldsV1,
  type ProtectedRevocationV1,
  protectedBuildBundleV1,
  protectedBuildDecisionV1,
  protectedIssuesV1,
  protectedSourceLabelV1,
  protectedValuesV1,
} from "./protected-authority-model.js";

/* ── Row 22: artifact intake ─────────────────────────────────────────────── */

/** `artifact-intake-runtime.js` lines 95-96 and 125-126, verbatim. */
const INTAKE_IMPORTED_MESSAGE =
  "Non-authoritative artifact intake imported. Imported evidence drafts were preserved without verification.";
const INTAKE_ITEM_ADDED_MESSAGE =
  "Non-authoritative candidate added to the shared review queue. Add another item or download one intake file.";
const INTAKE_DOWNLOAD_MESSAGE = "Artifact intake download started.";
const INTAKE_EMPTY_SUMMARY =
  "0 / 100 candidates · no intake loaded. Add an item or import one file.";
const INTAKE_QUEUE_FULL = "the review queue already contains 100 candidates";
/**
 * The badge a queued item carries while no imported-evidence draft is
 * retained. Draft retention itself is NOT ported: it needs SHA-256 and base64,
 * which the engine's host contract does not give it, so it stays on the
 * hand-built page until the host owns that step.
 */
const INTAKE_NO_DRAFT_BADGE = "No imported evidence draft · Authority absent";
const MAX_INTAKE_ITEMS = 100;

/** The add form's fields, as the review queue's own controls hold them. */
export interface IntakeDraftV1 {
  readonly defaultOwner: string;
  readonly kind: string;
  readonly id: string;
  readonly discoveryUrl: string;
  readonly sourceType: string;
  readonly npmPackage: string;
  readonly npmVersion: string;
  readonly npmIntegrity: string;
  readonly githubRepository: string;
  readonly githubCommit: string;
  readonly sourcePath: string;
  readonly directoryUrl: string;
}

/** One row of the review queue, in the words the hand-built page uses. */
export interface IntakeRowV1 {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly owner: string;
  readonly badge: string;
  /** The lower-case text the queue filter matches, as the page built it. */
  readonly search: string;
}

/** Everything the review queue renders; a fresh read each call. */
export interface AdminIntakeV1 {
  readonly candidateCount: string;
  readonly summary: string;
  readonly rows: readonly IntakeRowV1[];
  /** True while there is nothing to download. */
  readonly downloadDisabled: boolean;
}

type Loose = Record<string, unknown>;

function intakeItemSource(draft: IntakeDraftV1): Loose {
  if (draft.sourceType === "directory")
    return {
      type: "directory",
      provider: draft.directoryUrl.indexOf("pulsemcp.com/") !== -1 ? "pulsemcp" : "mcpmarket",
      url: draft.directoryUrl,
    };
  if (draft.sourceType === "npm") {
    const source: Loose = {
      type: "npm",
      registry: "https://registry.npmjs.org",
      package: draft.npmPackage,
      version: draft.npmVersion,
    };
    if (draft.npmIntegrity) source.integrity = draft.npmIntegrity;
    return source;
  }
  return {
    type: "github",
    repository: draft.githubRepository,
    commit: draft.githubCommit,
    path: draft.sourcePath,
  };
}

/** Legacy `sourceText`. */
function intakeSourceText(item: Loose): string {
  const source = item.source as Loose;
  if (source.type === "directory") return `Directory claim · ${String(source.url)}`;
  return source.type === "npm"
    ? `${String(source.package)}@${String(source.version)}`
    : `${String(source.repository)}@${String(source.commit).slice(0, 12)} / ${String(source.path)}`;
}

/** Legacy `acquisitionSource`: what makes two queued items one scan. */
function acquisitionSource(item: Loose): Loose {
  const source = item.source as Loose;
  if (source.type === "directory") return source;
  if (source.type === "github")
    return { type: source.type, repository: source.repository, commit: source.commit };
  const result: Loose = {
    type: source.type,
    registry: source.registry,
    package: source.package,
    version: source.version,
  };
  if (source.integrity !== undefined) result.integrity = source.integrity;
  return result;
}

/* ── Row 23: protected bundle authoring ──────────────────────────────────── */

/** `studio-protected-authority-runtime.js` lines 761, 1078-1080, 1112, 1150, 1167, 1184. */
const PROTECTED_CORRECT_FIELDS_MESSAGE = "Correct the highlighted protected policy fields.";
const PROTECTED_READY_MESSAGE =
  "The protected policy file is ready. Any generated organization evidence envelope is separate; Core must still verify both exact byte streams and current authority before effects.";
const PROTECTED_REMOVED_MESSAGE = "Exact artifact approval removed from the generated file.";
const PROTECTED_REVOKED_MESSAGE =
  "The decision revocation is included in the protected policy file.";
const PROTECTED_DOWNLOAD_MESSAGE =
  "Protected policy file download started. Place it at an administrator-controlled read-only path.";
const PROTECTED_NEEDS_DECISION_MESSAGE =
  "Add at least one exact artifact approval before download.";
const PROTECTED_REFUSED_PREFIX = "Protected policy generation refused: ";
const PROTECTED_REFUSED_FALLBACK = "valid form fields are required";

/**
 * A protected outcome carries the per-field refusals as well as the sentence,
 * so the page can put each message beside its own control, as the hand-built
 * form does. `issues` is empty unless the form itself was refused.
 */
export interface ProtectedOutcomeV1 extends EngineOutcome {
  readonly issues: Readonly<Record<string, string>>;
}

/** One row under the protected form: what was approved, and how it reads. */
export interface ProtectedDecisionRowV1 {
  readonly id: string;
  readonly summary: string;
}

/** Everything the protected authoring panel renders. */
export interface AdminProtectedV1 {
  readonly rows: readonly ProtectedDecisionRowV1[];
  /** The read-only preview, exactly the bytes that would download. */
  readonly bundlePreview: string;
  readonly downloadDisabled: boolean;
  readonly revocationCount: number;
  /** Pinned as the hand-built page behaves: no envelope is ever generated. */
  readonly evidencePreview: string;
  readonly evidenceDownloadDisabled: boolean;
}

/** The feature Lane E adds: intake, connected Skill intake, protected authoring. */
export interface IntakeAuthorityFeature {
  /* Row 22 */
  /** Import one `aih-artifact-intake` file; a rejection keeps the queue. */
  importIntakeText(text: string): EngineOutcome;
  /** Add one exact source (or directory claim) to the shared review queue. */
  addIntakeItem(draft: IntakeDraftV1): EngineOutcome;
  /** Remove the queued item at `index`; an unknown index changes nothing. */
  removeIntakeItem(index: number): EngineOutcome;
  /** True while `addIntakeItem` would be accepted, for the control's state. */
  intakeDraftReady(draft: IntakeDraftV1): boolean;
  /** The intake file; refused while the queue is empty. */
  downloadIntake(): EngineResult<EngineFile>;
  /** Everything the review queue shows; a fresh read each call. */
  intake(): AdminIntakeV1;

  /* Row 18 */
  /** Read a pasted Skill link or `npx skills add` command, locally and offline. */
  parseSkillDiscovery(raw: string): EngineResult<SkillDiscoveryV1>;
  /** Judge what the host's connected resolver brought back. Untrusted data. */
  checkConnectedSkillPin(
    value: unknown,
    parsed: SkillDiscoveryV1,
  ): EngineResult<{ readonly commit: string; readonly path: string }>;

  /* Row 23 */
  /** Add one exact artifact approval. The host supplies every digest. */
  addProtectedDecision(
    fields: ProtectedFieldsV1,
    digest: ProtectedDigestFn,
  ): Promise<ProtectedOutcomeV1>;
  /** Remove the approval at `index`, with any revocation that named it. */
  removeProtectedDecision(
    index: number,
    fields: ProtectedFieldsV1,
    digest: ProtectedDigestFn,
  ): Promise<ProtectedOutcomeV1>;
  /** Record a revocation of the approval at `index`. */
  revokeProtectedDecision(
    index: number,
    fields: ProtectedFieldsV1,
    digest: ProtectedDigestFn,
  ): Promise<ProtectedOutcomeV1>;
  /** The protected bundle file; refused, with its issues, when the form is not ready. */
  downloadProtectedBundle(
    fields: ProtectedFieldsV1,
  ): Promise<EngineResult<EngineFile> & { readonly issues: Readonly<Record<string, string>> }>;
  /** Everything the protected panel shows; a fresh read each call. */
  protectedAuthoring(): AdminProtectedV1;
  /** The protected form's field ids, in the hand-built page's order. */
  protectedFieldIds(): readonly string[];
}

export function intakeAuthorityFeature(ctx: AdminEngineContext): IntakeAuthorityFeature {
  let intake: Loose | undefined;
  let decisions: ProtectedDecisionV1[] = [];
  let revocations: ProtectedRevocationV1[] = [];
  let authority: { issuer: string; issuerRepository: string } | undefined;
  let bundle: Loose | undefined;

  const items = (): Loose[] => (intake === undefined ? [] : (intake.items as Loose[]));

  const refuse = (prefix: string, error: unknown, fallback: string): EngineOutcome => ({
    ok: false,
    message: `${prefix}${errorMessage(error, fallback)}`,
  });

  /** The policy the bundle carries, and the one `protectedIssues` judges. */
  const policyRecord = (): Loose => {
    const policy = ctx.active.snapshotPolicy();
    return policy !== null && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Loose)
      : {};
  };

  const issuesContext = () => ({
    policy: policyRecord(),
    approverEmailPattern: String(
      (ctx.model.semantics as Loose | undefined)?.approverEmailPattern ?? "^[^\\s@]+@[^\\s@]+$",
    ),
    decisions,
    authority,
  });

  /** Legacy `protectedRefresh`: build, check strict strings and the Core schema. */
  const refreshBundle = (fields: ProtectedFieldsV1): Loose => {
    const built = protectedBuildBundleV1(
      protectedValuesV1(fields),
      policyRecord(),
      decisions,
      revocations,
    );
    protectedStrictStrings(built, "bundle");
    const problems = policySchemaErrors(ctx.model.protectedBundleSchema, built, "bundle");
    if (problems.length)
      throw new Error(
        `Generated file failed the embedded Core schema: ${problems.slice(0, 3).join("; ")}`,
      );
    bundle = built;
    return built;
  };

  /**
   * Legacy `protectedIssues` for an operation that is not adding a decision:
   * the decision identifier is not being proposed, so its issue is dropped.
   */
  const issuesWithoutDecisionId = (fields: ProtectedFieldsV1): Record<string, string> => {
    const values = { ...protectedValuesV1(fields), decisionId: "decision-placeholder" };
    const issues = protectedIssuesV1(values, issuesContext());
    delete issues["protected-decision-id"];
    return issues;
  };

  const protectedRefusal = (issues: Record<string, string>): ProtectedOutcomeV1 => ({
    ok: false,
    message: PROTECTED_CORRECT_FIELDS_MESSAGE,
    issues,
  });

  const protectedFailure = (error: unknown): ProtectedOutcomeV1 => ({
    ok: false,
    message: `${PROTECTED_REFUSED_PREFIX}${errorMessage(error, PROTECTED_REFUSED_FALLBACK)}`,
    issues: {},
  });

  return {
    // artifact-intake-runtime.js line 95. A rejected import keeps the queue.
    importIntakeText(text) {
      try {
        intake = structuredClone(
          validateIntake(strictJson(text, "artifact intake")),
        ) as unknown as Loose;
        return { ok: true, message: INTAKE_IMPORTED_MESSAGE };
      } catch (error) {
        return refuse("Artifact intake rejected: ", error, "invalid intake");
      }
    },

    // artifact-intake-runtime.js line 125, including the queue ceiling and the
    // version-2 promotion a directory claim forces.
    addIntakeItem(draft) {
      try {
        if (intake !== undefined && items().length >= MAX_INTAKE_ITEMS)
          throw new Error(INTAKE_QUEUE_FULL);
        const item: Loose = { id: draft.id, kind: draft.kind, source: intakeItemSource(draft) };
        if (draft.discoveryUrl) item.discoveryUrl = draft.discoveryUrl;
        const candidate =
          intake === undefined
            ? {
                format: "aih-artifact-intake",
                version: draft.sourceType === "directory" ? 2 : 1,
                authority: { state: "not-authority" },
                defaults: { accountableOwner: draft.defaultOwner },
                items: [] as Loose[],
              }
            : (structuredClone(intake) as Loose);
        if (draft.sourceType === "directory") candidate.version = 2;
        candidate.authority = { state: "not-authority" };
        candidate.defaults = { accountableOwner: draft.defaultOwner };
        (candidate.items as Loose[]).push(item);
        intake = validateIntake(candidate) as Loose;
        return { ok: true, message: INTAKE_ITEM_ADDED_MESSAGE };
      } catch (error) {
        return refuse("Artifact was not added: ", error, "invalid item");
      }
    },

    removeIntakeItem(index) {
      const current = items();
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return { ok: false, message: "Artifact was not added: invalid item" };
      current.splice(index, 1);
      if (current.length === 0) intake = undefined;
      return { ok: true, message: INTAKE_ITEM_ADDED_MESSAGE };
    },

    // Legacy `artifactDraftReady`: the same construction, judged silently.
    intakeDraftReady(draft) {
      try {
        if (items().length >= MAX_INTAKE_ITEMS) return false;
        const item: Loose = { id: draft.id, kind: draft.kind, source: intakeItemSource(draft) };
        if (draft.discoveryUrl) item.discoveryUrl = draft.discoveryUrl;
        validateIntake({
          format: "aih-artifact-intake",
          version: draft.sourceType === "directory" ? 2 : 1,
          authority: { state: "not-authority" },
          defaults: { accountableOwner: draft.defaultOwner },
          items: [item],
        });
        return true;
      } catch {
        return false;
      }
    },

    // artifact-intake-runtime.js line 126: two-space JSON plus a newline.
    downloadIntake() {
      if (intake === undefined) return { ok: false, errors: ["No artifact intake is queued."] };
      return {
        ok: true,
        value: { name: ARTIFACT_INTAKE_FILENAME, text: jsonFileText(intake) },
      };
    },

    intake() {
      const current = items();
      const defaults = (intake?.defaults as Loose | undefined) ?? {};
      const badge = INTAKE_NO_DRAFT_BADGE;
      const groups = new Set(
        current.map((item) => canonicalJson(acquisitionSource(item) as never)),
      );
      const rows = current.map((item) => {
        const owner = String(item.accountableOwner ?? defaults.accountableOwner ?? "");
        const source = intakeSourceText(item);
        const title = `${String(item.kind).toUpperCase()} · ${String(item.id)}`;
        const ownerLine = `Accountable owner: ${owner} · Intake is not authority`;
        return {
          id: String(item.id),
          title,
          source,
          owner: ownerLine,
          badge,
          search:
            `${String(item.kind)} ${String(item.id)} ${source} ${owner} ${title}${source}${ownerLine} ${badge} draft no authority`.toLowerCase(),
        };
      });
      return {
        candidateCount: `${String(current.length)} / ${String(MAX_INTAKE_ITEMS)} candidates`,
        summary:
          intake === undefined
            ? INTAKE_EMPTY_SUMMARY
            : `${String(current.length)} / ${String(MAX_INTAKE_ITEMS)} candidates · ${String(groups.size)} unique exact source${groups.size === 1 ? "" : "s"}. Imported scanner files remain opaque drafts until Core prepares evidence.`,
        rows,
        downloadDisabled: intake === undefined,
      };
    },

    parseSkillDiscovery(raw) {
      try {
        return { ok: true, value: parseSkillDiscoveryV1(raw) };
      } catch (error) {
        return { ok: false, errors: [errorMessage(error, "invalid discovery input")] };
      }
    },

    checkConnectedSkillPin(value, parsed) {
      try {
        return { ok: true, value: connectedSkillPinV1(value, parsed) };
      } catch (error) {
        return {
          ok: false,
          errors: [errorMessage(error, "connected Skill resolver returned an invalid result")],
        };
      }
    },

    // studio-protected-authority-runtime.js lines 1040-1082: refuse the form,
    // or build the decision and roll it back if the file stops validating.
    async addProtectedDecision(fields, digest) {
      const values = protectedValuesV1(fields);
      const issues = protectedIssuesV1(values, issuesContext());
      if (Object.keys(issues).length) return protectedRefusal(issues);
      try {
        const decision = await protectedBuildDecisionV1(values, digest);
        decisions = [...decisions, decision];
        const priorAuthority = authority;
        authority = authority ?? {
          issuer: values.issuer,
          issuerRepository: values.issuerRepository,
        };
        try {
          refreshBundle(fields);
        } catch (error) {
          decisions = decisions.slice(0, -1);
          authority = decisions.length ? priorAuthority : undefined;
          throw error;
        }
        return { ok: true, message: PROTECTED_READY_MESSAGE, issues: {} };
      } catch (error) {
        return protectedFailure(error);
      }
    },

    // Lines 1088-1114: the removed decision's revocations go with it.
    async removeProtectedDecision(index, fields, digest) {
      const decision = decisions[index];
      if (!Number.isInteger(index) || decision === undefined)
        return { ok: false, message: PROTECTED_NEEDS_DECISION_MESSAGE, issues: {} };
      try {
        const removedDigest = await digest(protectedDigestPreimageOf(decision));
        decisions = decisions.filter((_item, at) => at !== index);
        revocations = revocations.filter((item) => item.decisionDigest !== removedDigest);
        if (decisions.length) refreshBundle(fields);
        else {
          bundle = undefined;
          authority = undefined;
        }
        return { ok: true, message: PROTECTED_REMOVED_MESSAGE, issues: {} };
      } catch (error) {
        return protectedFailure(error);
      }
    },

    // Lines 1116-1153: a revocation needs a valid form, minus the decision id.
    async revokeProtectedDecision(index, fields, digest) {
      const decision = decisions[index];
      if (decision === undefined)
        return { ok: false, message: PROTECTED_NEEDS_DECISION_MESSAGE, issues: {} };
      const issues = issuesWithoutDecisionId(fields);
      if (Object.keys(issues).length) return protectedRefusal(issues);
      try {
        const values = protectedValuesV1(fields);
        const decisionDigest = await digest(protectedDigestPreimageOf(decision));
        if (!revocations.some((item) => item.decisionDigest === decisionDigest))
          revocations = [
            ...revocations,
            {
              format: "aih-governance-decision-revocation",
              version: 2,
              decisionDigest,
              issuer: decision.issuer,
              revokedAt: canonicalIssuedAt(values.issuedAt),
              reason: "Revoked by the accountable administrator in Policy Workbench",
            },
          ];
        refreshBundle(fields);
        return { ok: true, message: PROTECTED_REVOKED_MESSAGE, issues: {} };
      } catch (error) {
        return protectedFailure(error);
      }
    },

    // Lines 1155-1187. Nothing is handed to the host while anything is refused.
    async downloadProtectedBundle(fields) {
      const issues = issuesWithoutDecisionId(fields);
      if (Object.keys(issues).length)
        return { ok: false, errors: [PROTECTED_CORRECT_FIELDS_MESSAGE], issues };
      if (decisions.length === 0)
        return { ok: false, errors: [PROTECTED_NEEDS_DECISION_MESSAGE], issues: {} };
      try {
        const built = refreshBundle(fields);
        return {
          ok: true,
          value: { name: PROTECTED_BUNDLE_FILENAME, text: jsonFileText(built) },
          issues: {},
        };
      } catch (error) {
        return {
          ok: false,
          errors: [`${PROTECTED_REFUSED_PREFIX}${errorMessage(error, PROTECTED_REFUSED_FALLBACK)}`],
          issues: {},
        };
      }
    },

    protectedAuthoring() {
      return {
        rows: decisions.map((decision) => {
          const subject = decision.subject;
          const base = `${String(subject.kind)} ${String(subject.id)} at ${protectedSourceLabelV1(subject.source as Loose)}`;
          return {
            id: decision.id,
            summary:
              decision.disposition === "accepted-with-conditions"
                ? `${base} · accepted with conditions through ${String(decision.reviewBy)} · findings: ${(decision.acceptedFindings as string[]).join(", ")} · gaps: ${(decision.acceptedGaps as string[]).join(", ")} · conditions: ${(decision.conditions as string[]).join("; ")}`
                : `${base} · approved`,
          };
        }),
        bundlePreview: bundle === undefined ? "" : jsonFileText(bundle),
        downloadDisabled: bundle === undefined,
        revocationCount: revocations.length,
        // The hand-built runtime never builds an envelope (`evidenceEnvelope`
        // is always null), so this control never becomes available.
        evidencePreview: "",
        evidenceDownloadDisabled: true,
      };
    },

    protectedFieldIds() {
      return PROTECTED_FIELD_IDS;
    },
  };
}

/**
 * The two announcements that follow a HOST step (the file was handed over), so
 * the page shows the hand-built page's words there too.
 */
export const INTAKE_DOWNLOAD_STARTED_MESSAGE = INTAKE_DOWNLOAD_MESSAGE;
export const PROTECTED_DOWNLOAD_STARTED_MESSAGE = PROTECTED_DOWNLOAD_MESSAGE;

const canonicalIssuedAt = (value: string): string => protectedCanonicalTimestamp(value);
const protectedDigestPreimageOf = (decision: ProtectedDecisionV1): string =>
  protectedDigestPreimage("decision", decision);
