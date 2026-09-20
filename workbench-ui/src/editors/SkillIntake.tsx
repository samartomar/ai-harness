import { useId, useState } from "react";
import type {
  AdminEngine,
  EngineOutcome,
  IntakeDraftV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import { SECONDARY_BUTTON, TEXT_INPUT, UnavailableControl } from "../chrome.js";
import type { WorkbenchHost } from "../host.js";

/**
 * GitHub Skill intake (editor 18), the delivery's ONLY connected feature.
 * Behaviour source: `parseSkillDiscovery` and the connected resolver of
 * `ui/artifact-intake-runtime.js` (lines 64-67, 87-90).
 *
 * Parsing is local and offline. The one connected step is a host capability:
 * a host without it keeps the label, never a dead control. Whatever the server
 * answers is untrusted data, judged by the engine before anything is pinned.
 */

export const SKILL_INTAKE_TITLE = "Add an organization Skill";
export const SKILL_DISCOVERY_LABEL = "Paste a Skill discovery command or exact GitHub permalink";
export const SKILL_OFFLINE_MESSAGE =
  "AIH parses exact permalinks locally. Provide a GitHub SKILL.md permalink with its immutable commit and path; this offline Workbench never contacts GitHub or runs the pasted command.";
export const SKILL_CONNECTED_MESSAGE =
  "Core contacts GitHub to pin this Skill; it does not run the pasted command or scan or approve the source.";
export const SKILL_OFFLINE_BUTTON = "Read skill link";
export const SKILL_CONNECTED_BUTTON = "Resolve skill";
const SKILL_RESOLVING_BUTTON = "Resolving skill...";
const SKILL_READING_BUTTON = "Reading skill link...";
export const SKILL_INTAKE_REASON = "Available on the local page opened by npx @aihq/core --ui";
const DISCOVERY_CHANGED = "Discovery input changed. Resolve it again before adding the Skill.";
const RESOLUTION_SUFFIX = " Resolution does not scan, install, or approve it.";

/** `artifact-intake-runtime.js` line 88, the exact-permalink branch. */
function exactMessage(repository: string, commit: string, path: string): string {
  return `Parsed an exact permalink locally; nothing was run or installed. This candidate pin is not evidence or authority. The batch scanner will re-fetch ${repository} at commit ${commit} and verify ${path}.`;
}

/** Line 88, the offline branch: read, but still unpinned. */
function readMessage(skill: string, repository: string): string {
  return `Read request for ${skill} from ${repository}. Its exact commit and SKILL.md path are still required before it can be added; this offline Workbench never contacts GitHub or runs the pasted command.`;
}

/** Line 88, the connected branch, after the server pinned a commit. */
function resolvedMessage(skill: string, repository: string, commit: string): string {
  return `Resolved an immutable GitHub pin for ${skill}. Nothing was downloaded, run, scanned, installed, or approved. Add it to record a pending source intent; the batch scanner must inspect ${repository} at commit ${commit} before Core preparation.`;
}

export function SkillIntake({
  engine,
  host,
  draft,
  onDraft,
  setOutcome,
}: {
  readonly engine: AdminEngine;
  readonly host: WorkbenchHost;
  /** The add form the resolved pin writes into; the queue editor owns it. */
  readonly draft: IntakeDraftV1;
  readonly onDraft: (next: IntakeDraftV1) => void;
  readonly setOutcome: (outcome: EngineOutcome) => void;
}) {
  const connected = host.capabilities.githubIntake && host.githubSkill !== undefined;
  const [raw, setRaw] = useState("");
  const [message, setMessage] = useState(
    connected ? SKILL_CONNECTED_MESSAGE : SKILL_OFFLINE_MESSAGE,
  );
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const messageId = useId();

  const label = connected ? SKILL_CONNECTED_BUTTON : SKILL_OFFLINE_BUTTON;

  /** Clear the pin this editor last wrote, as `clearSkillDiscoveryFields` did. */
  const clearPin = (next: IntakeDraftV1): IntakeDraftV1 => ({
    ...next,
    id: "",
    discoveryUrl: "",
    githubRepository: "",
    githubCommit: "",
    sourcePath: "",
  });

  const apply = async () => {
    setBusy(true);
    const cleared = clearPin(draft);
    const parsed = engine.parseSkillDiscovery(raw);
    if (!parsed.ok) {
      onDraft(cleared);
      setMessage(`${parsed.errors.join("; ")}${RESOLUTION_SUFFIX}`);
      setBusy(false);
      return;
    }
    const discovery = parsed.value;
    const pinned: IntakeDraftV1 = {
      ...cleared,
      kind: "skill",
      sourceType: "github",
      id: discovery.skill,
      discoveryUrl: discovery.discoveryUrl,
      githubRepository: discovery.repository,
    };
    if (discovery.exact) {
      onDraft({ ...pinned, githubCommit: discovery.commit, sourcePath: discovery.path });
      setMessage(exactMessage(discovery.repository, discovery.commit, discovery.path));
      setBusy(false);
      return;
    }
    if (!connected || host.githubSkill === undefined) {
      onDraft(pinned);
      setMessage(readMessage(discovery.skill, discovery.repository));
      setBusy(false);
      return;
    }
    try {
      const answer = await host.githubSkill.resolve({
        repository: discovery.repository,
        skill: discovery.skill,
      });
      const pin = engine.checkConnectedSkillPin(answer, discovery);
      if (!pin.ok) {
        onDraft(cleared);
        setMessage(`${pin.errors.join("; ")}${RESOLUTION_SUFFIX}`);
        return;
      }
      onDraft({ ...pinned, githubCommit: pin.value.commit, sourcePath: pin.value.path });
      setMessage(resolvedMessage(discovery.skill, discovery.repository, pin.value.commit));
    } catch (error) {
      onDraft(cleared);
      const sentence = error instanceof Error && error.message ? error.message : "";
      setMessage(
        `${sentence || "Could not resolve this Skill request. The candidate remains unpinned and cannot be added;"}${RESOLUTION_SUFFIX}`,
      );
      setOutcome({ ok: false, message: sentence || DISCOVERY_CHANGED });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={SKILL_INTAKE_TITLE} className="space-y-1.5">
      <h3 className="m-0 text-[11.5px] font-semibold text-on-surface">{SKILL_INTAKE_TITLE}</h3>
      <label className="grid gap-1 min-w-0 text-[10.5px] text-on-surface-variant" htmlFor={inputId}>
        {SKILL_DISCOVERY_LABEL}
        <input
          aria-describedby={messageId}
          className={`${TEXT_INPUT} w-full`}
          id={inputId}
          maxLength={2048}
          onChange={(event) => {
            setRaw(event.target.value);
            // A changed paste invalidates the pin it produced (line 89).
            onDraft(clearPin(draft));
            setMessage(DISCOVERY_CHANGED);
          }}
          type="text"
          value={raw}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={SECONDARY_BUTTON}
          disabled={busy}
          onClick={() => void apply()}
          type="button"
        >
          {busy ? (connected ? SKILL_RESOLVING_BUTTON : SKILL_READING_BUTTON) : label}
        </button>
        {connected ? null : (
          <UnavailableControl label="Resolve skill" reason={SKILL_INTAKE_REASON} />
        )}
      </div>
      {/* Every sentence, including a refusal, is read here as text. */}
      <p
        className="m-0 font-mono text-[10.5px] text-outline [overflow-wrap:anywhere]"
        id={messageId}
      >
        {message}
      </p>
    </section>
  );
}
