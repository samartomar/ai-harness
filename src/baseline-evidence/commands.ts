import { resolve } from "node:path";
import { AihError } from "../errors.js";
import { writeArtifact } from "../internals/execute.js";
import {
  type Action,
  type CommandSpec,
  dynamicDigest,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import { requiredBaselineVetOptions } from "./analyzer-profile.js";
import { type BaselineCatalog, defineBaselineCatalog } from "./catalog.js";
import { baselineCatalogById } from "./catalogs.js";
import {
  BASELINE_REPORTS_DIR,
  type BaselineSourceEvidence,
  parseBaselineEvidenceLock,
} from "./schema.js";
import { vetBaselineCatalog } from "./vet.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

export interface BaselineVetPlanOptions {
  vetCatalog?: typeof vetBaselineCatalog;
  cleanupQuarantine?: boolean;
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function reportPath(catalog: BaselineCatalog): string {
  return `${BASELINE_REPORTS_DIR}/${catalog.id}-${catalog.pinnedSha.slice(0, 12)}.json`;
}

async function exactSourceRoot(
  ctx: PlanContext,
  source: TrustSource,
  catalog: BaselineCatalog,
): Promise<string> {
  if (source.kind === "github") {
    const metadata = readTrustFetchMetadata(source);
    if (
      metadata.owner.toLowerCase() !== catalog.owner.toLowerCase() ||
      metadata.repo.toLowerCase() !== catalog.repo.toLowerCase() ||
      metadata.pinnedSha !== catalog.pinnedSha ||
      resolve(metadata.treePath) !== resolve(source.treePath)
    ) {
      throw new AihError(
        `fetched source does not match ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
        "AIH_TRUST",
      );
    }
    return assertTrustTreeSafe(source.treePath);
  }
  const head = await ctx.run(["git", "-C", source.root, "rev-parse", "HEAD"]);
  const actual = head.stdout.trim().toLowerCase();
  if (head.code !== 0 || actual !== catalog.pinnedSha) {
    throw new AihError(
      `local checkout is ${actual || "unreadable"}, expected pinned ${catalog.pinnedSha}`,
      "AIH_TRUST",
    );
  }
  return assertTrustTreeSafe(source.root);
}

export async function baselineVetPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
  catalog: BaselineCatalog,
  options: BaselineVetPlanOptions = {},
): Promise<Plan> {
  const actions: Action[] = [];
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(
    dynamicDigest("baseline vet result", async (digestCtx) => {
      try {
        if (!digestCtx.apply) {
          return {
            text: `Would vet ${catalog.components.length} component(s) from ${source.display} at exact pin ${catalog.pinnedSha}; pass --apply to fetch/scan and write the report.`,
            data: {
              catalog: catalog.id,
              pinnedSha: catalog.pinnedSha,
              components: catalog.components.map((component) => component.id),
            },
          };
        }
        const sourceRoot = await exactSourceRoot(digestCtx, source, catalog);
        const vet = options.vetCatalog ?? vetBaselineCatalog;
        const evidence: BaselineSourceEvidence = await vet(
          sourceRoot,
          catalog,
          requiredBaselineVetOptions({
            run: digestCtx.run,
            platform: digestCtx.host.platform,
            env: digestCtx.env,
            progress: (message) => process.stderr.write(`${message}\n`),
          }),
        );
        const lock = parseBaselineEvidenceLock({ schemaVersion: 1, sources: [evidence] });
        const rel = reportPath(catalog);
        writeArtifact(digestCtx, rel, `${JSON.stringify(lock, null, 2)}\n`);
        return {
          text: `Vetted ${catalog.components.length} component(s) from ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}; wrote ${rel}. This command installed nothing.`,
          data: lock,
        };
      } finally {
        if (options.cleanupQuarantine === true) cleanupQuarantine(source);
      }
    }),
  );
  return plan("evidence vet-baseline", ...actions);
}

function selectedCatalog(ctx: PlanContext, id: string, pin: string): BaselineCatalog {
  const base = baselineCatalogById(id, pin);
  const raw = optionString(ctx, "components");
  if (raw === undefined) return base;
  const requested = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) {
    throw new AihError("--components must name at least one component", "AIH_CONFIG");
  }
  const selected = base.components.filter((component) => requested.includes(component.id));
  const missing = requested.filter((id) => !selected.some((component) => component.id === id));
  if (missing.length > 0) {
    throw new AihError(
      `unknown ${base.id} baseline component(s): ${missing.join(", ")}`,
      "AIH_CONFIG",
    );
  }
  return defineBaselineCatalog({ ...base, components: selected });
}

async function vetBaselinePlan(ctx: PlanContext): Promise<Plan> {
  const sourceText = optionString(ctx, "source");
  const pin = optionString(ctx, "pin");
  const catalogId = optionString(ctx, "catalog");
  if (sourceText === undefined) {
    throw new AihError("evidence vet-baseline requires <source>", "AIH_CONFIG");
  }
  if (pin === undefined || !FULL_SHA.test(pin)) {
    throw new AihError("--pin must be a lowercase 40-character commit SHA", "AIH_CONFIG");
  }
  if (catalogId === undefined) {
    throw new AihError("--catalog is required (ecc|superpowers)", "AIH_CONFIG");
  }
  const catalog = selectedCatalog(ctx, catalogId, pin);
  const source = resolveTrustSource(sourceText, { root: ctx.root, pin });
  if (
    source.kind === "github" &&
    (source.owner.toLowerCase() !== catalog.owner.toLowerCase() ||
      source.repo.toLowerCase() !== catalog.repo.toLowerCase())
  ) {
    cleanupQuarantine(source);
    throw new AihError(
      `--catalog ${catalog.id} requires source ${catalog.owner}/${catalog.repo}`,
      "AIH_CONFIG",
    );
  }
  return baselineVetPlanForSource(ctx, source, catalog, { cleanupQuarantine: true });
}

export const vetBaselineCommand: CommandSpec = {
  name: "vet-baseline",
  summary: "Vet exact-pinned baseline components into a signable local evidence report",
  positional: {
    name: "source",
    description: "local checkout or GitHub owner/repo",
    required: true,
    optionName: "source",
  },
  options: [
    { flags: "--pin <sha>", description: "exact lowercase 40-character source commit" },
    { flags: "--catalog <id>", description: "baseline catalog: ecc|superpowers" },
    {
      flags: "--components <csv>",
      description: "optional comma-separated component IDs (default: entire catalog)",
    },
  ],
  plan: vetBaselinePlan,
};
