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
import { eccHookControl, eccHookDeclarations, readEccHookControlInventory } from "./descriptor.js";
import { ECC_DISABLED_HOOKS_KEY, ECC_HOOK_PROFILE_KEY, UPSTREAM } from "./identity.js";
import { currentEccInvocation, withEccInvocation } from "./invocation.js";

function inventoryOfCurrentInvocation(): FrameworkHookInventoryV1 {
  const descriptor = currentEccInvocation().descriptor;
  const inventory = readEccHookControlInventory(descriptor);
  const hooks = inventory.hooks.map(
    (hook): FrameworkHookV1 =>
      Object.freeze({
        id: hook.id,
        event: hook.event,
        summary: `ECC ${hook.event} hook ${hook.id}; runs under the ${hook.profiles.join(", ")} profile${hook.profiles.length === 1 ? "" : "s"}${hook.disableEligible ? "" : "; not individually disable-eligible"}.`,
        declarations: Object.freeze(
          eccHookDeclarations(hook).map((declaration) => Object.freeze({ ...declaration })),
        ),
        upstreamControl:
          eccHookControl(hook).kind === "claude-settings-env"
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

/** ECC's hooks at the pinned commit, read from Catalog's bytes. */
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
 * hook whose control is that switch can be turned off without editing ECC
 * files. The plan returns those two values; Core writes them through its hook
 * registrar and records a receipt that owns exactly those keys.
 *
 * A disabled hook ECC has no switch for (control `none`, for example its
 * OpenCode plugin) is still planned: on each host that declares it the decision
 * is `unenforced`, with the next route an operator can take.
 *
 * Refused: an id outside the inventory, a hook that is not individually
 * disable-eligible, an unknown profile, and a hook the chosen profile never runs.
 */
export function planHookControls(
  ctx: FrameworkOperationContextV1,
  request: FrameworkHookControlRequestV1,
): FrameworkHookControlPlanV1 {
  return withEccInvocation(ctx, () => {
    const descriptor = currentEccInvocation().descriptor;
    const rows = readEccHookControlInventory(descriptor);
    const inventory = inventoryOfCurrentInvocation();
    const byId = new Map(rows.hooks.map((hook) => [hook.id, hook]));
    const profileIds = rows.profiles.map((profile) => profile.id);
    const profile = request.profile?.id;
    if (profile !== undefined && !profileIds.includes(profile)) {
      refuse(
        `unknown ECC hook profile ${profile}; the pinned profiles are ${profileIds.join(", ")}`,
      );
    }
    const unknown = [
      ...new Set(request.disabled.map((entry) => entry.hookId).filter((id) => !byId.has(id))),
    ];
    const short = inventory.upstream.commit.slice(0, 12);
    if (unknown.length > 0) {
      refuse(
        `unknown ECC hook id(s) ${unknown.join(", ")}; the affaan-m/ECC@${short} inventory has no such hook`,
      );
    }
    for (const entry of request.disabled) {
      const hook = byId.get(entry.hookId) as (typeof rows.hooks)[number];
      if (!hook.disableEligible) {
        refuse(`ECC hook ${hook.id} is not individually disable-eligible`);
      }
      if (profile !== undefined && !hook.profiles.includes(profile)) {
        refuse(`ECC hook ${hook.id} is not eligible under the ${profile} profile`);
      }
    }
    const decisions: FrameworkHookControlDecisionV1[] = [];
    const switched: string[] = [];
    for (const hook of rows.hooks) {
      const requests = request.disabled.filter((entry) => entry.hookId === hook.id);
      if (requests.length === 0) {
        decisions.push({ hookId: hook.id, state: "enabled", hosts: [] });
        continue;
      }
      const control = eccHookControl(hook).kind;
      if (control === "claude-settings-env") switched.push(hook.id);
      const declarations = eccHookDeclarations(hook);
      const authority: FrameworkHookControlAuthorityV1 = requests.some(
        (entry) => entry.authority === "enterprise",
      )
        ? "enterprise"
        : "user";
      const hosts: FrameworkHookHostDecisionV1[] = ctx.targets.map((host) => {
        const declaration = declarations.find((candidate) => candidate.host === host);
        if (declaration === undefined) {
          return {
            host,
            enforcement: "not-applicable",
            detail: `${hook.id} is not declared for ${host} in affaan-m/ECC@${short}; it does not run there.`,
          };
        }
        if (control === "claude-settings-env" && host === "claude") {
          return {
            host,
            enforcement: "upstream-switch",
            detail: `ECC skips ${hook.id} when ${ECC_DISABLED_HOOKS_KEY} in .claude/settings.json env lists it; aih writes that key and ECC's hook runtime enforces it.`,
          };
        }
        return {
          host,
          enforcement: "unenforced",
          detail: `aih cannot turn ${hook.id} off on ${host}: affaan-m/ECC@${short} has no switch for it in ${declaration.sourcePath}. Next route: do not install ECC's ${declaration.sourcePath} on ${host}, or turn it off with ${host}'s own plugin controls.`,
        };
      });
      decisions.push({ hookId: hook.id, state: "disabled", authority, hosts });
    }
    const set: Record<string, string> = {};
    if (profile !== undefined) set[ECC_HOOK_PROFILE_KEY] = profile;
    if (switched.length > 0) set[ECC_DISABLED_HOOKS_KEY] = switched.join(",");
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
