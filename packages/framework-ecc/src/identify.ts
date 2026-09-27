import {
  type FrameworkComponentsV1,
  type FrameworkOperationContextV1,
  scanRepo,
} from "@aihq/core/framework-host";
import { eccLanguages } from "./ecc/select.js";
import { UPSTREAM } from "./identity.js";
import { currentEccInvocation, withEccInvocation } from "./invocation.js";

/** Report the pinned ECC source and language guidance for the detected stack. */
export function identifyComponents(ctx: FrameworkOperationContextV1): FrameworkComponentsV1 {
  return withEccInvocation(ctx, () =>
    Object.freeze({
      frameworkId: "ecc",
      upstream: Object.freeze({
        repository: UPSTREAM.repository,
        commit: currentEccInvocation().descriptor.source.commit,
      }),
      components: Object.freeze([]),
      languagePacks: Object.freeze([...eccLanguages(scanRepo(ctx.root, { maxDepth: 8 })).packs]),
    }),
  );
}
