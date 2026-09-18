export interface ProtectedPolicyRuntime {
  readonly model: unknown;
  byId(id: string): HTMLElement | null;
  announce(message: string, error?: boolean): void;
  schemaErrors(schema: unknown, value: unknown, path?: string): string[];
  fieldError(id: string, message: string): void;
  /** Read only: the runtime copies `state.policy` into the bundle it builds. */
  readonly state: { readonly policy: unknown };
}

export function mountProtectedPolicyWorkbench(runtime: ProtectedPolicyRuntime): void;
