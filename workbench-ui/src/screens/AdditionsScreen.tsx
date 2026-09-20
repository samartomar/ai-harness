import { CustomMcp } from "../editors/CustomMcp.js";
import { EccMcpApproval } from "../editors/EccMcpApproval.js";
import { FrameworkCuration } from "../editors/FrameworkCuration.js";
import { IntakeSection } from "./IntakeSection.js";
import type { AdminScreenProps } from "./types.js";

/**
 * The "Additions" screen (`screens/admin-acme.html`). It composes editors
 * only; each editor is its own file under `src/editors/`.
 */

export const ADDITIONS_SCREEN_TITLE = "Additions";

const LEDE =
  "The one place you add what aih does not ship, record approvals and build the protected policy file. Nothing here installs or runs anything.";

export function AdditionsScreen(props: AdminScreenProps) {
  const { engine, run } = props;
  const counts = engine.additions().counts;
  return (
    <main aria-label={ADDITIONS_SCREEN_TITLE} className="flex-1 overflow-y-auto p-5 space-y-4">
      <h1 className="text-[13px] font-semibold text-on-surface">{ADDITIONS_SCREEN_TITLE}</h1>
      <p className="text-[10.5px] text-outline">{LEDE}</p>

      {/* The rail's "In this policy" counts (`acme-screen.ts` lines 600-617). */}
      <ul aria-label="In this policy" className="flex flex-wrap gap-3 text-[10.5px] text-outline">
        <li>Custom MCP: {counts.customMcp}</li>
        <li>Remote MCP: {counts.remoteMcp}</li>
        <li>Framework curation: {counts.curation}</li>
        <li>ECC MCP approvals: {counts.eccApprovals}</li>
      </ul>

      <FrameworkCuration engine={engine} run={run} />
      <CustomMcp engine={engine} run={run} />
      <EccMcpApproval engine={engine} run={run} />

      <IntakeSection {...props} />
    </main>
  );
}
