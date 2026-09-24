/**
 * The ECC facade — the ONE Core module that reaches ECC framework code
 * (`src/ecc/**` and the ECC profile modules of `src/ecc-profile/**`).
 *
 * Phase 1 (this module): every Core call site imports ECC behaviour from here
 * and nowhere else (tests/framework-plugin/ecc-facade-boundary.test.ts). The
 * exports below are exactly what those call sites use.
 *
 * Phase 2 moves `src/ecc/**` and the ECC profile modules into
 * `@aihq/framework-ecc` and re-implements these exports over the plugin loaded
 * by `src/framework-plugin/load-framework-plugin.ts`. Call sites, the exports
 * they use, and the contract member each maps to (SYNC = called from
 * synchronous Core code today; phase 2 must load the plugin before those call
 * sites run, from their async command entry points, or make them async):
 *
 * | Core call site | Exports | Phase-2 contract member |
 * | --- | --- | --- |
 * | delivery report (src/org-policy/policy-delivery-report.ts) — SYNC | `describeEccEffectiveDiscovery`, `inspectDestination`, `materializationRoot`, `ownedFragmentDigest`, `parseJsonObject`, `GOVERNED_MATERIALIZATION_TARGETS`, `ownedFileSha256`, `readEccMaterializationReceipt`, `inspectGovernedCodexRoleRegistration` and their types | `report`, `receipts` |
 * | policy binding (src/org-policy/binding.ts) — SYNC | `readEccMaterializationReceipt` | `receipts` |
 * | uninstall (src/uninstall/ecc-materialization.ts) — SYNC | `uninstallEccMaterialization`, `readEccMaterializationReceipt`, `ECC_MATERIALIZATION_RECEIPT_PATH`, `displaySafe` | `uninstall` |
 * | prune (src/prune/index.ts) — SYNC | `codexPruneRemovalActions`, `eccPruneReconciliationActions`, `hasEccRegisteredTarget`, `hasEccRegistrationLedger`, `isAihDirectEccInstallTarget` | `prune` |
 * | doctor (src/doctor.ts) — SYNC | `readExplicitEccMcpReceiptStates` | `doctor` |
 * | capability package manager (src/capability/package-graph/adapters/ecc-*.ts, src/capability/package-manager/{live-context,domains/mixed-coordinator}.ts) — SYNC | `ECC_MATERIALIZATION_RECEIPT_PATH`, `ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH`, `parseEccMaterializationReceipt`, `readEccMaterializationReceipt`, `parseExplicitAddReceipt`, `explicitEccMcpRenderPlan`, `planExplicitEccMcpRemove`, `readExplicitEccMcpReceiptStates`, `planEccComponentSubtraction` | `receipts` plus ECC MCP add/remove planning |
 * | report (src/report/v9-panels.ts, src/report/v9.ts) — SYNC | `eccLanguages`, `EccLanguagePack` | `report` |
 * | CLI capability table (src/internals/cli-capabilities.ts) — SYNC | `ECC_INSTALL_TARGETS`, `WIRED_MATERIALIZATION_TARGETS` | `describe().supportedHosts` |
 * | test-only binding adapter (src/binding/frameworks/ecc.ts) | `selectedEccMcpServers`, `parseEccInstallPreview`, `readEccInstallPreview`, `EccInstallPreviewArtifact`, `EccMcpComponentId` | moves with the ECC code or is deleted |
 * | repository checks (src/internals/check-baseline-installable.ts, check-ecc-installer.ts) | `readRegistrationLedger`, `registrationLedgerPath`, `writeRegistrationLedgerAtomic`, `RegistrationLedger`, `ECC_NPM_BINS`, `ECC_NPM_PACKAGE` | move with the ECC package's own checks |
 *
 * Done in phase 2: `aih ecc` and `aih ecc mcp add|remove` run through the
 * plugin's `commands` (src/framework-plugin/ecc-command.ts), and governed
 * delivery (`aih policy project`, `aih init` on a bound project) through its
 * `policyDelivery` hook (src/org-policy/validate.ts).
 *
 * The generic runtime parts of `src/ecc-profile/**` (default MCP runtimes for
 * Serena, Code Review Graph, Codebase Memory and MarkItDown, `hook-core.ts`,
 * the native runtime and `native-runtime-cli.ts` behind `dist/ecc-runtime.js`)
 * are not framework code and stay in Core; they are not routed here.
 */

export { codexPruneRemovalActions } from "../ecc/codex.js";
export type { EccMcpComponentId } from "../ecc/components.js";
export {
  describeEccEffectiveDiscovery,
  type EccEffectiveDiscoveryReport,
} from "../ecc/effective-discovery.js";
export {
  ECC_NPM_BINS,
  ECC_NPM_PACKAGE,
  isAihDirectEccInstallTarget,
} from "../ecc/install.js";
export {
  type EccInstallPreviewArtifact,
  parseEccInstallPreview,
  readEccInstallPreview,
} from "../ecc/install-preview.js";
export { ECC_INSTALL_TARGETS } from "../ecc/install-targets.js";
export { uninstallEccMaterialization } from "../ecc/materialization.js";
export { inspectDestination, materializationRoot } from "../ecc/materialization-fs.js";
export {
  ownedFragmentDigest,
  parseJsonObject,
  planEccComponentSubtraction,
} from "../ecc/materialization-plan.js";
export {
  displaySafe,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  type EccMaterializationReceipt,
  type EccOwnedFile,
  ownedFileSha256,
  parseEccMaterializationReceipt,
  readEccMaterializationReceipt,
} from "../ecc/materialization-receipt.js";
export {
  type EccMaterializationTarget,
  GOVERNED_MATERIALIZATION_TARGETS,
  WIRED_MATERIALIZATION_TARGETS,
} from "../ecc/materialization-target.js";
export { selectedEccMcpServers } from "../ecc/mcp.js";
export {
  explicitEccMcpRenderPlan,
  planExplicitEccMcpRemove,
  readExplicitEccMcpReceiptStates,
} from "../ecc/mcp-explicit-add.js";
export {
  ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  parseExplicitAddReceipt,
} from "../ecc/mcp-explicit-add-receipt.js";
export {
  eccPruneReconciliationActions,
  hasEccRegisteredTarget,
  hasEccRegistrationLedger,
} from "../ecc/prune-reconcile.js";
export {
  type RegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
  writeRegistrationLedgerAtomic,
} from "../ecc/registration.js";
export { type EccLanguagePack, eccLanguages } from "../ecc/select.js";
export {
  type GovernedCodexRoleRegistrationInspection,
  inspectGovernedCodexRoleRegistration,
} from "../ecc-profile/governed-codex-roles.js";
