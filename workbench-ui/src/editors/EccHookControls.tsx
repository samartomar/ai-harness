import type {
  AdminEngine,
  EccHookControlsV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON, Segmented } from "../chrome.js";
import type { RunEngineCall } from "./types.js";

/**
 * The ECC hook controls (inventory row 14): the profile, the pinned inventory
 * grouped as `ui/shell/org-screen.ts` groups it, and the per-hook disabled
 * setting of `src/org-policy/ecc-hook-controls.ts`.
 *
 * ECC is third party to the runtime: AIH records the supported profile and the
 * disabled-hook list; ECC installs and executes the hooks. Nothing here is AIH
 * enforcement, and this form neither installs, runs, nor verifies a hook.
 */

export const ECC_TITLE = "ECC hook controls";
const HELP =
  "AIH records supported Claude environment intent. ECC executes hooks; this form does not install, run, or verify them.";
const INTRO =
  "ECC executes hooks; AIH configures the supported profile and disabled-hook list through receipt-owned Claude settings.json environment keys. Disabling affects ECC execution after process spawn; it is not AIH enforcement.";
const PROFILE_LABEL = "Profile";
const NO_PROFILE = "No ECC hook profile is recorded yet.";

export function EccHookControls({
  engine,
  eccHooks,
  run,
}: {
  readonly engine: AdminEngine;
  readonly eccHooks: EccHookControlsV1;
  readonly run: RunEngineCall;
}) {
  return (
    <section
      aria-label={ECC_TITLE}
      className="flex flex-col gap-2 px-3.5 py-3 rounded border border-surface-container-high/60 bg-surface-container-lowest min-w-0"
    >
      <div className="flex items-center gap-2">
        <h2 className="m-0 font-bold text-on-surface text-[13.5px]">{ECC_TITLE}</h2>
        <span className="px-1 rounded bg-surface-container-highest text-secondary font-mono text-[9px]">
          ECC
        </span>
      </div>
      <p className="m-0 text-[10.5px] leading-snug text-outline">{INTRO}</p>

      {eccHooks.profiles.length === 0 ? null : (
        <Segmented
          label={PROFILE_LABEL}
          onChange={(value) => run(() => engine.setEccHookProfile(value))}
          options={eccHooks.profiles.map((profile) => ({
            value: profile.id,
            label: profile.label,
          }))}
          size="sm"
          value={eccHooks.profile}
        />
      )}
      <p className="m-0 text-[10.5px] leading-snug text-outline">
        {eccHooks.profile === "" ? NO_PROFILE : eccHooks.detail}
      </p>

      {eccHooks.groupingError === undefined ? null : (
        <p className="m-0 text-[11.5px] text-tertiary" role="alert">
          {eccHooks.groupingError}
        </p>
      )}

      {eccHooks.groupingError !== undefined
        ? null
        : eccHooks.groups.map((group) => (
            <details className="flex flex-col gap-1.5 min-w-0" key={group.id}>
              <summary className="cursor-pointer font-mono text-[10.5px] uppercase tracking-wider font-semibold text-outline">
                {`${group.label} (${group.hooks.length})`}
              </summary>
              <p className="m-0 pt-1 text-[10.5px] leading-snug text-outline">
                {group.description}
              </p>
              {group.hooks.map((hook) => (
                <div
                  className="flex flex-col gap-1 px-2.5 py-2 mt-1 rounded bg-surface-container-low border border-surface-container-high/40"
                  key={hook.id}
                >
                  <p className="m-0 text-[11.5px] text-on-surface-variant">
                    <b className="font-mono font-semibold text-on-surface">{hook.id}</b>
                    {` — ${hook.event}`}
                  </p>
                  <p className="m-0 text-[10.5px] leading-snug text-outline">{hook.detail}</p>
                  {hook.disableEligible ? (
                    <div className="flex items-center gap-2">
                      <button
                        aria-label={`${hook.disabled ? "Re-enable" : "Disable"} ${hook.id}`}
                        className={SECONDARY_BUTTON}
                        disabled={!hook.canToggle}
                        onClick={() => run(() => engine.toggleEccHookDisabled(hook.id))}
                        type="button"
                      >
                        {hook.disabled ? "Re-enable" : "Disable"}
                      </button>
                      <span className="text-[10.5px] text-on-surface-variant">
                        {hook.disabled ? "Disabled for this profile" : "Enabled for this profile"}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[10.5px] text-outline">
                      Required wrapper; no individual disabled setting.
                    </span>
                  )}
                </div>
              ))}
            </details>
          ))}

      <p className="m-0 text-[10.5px] leading-snug text-outline">{HELP}</p>
    </section>
  );
}
