import {
  AihError,
  type FrameworkHookControlAuthorityV1,
  type FrameworkHookControlDecisionV1,
  type FrameworkHookControlPlanV1,
  type FrameworkHookControlRequestV1,
  type FrameworkHookHostDecisionV1,
  type FrameworkHookInventoryV1,
  type FrameworkHookV1,
  type FrameworkOperationContextV1,
} from "@aihq/core/framework-host";
import { type EccHookProfile, readEccHookControlInventory } from "./descriptor.js";
import { ECC_DISABLED_HOOKS_KEY, ECC_HOOK_PROFILE_KEY, UPSTREAM } from "./identity.js";
import { currentEccInvocation, withEccInvocation } from "./invocation.js";

/** ECC declares its hooks in `hooks/hooks.json`, Claude Code's hook format. */
const HOOK_SOURCE = "hooks/hooks.json";

function inventoryOfCurrentInvocation(): FrameworkHookInventoryV1 {
  const descriptor = currentEccInvocation().descriptor;
  const inventory = readEccHookControlInventory(descriptor);
  const hooks = inventory.hooks.map(
    (hook): FrameworkHookV1 =>
      Object.freeze({
        id: hook.id,
        event: hook.event,
        summary: `ECC ${hook.event} hook ${hook.id}; runs under the ${hook.profiles.join(", ")} profile${hook.profiles.length === 1 ? "" : "s"}${hook.disableEligible ? "" : "; an outer wrapper whose child hooks own the gates"}.`,
        declarations: Object.freeze([
          Object.freeze({
            host: "claude" as const,
            sourcePath: HOOK_SOURCE,
            event: hook.event,
            execution: "process" as const,
          }),
        ]),
        upstreamControl: hook.disableEligible
          ? Object.freeze({
              kind: "environment" as const,
              name: ECC_DISABLED_HOOKS_KEY,
              value: hook.id,
            })
          : Object.freeze({ kind: "none" as const }),
        profiles: Object.freeze([...hook.profiles]),
        disableEligible: hook.disableEligible,
      }),
  );
  return Object.freeze({
    frameworkId: "ecc",
    upstream: Object.freeze({ repository: UPSTREAM.repository, commit: descriptor.source.commit }),
    hooks: Object.freeze(hooks),
    profiles: Object.freeze(inventory.profiles.map((profile) => Object.freeze({ ...profile }))),
  });
}

/** ECC's 43 reviewed hooks at the pinned commit, read from Catalog's bytes. */
export function hookInventory(ctx: FrameworkOperationContextV1): FrameworkHookInventoryV1 {
  return withEccInvocation(ctx, inventoryOfCurrentInvocation);
}

function refuse(message: string): never {
  throw new AihError(message, "AIH_CONFIG");
}

/**
 * Decide ECC's hook controls for the targeted hosts. ECC reads two switches from
 * the Claude settings environment after each hook process starts —
 * `ECC_HOOK_PROFILE` and the comma-separated `ECC_DISABLED_HOOKS` — so every
 * disable-eligible hook can be turned off without editing ECC files. The plan
 * returns those two values; Core writes them through its hook registrar and
 * records a receipt that owns exactly those keys.
 *
 * Refused: an id outside the reviewed inventory, the outer Bash wrapper (its
 * child hooks own the gates), an unknown profile, and a hook the chosen
 * profile never runs.
 */
export function planHookControls(
  ctx: FrameworkOperationContextV1,
  request: FrameworkHookControlRequestV1,
): FrameworkHookControlPlanV1 {
  return withEccInvocation(ctx, () => {
    const inventory = inventoryOfCurrentInvocation();
    const byId = new Map(inventory.hooks.map((hook) => [hook.id, hook]));
    const profileIds = (inventory.profiles ?? []).map((profile) => profile.id);
    const profile = request.profile?.id;
    if (profile !== undefined && !profileIds.includes(profile)) {
      refuse(
        `unknown ECC hook profile ${profile}; the pinned profiles are ${profileIds.join(", ")}`,
      );
    }
    const unknown = [
      ...new Set(request.disabled.map((entry) => entry.hookId).filter((id) => !byId.has(id))),
    ];
    if (unknown.length > 0) {
      refuse(
        `unknown ECC hook id(s) ${unknown.join(", ")}; the reviewed affaan-m/ECC@${inventory.upstream.commit.slice(0, 12)} inventory has no such hook`,
      );
    }
    for (const entry of request.disabled) {
      const hook = byId.get(entry.hookId) as FrameworkHookV1;
      if (hook.disableEligible === false) {
        refuse(`ECC hook ${hook.id} is a wrapper, not an individually disable-eligible hook`);
      }
      if (profile !== undefined && !hook.profiles?.includes(profile)) {
        refuse(`ECC hook ${hook.id} is not eligible under the ${profile} profile`);
      }
    }
    const decisions: FrameworkHookControlDecisionV1[] = [];
    const disabledIds: string[] = [];
    for (const hook of inventory.hooks) {
      const requests = request.disabled.filter((entry) => entry.hookId === hook.id);
      if (requests.length === 0) {
        decisions.push({ hookId: hook.id, state: "enabled", hosts: [] });
        continue;
      }
      disabledIds.push(hook.id);
      const authority: FrameworkHookControlAuthorityV1 = requests.some(
        (entry) => entry.authority === "enterprise",
      )
        ? "enterprise"
        : "user";
      const hosts: FrameworkHookHostDecisionV1[] = ctx.targets.map((host) =>
        host === "claude"
          ? {
              host,
              enforcement: "upstream-switch",
              detail: `ECC skips ${hook.id} when ${ECC_DISABLED_HOOKS_KEY} in .claude/settings.json env lists it; aih writes that key and ECC's hook runtime enforces it.`,
            }
          : {
              host,
              enforcement: "not-applicable",
              detail: `${hook.id} is declared in ECC's Claude hooks.json; it does not run on ${host}.`,
            },
      );
      decisions.push({ hookId: hook.id, state: "disabled", authority, hosts });
    }
    const set: Record<string, string> = {};
    if (profile !== undefined) set[ECC_HOOK_PROFILE_KEY] = profile as EccHookProfile;
    if (disabledIds.length > 0) set[ECC_DISABLED_HOOKS_KEY] = disabledIds.join(",");
    return {
      frameworkId: "ecc",
      decisions,
      actions: [],
      ...(Object.keys(set).length === 0
        ? {}
        : {
            environment: {
              host: "claude" as const,
              keys: [ECC_HOOK_PROFILE_KEY, ECC_DISABLED_HOOKS_KEY],
              set,
            },
          }),
    };
  });
}
