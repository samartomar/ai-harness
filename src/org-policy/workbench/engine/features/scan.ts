import { parseNativeStrictJsonObjectV1 } from "../../../../contract/native-strict-json-object-v1.js";
import { policySchemaErrors } from "../../schema-validation.js";
import { decisionProblems } from "../../ui/decision-json.js";
import {
  DECISION_FILENAME,
  decisionFileText,
  MAX_IMPORT_BYTES,
} from "../../ui/shell/download-format.js";
import {
  type ScanGlance,
  type ScanReceiptRowV1,
  scanDecisionExportV1,
  scanDecisionLinesV1,
  scanGlanceV1,
  scanReceiptRowsV1,
} from "../scan-presentation.js";
import {
  type EngineFile,
  type EngineOutcome,
  type EngineResult,
  errorMessage,
  record,
  utf8ByteLength,
} from "../shared.js";
import type { AdminEngineContext } from "./context.js";

/** `file-transfer.ts` lines 274-276 and 317, verbatim. */
const EVIDENCE_PRESERVED_MESSAGE =
  "Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.";
const DECISION_IMPORTED_MESSAGE =
  "Decision imported for inspection only: unverified and not effective.";

/**
 * Everything the scan view renders, already in the words the hand-built scan
 * screen uses (`ui/shell/scan-screen.ts` lines 454-527). The view formats
 * nothing: it places these strings as text.
 */
export interface AdminScanV1 {
  /** The catalog's report totals; absent when the prepared catalog is invalid. */
  readonly glance?: ScanGlance;
  /** The sentence the masthead shows in place of the totals. */
  readonly glanceUnavailable?: string;
  readonly findings: {
    readonly dispositionable: readonly string[];
    readonly fenced: readonly string[];
  };
  readonly receiptRows: readonly ScanReceiptRowV1[];
  /** The receipt card's state sentence, imported or not. */
  readonly receiptState: string;
  /** The preserved receipt, pretty-printed; absent when nothing was imported. */
  readonly receiptText?: string;
  readonly decisionState: string;
  /** The imported decision, field by field, and its canonical export text. */
  readonly decision?: { readonly lines: string; readonly exportText: string };
}

/** The scan view's feature: the evidence receipt, the decision, and the view. */
export interface ScanFeature {
  /**
   * Preserve an imported authority/audit receipt for preflight inspection
   * (`ui/shell/file-transfer.ts` lines 266-281). Nothing is verified and no
   * approval becomes effective.
   */
  importEvidenceText(text: string): EngineOutcome;
  /**
   * Import a governance decision for inspection only (`file-transfer.ts`
   * lines 288-329). A rejected import keeps the PRIOR decision.
   */
  importDecisionText(text: string): EngineOutcome;
  /** The canonical decision file; refused while no decision is imported. */
  downloadDecision(): EngineResult<EngineFile>;
  /** Everything the scan view shows; a fresh read each call. */
  scan(): AdminScanV1;
}

export function scanFeature(ctx: AdminEngineContext): ScanFeature {
  const active = ctx.active;
  return {
    // file-transfer.ts lines 266-281, with the byte gate `readImportFile`
    // applies (lines 43-46). Host file reading stays with the host.
    importEvidenceText(text) {
      try {
        if (typeof text !== "string" || utf8ByteLength(text) > MAX_IMPORT_BYTES)
          return { ok: false, message: "Import rejected: file exceeds the 1 MiB limit." };
        const parsed = parseNativeStrictJsonObjectV1(text, "file import");
        active.setReceipt(parsed);
        return { ok: true, message: EVIDENCE_PRESERVED_MESSAGE };
      } catch {
        return { ok: false, message: "Evidence import failed: valid JSON object required." };
      }
    },

    // file-transfer.ts lines 288-329: the size gate, the decision problems,
    // and a rejection that restores the decision that was there before.
    importDecisionText(text) {
      const prior = active.decision() === null ? null : structuredClone(active.decision());
      try {
        if (typeof text !== "string" || utf8ByteLength(text) > MAX_IMPORT_BYTES)
          return { ok: false, message: "Decision import rejected: file exceeds the 1 MiB limit." };
        const parsed = parseNativeStrictJsonObjectV1(text, "decision import");
        const problems = decisionProblems(parsed, ctx.model.decisionSchema, policySchemaErrors);
        if (problems.length) throw new Error(problems.slice(0, 3).join("; "));
        active.setDecision(structuredClone(parsed));
        return { ok: true, message: DECISION_IMPORTED_MESSAGE };
      } catch (error) {
        active.setDecision(prior);
        return {
          ok: false,
          message: `Decision import rejected: ${errorMessage(error, "strict decision JSON required")}`,
        };
      }
    },

    // file-transfer.ts lines 330-335. The hand-built control is disabled
    // while no decision exists; the engine refuses it as well.
    downloadDecision() {
      const decision = active.decision();
      if (decision === null || decision === undefined)
        return { ok: false, errors: ["No decision is imported."] };
      return { ok: true, value: { name: DECISION_FILENAME, text: decisionFileText(decision) } };
    },

    scan() {
      const receipt = active.receipt();
      const decision = record(active.decision());
      const totals = ctx.bundle === undefined ? undefined : scanGlanceV1(ctx.bundle);
      return {
        ...(totals === undefined
          ? { glanceUnavailable: "Prepared catalog unavailable: no report totals." }
          : { glance: totals }),
        findings: {
          dispositionable: ctx.findingKinds("dispositionable"),
          fenced: ctx.findingKinds("fenced"),
        },
        receiptRows: scanReceiptRowsV1(receipt),
        receiptState:
          receipt === null || receipt === undefined
            ? "No authority receipt imported."
            : "Receipt preserved for preflight only; this browser does not verify it or create effective approval.",
        ...(receipt === null || receipt === undefined
          ? {}
          : { receiptText: JSON.stringify(receipt, null, 2) }),
        decisionState:
          decision === undefined
            ? "No standalone decision imported."
            : "Decision imported for inspection only: unverified and not effective. It does not change policy, receipt, or authority state.",
        ...(decision === undefined
          ? {}
          : {
              decision: {
                lines: scanDecisionLinesV1(decision),
                exportText: scanDecisionExportV1(decision),
              },
            }),
      };
    },
  };
}
