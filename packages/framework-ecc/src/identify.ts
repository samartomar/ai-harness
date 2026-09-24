import {
  AihError,
  type Cli,
  type FrameworkComponentsV1,
  type FrameworkComponentV1,
  type FrameworkOperationContextV1,
  scanRepo,
  z,
} from "@aihq/core/framework-host";
import { selectEccComponents } from "./ecc/components.js";
import { eccEvidenceComponentIdsForSelection } from "./ecc/evidence.js";
import { isAihDirectEccInstallTarget } from "./ecc/install.js";
import { declarations } from "./ecc/pipeline.js";
import { eccLanguages } from "./ecc/select.js";
import { UPSTREAM } from "./identity.js";
import {
  currentEccInvocation,
  eccDescriptorMemo,
  eccDescriptorSection,
  withEccInvocation,
} from "./invocation.js";

const VendorLockComponentsSchema = z.object({
  components: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/),
        paths: z.array(z.string().min(1).max(240)).min(1),
      }),
    )
    .min(1),
});

/** Source paths of every pinned ECC evidence component, from Catalog's vendor lock. */
function componentPaths(): ReadonlyMap<string, readonly string[]> {
  return eccDescriptorMemo("identify.componentPaths", () => {
    const parsed = VendorLockComponentsSchema.safeParse(eccDescriptorSection("vendorLock"));
    if (!parsed.success) {
      throw new AihError(
        "ecc descriptor refused: vendorLock.components is malformed",
        "AIH_FRAMEWORK_DESCRIPTOR",
      );
    }
    return new Map(parsed.data.components.map((component) => [component.id, component.paths]));
  });
}

/** The evidence components `aih ecc` would verify for one host, in selection order. */
function componentIdsFor(cli: Cli, selection: ReturnType<typeof selectEccComponents>): string[] {
  if (isAihDirectEccInstallTarget(cli) || cli === "codex") {
    return eccEvidenceComponentIdsForSelection(cli, selection);
  }
  return cli === "kiro" ? ["runtime:ecc-kiro"] : [];
}

/**
 * The ECC components that apply at the target root for the targeted hosts:
 * the stack Core's scanner detects selects ECC's language packs, the invocation's
 * `profile` (default `minimal`) and `with` declarations select the components,
 * and each host keeps the components its install route verifies. Hosts with a
 * consult-only route get none.
 */
export function identifyComponents(ctx: FrameworkOperationContextV1): FrameworkComponentsV1 {
  return withEccInvocation(ctx, () => {
    const stack = scanRepo(ctx.root, { maxDepth: 8 });
    const selection = selectEccComponents({
      stack,
      posture: ctx.policy.posture,
      profile: String(ctx.options.profile ?? "minimal"),
      declarations: declarations(ctx.options),
    });
    const paths = componentPaths();
    const byId = new Map<string, { paths: readonly string[]; hosts: Cli[] }>();
    for (const cli of ctx.targets) {
      for (const id of componentIdsFor(cli, selection)) {
        const known = paths.get(id);
        if (known === undefined) {
          throw new AihError(
            `ECC component ${id} is not in Catalog's pinned vendor lock for affaan-m/ECC@${currentEccInvocation().descriptor.source.commit.slice(0, 12)}`,
            "AIH_FRAMEWORK_DESCRIPTOR",
          );
        }
        const entry = byId.get(id) ?? { paths: known, hosts: [] };
        entry.hosts.push(cli);
        byId.set(id, entry);
      }
    }
    const components = [...byId].map(
      ([id, entry]): FrameworkComponentV1 =>
        Object.freeze({
          id,
          paths: Object.freeze([...entry.paths]),
          hosts: Object.freeze(entry.hosts),
        }),
    );
    return Object.freeze({
      frameworkId: "ecc",
      upstream: Object.freeze({
        repository: UPSTREAM.repository,
        commit: currentEccInvocation().descriptor.source.commit,
      }),
      components: Object.freeze(components),
      languagePacks: Object.freeze([...eccLanguages(stack).packs]),
    });
  });
}
