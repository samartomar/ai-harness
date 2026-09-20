import { type ChangeEvent, useId, useState } from "react";
import type { AdminEngine, EngineOutcome } from "../../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON } from "../chrome.js";

/**
 * Editor 21: the import migration message and preview for schema-2 policies
 * (`ui/shell/policy-session.ts` `importPolicy`, which returns the grammar's
 * migration message, and `ui/schema3-reprojection.ts`, which re-projects the
 * result). The engine's `importPolicyText` already returns that exact message
 * and `state().policyText` is the migrated preview, byte for byte: this editor
 * shows both together, as text, so a migration is read before it is kept.
 *
 * A refused import keeps the policy; the refusal is shown, and the preview
 * that stays on screen is the unchanged policy.
 */

export const MIGRATION_TITLE = "Import a policy";
const FIELD_LABEL = "Import policy for migration";
const PREVIEW_LABEL = "Migrated policy preview";
const IDLE = "No policy has been imported in this session.";

export function ImportMigration({
  engine,
  policyText,
  importInto,
}: {
  readonly engine: AdminEngine;
  readonly policyText: string;
  readonly importInto: (
    event: ChangeEvent<HTMLInputElement>,
    call: (text: string) => EngineOutcome,
  ) => Promise<void>;
}) {
  const inputId = useId();
  const previewId = useId();
  const [outcome, setOutcome] = useState<EngineOutcome | undefined>(undefined);
  return (
    <section aria-label={MIGRATION_TITLE} className="space-y-1.5">
      <h3 className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {MIGRATION_TITLE}
      </h3>
      <label className={`${SECONDARY_BUTTON} cursor-pointer inline-block`} htmlFor={inputId}>
        {FIELD_LABEL}
      </label>
      <input
        accept="application/json"
        className="sr-only"
        id={inputId}
        onChange={(event) => {
          void importInto(event, (text) => {
            const result = engine.importPolicyText(text);
            setOutcome(result);
            return result;
          });
        }}
        type="file"
      />
      {/* The migration message, exactly as the engine returned it. The page's
       * status strip already announces it, so this copy is plain text: a
       * second live region in the same dialog would announce it twice. */}
      <p className="text-on-surface-variant empty:hidden">
        {outcome?.ok === true ? outcome.message : ""}
      </p>
      <p className="text-tertiary empty:hidden">{outcome?.ok === false ? outcome.message : ""}</p>
      {outcome === undefined ? <p className="text-outline">{IDLE}</p> : null}
      <label
        className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-outline font-semibold"
        htmlFor={previewId}
      >
        {PREVIEW_LABEL}
        <textarea
          className="h-40 w-full p-2 rounded bg-[#141822] border border-surface-container-high/60 font-mono text-[11px] text-on-surface normal-case tracking-normal"
          id={previewId}
          readOnly
          value={policyText}
        />
      </label>
    </section>
  );
}
