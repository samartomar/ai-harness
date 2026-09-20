import { useState } from "react";
import { AdoptionRecipe } from "../editors/AdoptionRecipe.js";
import { AiTools } from "../editors/AiTools.js";
import { DeveloperTools } from "../editors/DeveloperTools.js";
import { EccHookControls } from "../editors/EccHookControls.js";
import { EvidenceVersions } from "../editors/EvidenceVersions.js";
import { ManagedMcpSwitch } from "../editors/ManagedMcpSwitch.js";
import { PostureSwitch } from "../editors/PostureSwitch.js";
import { ReadinessLine } from "../editors/ReadinessLine.js";
import type { AdminScreenProps } from "./types.js";

/**
 * The "Organization" screen (`screens/admin-org.html`). It composes editors
 * only; each editor is its own file under `src/editors/`.
 *
 * Deployment setup keeps the hand-built organization screen's shape: posture,
 * the sanctioned AI tools, the managed MCP projection, the readiness line, and
 * the two reference drawers, then developer tool setup and the ECC hook
 * controls. These settings record intent; AIH installs, starts and contacts
 * nothing from this page.
 */

export const ORG_SCREEN_TITLE = "Organization";
const SETUP_TITLE = "Deployment setup";
const SETUP_HELP =
  "Choose the hosts this policy may target before adding Core controls. These choices record policy intent; they do not install, start, or contact a server.";

export function OrgScreen({ engine, state, run }: AdminScreenProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const org = engine.org();

  return (
    <main
      aria-label={ORG_SCREEN_TITLE}
      className="flex-1 overflow-y-auto p-5 space-y-4 max-w-3xl min-w-0"
    >
      <h1 className="text-[13px] font-semibold text-on-surface">{ORG_SCREEN_TITLE}</h1>

      <section
        aria-label={SETUP_TITLE}
        className="flex flex-col gap-2 px-3.5 py-3 rounded border border-surface-container-high/60 bg-surface-container-lowest min-w-0"
      >
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h2 className="m-0 mr-auto font-bold text-on-surface text-[13.5px]">{SETUP_TITLE}</h2>
          <AdoptionRecipe
            onOpenChange={setRecipeOpen}
            open={recipeOpen}
            roles={org.adoptionRoles}
          />
          <EvidenceVersions
            delivery={org.evidenceDelivery}
            onOpenChange={setEvidenceOpen}
            open={evidenceOpen}
          />
        </div>
        <p className="m-0 text-[10.5px] leading-snug text-outline">{SETUP_HELP}</p>
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <PostureSwitch engine={engine} posture={state.posture} run={run} />
          <AiTools
            engine={engine}
            onOpenChange={setToolsOpen}
            open={toolsOpen}
            run={run}
            tools={state.aiTools}
          />
        </div>
        <ManagedMcpSwitch
          checked={state.managedMcpOptIn}
          onToggle={(next) => run(() => engine.setManagedMcpOptIn(next))}
        />
        <ReadinessLine readiness={org.readiness} />
      </section>

      <DeveloperTools developerTools={org.developerTools} engine={engine} run={run} />
      <EccHookControls eccHooks={org.eccHooks} engine={engine} run={run} />
    </main>
  );
}
