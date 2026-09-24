import {
  type Action,
  AihError,
  doc,
  type FrameworkHookControlAuthorityV1,
  type FrameworkHookControlDecisionV1,
  type FrameworkHookControlPlanV1,
  type FrameworkHookControlRequestV1,
  type FrameworkHookHostDecisionV1,
  type FrameworkHookInventoryV1,
  type FrameworkOperationContextV1,
  lines,
} from "@aihq/core/framework-host";
import { readSuperpowersDescriptor, readSuperpowersHookInventory } from "./descriptor.js";

/** The hooks obra/Superpowers declares at the pinned commit, read from Catalog's bytes. */
export function hookInventory(ctx: FrameworkOperationContextV1): FrameworkHookInventoryV1 {
  return readSuperpowersHookInventory(readSuperpowersDescriptor(ctx.descriptor));
}

/**
 * Decide each hook for the targeted hosts under the disable requests Core's
 * policy view carries. obra/Superpowers ships no per-hook switch at the pinned
 * commit and aih does not install the plugin (the host's own plugin manager
 * does), so a disabled hook that runs on a targeted host is `unenforced`: a
 * label with the next route, never a reason to hide the framework.
 */
export function planHookControls(
  ctx: FrameworkOperationContextV1,
  request: FrameworkHookControlRequestV1,
): FrameworkHookControlPlanV1 {
  const inventory = hookInventory(ctx);
  if (request.profile !== undefined) {
    throw new AihError(
      `obra/Superpowers has no hook profiles; the ${request.profile.authority} hook profile ${request.profile.id} is refused`,
      "AIH_CONFIG",
    );
  }
  const known = new Set(inventory.hooks.map((hook) => hook.id));
  const unknown = [
    ...new Set(request.disabled.map((entry) => entry.hookId).filter((id) => !known.has(id))),
  ];
  if (unknown.length > 0) {
    throw new AihError(
      `unknown obra/Superpowers hook id(s) ${unknown.join(", ")}; the pinned inventory has ${[...known].join(", ")}`,
      "AIH_CONFIG",
    );
  }
  const short = inventory.upstream.commit.slice(0, 12);
  const decisions: FrameworkHookControlDecisionV1[] = [];
  const actions: Action[] = [];
  for (const hook of inventory.hooks) {
    const requests = request.disabled.filter((entry) => entry.hookId === hook.id);
    if (requests.length === 0) {
      decisions.push({ hookId: hook.id, state: "enabled", hosts: [] });
      continue;
    }
    const authority: FrameworkHookControlAuthorityV1 = requests.some(
      (entry) => entry.authority === "enterprise",
    )
      ? "enterprise"
      : "user";
    const hosts: FrameworkHookHostDecisionV1[] = ctx.targets.map((host) =>
      hook.declarations.some((declaration) => declaration.host === host)
        ? {
            host,
            enforcement: "unenforced",
            detail: `aih cannot turn ${hook.id} off on ${host}: obra/Superpowers@${short} has no switch for it, and ${host}'s own plugin manager installs and runs it. Next route: leave the Superpowers plugin disabled on ${host}, or use ${host}'s own hook controls.`,
          }
        : {
            host,
            enforcement: "not-applicable",
            detail: `${hook.id} does not run on ${host}.`,
          },
    );
    decisions.push({ hookId: hook.id, state: "disabled", authority, hosts });
    const unenforced = hosts
      .filter((host) => host.enforcement === "unenforced")
      .map((host) => host.host);
    // Declared hosts aih does not control are never decisions (aih targets
    // none of them); they are labelled unenforced with their own next route.
    const uncontrolled = hook.declarations.filter(
      (declaration) => declaration.hostControl !== undefined,
    );
    if (unenforced.length > 0 || uncontrolled.length > 0) {
      const onHosts = [...unenforced, ...uncontrolled.map((declaration) => declaration.host)];
      actions.push(
        doc(
          `Superpowers ${hook.id} disabled by ${authority} policy — not enforceable by aih on ${onHosts.join(", ")}`,
          lines(
            hook.summary,
            `Policy (${authority}) disables ${hook.id} (${hook.event}).`,
            ...(unenforced.length === 0
              ? []
              : [
                  `obra/Superpowers@${short} has no switch for this hook, and each host's own plugin manager`,
                  `installs and runs it, so aih cannot turn it off on: ${unenforced.join(", ")}.`,
                  "Next route: leave the Superpowers plugin disabled on those hosts, or use each host's own hook controls.",
                ]),
            ...uncontrolled.map(
              (declaration) =>
                `${declaration.host}: unenforced — ${hook.id} is declared for ${declaration.host} in ${declaration.sourcePath}. Next route: ${declaration.hostControl?.nextRoute}.`,
            ),
          ),
        ),
      );
    }
  }
  return { frameworkId: "superpowers", decisions, actions };
}
