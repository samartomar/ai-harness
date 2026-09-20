/**
 * The two provenance sentences the Workbench prints under its header: where the
 * administrator catalog came from, and where the baseline evidence came from.
 *
 * Text only, and pure: the page template wraps each line in its own markup.
 * Browser-safe by construction — the model shapes are declared structurally
 * here rather than imported from the Node-side `studio-model.ts`.
 *
 * Neither line is invented: each is absent when the model carries no
 * provenance, so an artifact prepared without a resolved catalog or baseline
 * says nothing about one.
 */

/** The administrator catalog provenance a model may carry. */
export interface CatalogProvenanceLineInputV1 {
  readonly tier: string;
  readonly sourceId: string;
  readonly channel: string;
  readonly resolvedAt: string;
  /** null when the catalog is the packaged fallback and has no download age. */
  readonly ageSeconds: number | null;
  readonly bootstrapProvenance: string;
}

/** The baseline evidence provenance a model may carry. */
export interface BaselineEvidenceProvenanceLineInputV1 {
  readonly tier: string;
  readonly sourceIds: readonly string[];
  readonly schemaVersion: number;
  readonly digest: string;
  readonly ageSeconds: number | null;
  readonly resolvedAt: string;
}

/**
 * "Supported catalog · verified <tier> · source <id> (<channel>) · resolved
 * <at> · <age> · bootstrap <x>", or undefined when no catalog was resolved.
 */
export function catalogProvenanceTextV1(model: {
  readonly catalogProvenance?: CatalogProvenanceLineInputV1 | undefined;
}): string | undefined {
  const provenance = model.catalogProvenance;
  if (provenance === undefined) return undefined;
  const age =
    provenance.ageSeconds === null
      ? "packaged fallback (no download age)"
      : `${String(provenance.ageSeconds)}s since download`;
  return [
    `Supported catalog · verified ${provenance.tier}`,
    `source ${provenance.sourceId} (${provenance.channel})`,
    `resolved ${provenance.resolvedAt}`,
    age,
    `bootstrap ${provenance.bootstrapProvenance}`,
  ].join(" · ");
}

/**
 * "Baseline evidence · <tier> · sources <ids> · schema <n> · digest <d> · age
 * <a> · resolved <at>", or undefined when no baseline evidence was resolved.
 */
export function baselineEvidenceProvenanceTextV1(model: {
  readonly baselineEvidenceProvenance?: BaselineEvidenceProvenanceLineInputV1 | undefined;
}): string | undefined {
  const provenance = model.baselineEvidenceProvenance;
  if (provenance === undefined) return undefined;
  const age =
    provenance.ageSeconds === null ? "packaged fallback" : `${String(provenance.ageSeconds)}s`;
  return [
    `Baseline evidence · ${provenance.tier}`,
    `sources ${provenance.sourceIds.join(",")}`,
    `schema ${String(provenance.schemaVersion)}`,
    `digest ${provenance.digest}`,
    `age ${age}`,
    `resolved ${provenance.resolvedAt}`,
  ].join(" · ");
}
