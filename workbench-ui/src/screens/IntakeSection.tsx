import { useState } from "react";
import type {
  IntakeDraftV1,
  ProtectedFieldsV1,
} from "../../../src/org-policy/workbench/engine/index.js";
import {
  INTAKE_DOWNLOAD_STARTED_MESSAGE,
  PROTECTED_DOWNLOAD_STARTED_MESSAGE,
} from "../../../src/org-policy/workbench/engine/index.js";
import { ArtifactIntake } from "../editors/ArtifactIntake.js";
import { PROTECTED_INITIAL_FIELDS, ProtectedBundle } from "../editors/ProtectedBundle.js";
import { SkillIntake } from "../editors/SkillIntake.js";
import type { AdminScreenProps } from "./types.js";

/**
 * The intake half of the "Additions" screen: GitHub skill intake, the artifact
 * intake workspace, and protected bundle authoring. The add form's draft is
 * shared state, so the three editors are composed here, not on the screen.
 */

const EMPTY_DRAFT: IntakeDraftV1 = {
  defaultOwner: "",
  kind: "mcp",
  id: "",
  discoveryUrl: "",
  sourceType: "npm",
  npmPackage: "",
  npmVersion: "",
  npmIntegrity: "",
  githubRepository: "",
  githubCommit: "",
  sourcePath: "",
  directoryUrl: "",
};

export function IntakeSection({ engine, host, run, setOutcome }: AdminScreenProps) {
  // The add form is page state: the Skill intake writes a resolved pin into
  // the same draft the review queue adds from, as the hand-built page does.
  const [draft, setDraft] = useState<IntakeDraftV1>(EMPTY_DRAFT);
  const [fields, setFields] = useState<ProtectedFieldsV1>(PROTECTED_INITIAL_FIELDS);

  return (
    <div className="space-y-5">
      <SkillIntake
        draft={draft}
        engine={engine}
        host={host}
        onDraft={setDraft}
        setOutcome={setOutcome}
      />
      <ArtifactIntake
        draft={draft}
        engine={engine}
        onDownload={() => {
          const file = engine.downloadIntake();
          if (!file.ok) {
            setOutcome({ ok: false, message: file.errors.join("; ") });
            return;
          }
          host.save(file.value);
          setOutcome({ ok: true, message: INTAKE_DOWNLOAD_STARTED_MESSAGE });
        }}
        onDraft={setDraft}
        run={run}
      />
      <ProtectedBundle
        engine={engine}
        fields={fields}
        host={host}
        onDownload={(file) => {
          host.save(file);
          setOutcome({ ok: true, message: PROTECTED_DOWNLOAD_STARTED_MESSAGE });
        }}
        onFields={setFields}
        setOutcome={setOutcome}
      />
    </div>
  );
}
