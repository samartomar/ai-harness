import {
  deploymentReadinessBlockers,
  type PolicyGrammarContext,
  type PolicyGrammarModel,
  policyGrammarErrors,
  preparePolicyImport,
  reconcileManagedMcpProjection,
  serializePolicy,
  validatePolicy,
} from "./policy-grammar.js";

/**
 * The new shell's policy session (NEW-SHELL-PLAN.md §1, slice S2): the one
 * policy object every screen reads, and the legacy runtime's rules for
 * changing it (`commitPolicy`, `validateCurrentPolicy`, `R()`, the file and
 * generic imports, clear). DOM-free: the shell injects how to announce, how
 * to re-render and how to tell listeners the policy changed.
 */

// biome-ignore lint/suspicious/noExplicitAny: policy JSON is validated by the grammar, not by TypeScript
type Loose = any;

export interface PolicySessionModel extends PolicyGrammarModel {
  readonly initialPolicy: unknown;
}

export interface PolicySessionHooks {
  /** `#announcement` / `#status`, exactly as the legacy `p(message, error)`. */
  announce(message: string, error?: boolean): void;
  /** Re-render everything that reads the policy (the legacy `Xe`). */
  render(): void;
  /** Tell listeners the policy changed (`aih-workbench-policy-change`). */
  changed(): void;
  /** The selection validator the grammar consults (`window.__aihWorkbenchValidatePolicy`). */
  selectionValidator(): unknown;
}

export interface PolicySession {
  /** A copy of the current policy. */
  snapshotPolicy(): unknown;
  /**
   * Replace the policy through the generic import rules (catalog projection
   * and repairs use this). Returns the import message; throws, changing
   * nothing, when the policy is rejected.
   */
  restorePolicy(policy: unknown): string;
  /** Run the generic import rules without changing the session. Throws when rejected. */
  validatePolicy(policy: unknown): { policy: unknown; message: string };
  /** Replace the policy from an imported file. Throws, changing nothing, when rejected. */
  importPolicy(policy: unknown): string;
  /**
   * Keep a change already made to the current policy, or restore `prior`
   * when the grammar rejects it (the legacy `commitPolicy`).
   */
  commitPolicy(prior: unknown, message: string): boolean;
  /**
   * Change the current policy in place and keep it through `commitPolicy`
   * (the legacy `b()` edits). `change` returns a message to refuse the
   * change instead: the prior policy is restored and the message announced
   * as an error.
   */
  edit(change: (policy: Loose) => string | undefined, message: string): boolean;
  /** Set the managed MCP opt-in and keep it through `commitPolicy`, or restore it. */
  setManagedMcpOptIn(optIn: boolean, message: string): boolean;
  /** Schema and grammar errors of the current policy, at most one message. */
  validate(): string[];
  /** Deployment setup still owed before export or download. */
  readinessBlockers(): string[];
  /** The exact bytes a policy download writes. */
  serialize(): string;
  /** Reset to the initial policy. */
  clear(): void;
  managedMcpOptIn(): boolean;
  receipt(): unknown;
  setReceipt(receipt: unknown): void;
  decision(): unknown;
  setDecision(decision: unknown): void;
}

function managedOnly(policy: Loose): boolean {
  return Boolean(policy?.mcp && policy.mcp.allowManagedOnly === true);
}

export function createPolicySession(
  model: PolicySessionModel,
  hooks: PolicySessionHooks,
): PolicySession {
  const grammar: PolicyGrammarContext = {
    model,
    selectionValidator: () => hooks.selectionValidator(),
  };
  const state: { policy: Loose; receipt: unknown; decision: unknown; managedMcpOptIn: boolean } = {
    policy: structuredClone(model.initialPolicy),
    receipt: null,
    decision: null,
    managedMcpOptIn: managedOnly(model.initialPolicy),
  };
  const genericImport = (policy: unknown) =>
    preparePolicyImport(policy, (candidate) => policyGrammarErrors(candidate, model), grammar);
  const reconcile = () => reconcileManagedMcpProjection(state.policy, state.managedMcpOptIn);

  const commitPolicy = (prior: unknown, message: string): boolean => {
    reconcile();
    const errors = validatePolicy(state.policy, grammar);
    if (errors.length) {
      state.policy = prior;
      hooks.announce(`Policy change rejected: ${errors.slice(0, 3).join("; ")}`, true);
      hooks.render();
      return false;
    }
    hooks.announce(message);
    hooks.render();
    hooks.changed();
    return true;
  };

  return {
    snapshotPolicy: () => structuredClone(state.policy),
    validatePolicy: (policy) => genericImport(policy),
    restorePolicy(policy) {
      const prepared = genericImport(policy);
      state.managedMcpOptIn = state.managedMcpOptIn || managedOnly(prepared.policy);
      state.policy = prepared.policy;
      reconcile();
      hooks.render();
      hooks.changed();
      return prepared.message;
    },
    importPolicy(policy) {
      const prepared = genericImport(policy);
      state.policy = prepared.policy;
      state.managedMcpOptIn = managedOnly(state.policy);
      hooks.announce(prepared.message);
      hooks.render();
      hooks.changed();
      return prepared.message;
    },
    commitPolicy,
    edit(change, message) {
      const prior = structuredClone(state.policy);
      const refused = change(state.policy);
      if (refused !== undefined) {
        state.policy = prior;
        hooks.announce(refused, true);
        hooks.render();
        return false;
      }
      return commitPolicy(prior, message);
    },
    setManagedMcpOptIn(optIn, message) {
      const previous = state.managedMcpOptIn;
      state.managedMcpOptIn = optIn;
      if (commitPolicy(structuredClone(state.policy), message)) return true;
      state.managedMcpOptIn = previous;
      hooks.render();
      return false;
    },
    validate: () => validatePolicy(state.policy, grammar),
    readinessBlockers: () => deploymentReadinessBlockers(state.policy, state.managedMcpOptIn),
    serialize: () => serializePolicy(state.policy),
    clear() {
      state.policy = structuredClone(model.initialPolicy);
      state.managedMcpOptIn = managedOnly(state.policy);
      hooks.announce(
        "Policy cleared. All selections, requests and curation records were removed from this draft. You can start again with any source.",
      );
      hooks.render();
      hooks.changed();
    },
    managedMcpOptIn: () => state.managedMcpOptIn,
    receipt: () => state.receipt,
    setReceipt(receipt) {
      state.receipt = receipt;
      hooks.render();
    },
    decision: () => state.decision,
    setDecision(decision) {
      state.decision = decision;
      hooks.render();
    },
  };
}
