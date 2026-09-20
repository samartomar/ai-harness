import { useState } from "react";
import type { AdminEngine } from "../../../src/org-policy/workbench/engine/index.js";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * Editor 20a: starting points (`ui/catalog-inventory.ts` `renderTemplates`,
 * lines 3135-3214, and `showTemplatePreview`, lines 3036-3134). Nothing is
 * added until the preview has been read and "Add to draft" is pressed.
 */

export const STARTING_POINTS_TITLE = "Starting points";
const PREVIEW_LABEL = "Preview";
const CANCEL_LABEL = "Cancel preview";
const ADD_LABEL = "Add to draft";
const NONE = "No starting point applies to the current catalog.";

export function StartingPoints({
  engine,
  run,
}: {
  readonly engine: AdminEngine;
  readonly run: RunEngineCall;
}) {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const templates = engine.templates();
  const preview = openId === undefined ? undefined : engine.templatePreview(openId);
  return (
    <section aria-label={STARTING_POINTS_TITLE} className="space-y-1.5">
      <h3 className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
        {`${STARTING_POINTS_TITLE}${templates.length === 0 ? "" : ` (${templates.length})`}`}
      </h3>
      {templates.length === 0 ? (
        <p className="text-on-surface-variant">{NONE}</p>
      ) : (
        <ul className="list-none m-0 p-0 space-y-1.5">
          {templates.map((template) => (
            <li
              className="p-3 rounded bg-surface-container-low border border-surface-container-high/60 flex flex-col gap-1.5"
              key={template.templateId}
            >
              <p className="font-mono font-semibold text-[12px] text-on-surface">
                {template.label}
              </p>
              <p className="text-on-surface-variant">{template.description}</p>
              <button
                aria-expanded={openId === template.templateId}
                className={`${SECONDARY_BUTTON} self-start`}
                onClick={() =>
                  setOpenId((current) =>
                    current === template.templateId ? undefined : template.templateId,
                  )
                }
                type="button"
              >
                {openId === template.templateId ? CANCEL_LABEL : PREVIEW_LABEL}
              </button>
              {preview === undefined || preview.templateId !== template.templateId ? null : (
                <section
                  aria-label={preview.heading}
                  className="p-2.5 rounded border border-surface-container-high/60 bg-surface-container flex flex-col gap-1.5"
                >
                  <h4 className="font-semibold text-[11px] text-tertiary">{preview.heading}</h4>
                  {preview.refusal === undefined ? null : <p role="alert">{preview.refusal}</p>}
                  {preview.summary === undefined ? null : (
                    <p className="text-on-surface-variant">{preview.summary}</p>
                  )}
                  {preview.affected === undefined ? null : (
                    <p className="text-on-surface-variant">{preview.affected}</p>
                  )}
                  {preview.addable ? (
                    <button
                      className={`${PRIMARY_BUTTON} self-start`}
                      onClick={() => {
                        run(() => engine.applyTemplate(template.templateId));
                        setOpenId(undefined);
                      }}
                      type="button"
                    >
                      {ADD_LABEL}
                    </button>
                  ) : null}
                </section>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
