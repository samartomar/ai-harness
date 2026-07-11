import { z } from "zod";
import { BaselineComponentIdSchema, BaselineComponentPathSchema } from "./schema.js";

export const BaselineCatalogComponentSchema = z
  .object({
    id: BaselineComponentIdSchema,
    paths: z.array(BaselineComponentPathSchema).min(1),
    skillContent: z.literal(true).optional(),
  })
  .strict()
  .superRefine((component, ctx) => {
    const paths = new Set<string>();
    for (const [index, path] of component.paths.entries()) {
      if (paths.has(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["paths", index],
          message: `duplicate component path: ${path}`,
        });
      }
      paths.add(path);
    }
  });

export const BaselineCatalogSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    pinnedSha: z.string().regex(/^[0-9a-f]{40}$/),
    components: z.array(BaselineCatalogComponentSchema).min(1),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    for (const [index, component] of catalog.components.entries()) {
      if (ids.has(component.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "id"],
          message: `duplicate component id: ${component.id}`,
        });
      }
      ids.add(component.id);
    }
  });

export type BaselineCatalogComponent = z.infer<typeof BaselineCatalogComponentSchema>;
export type BaselineCatalog = z.infer<typeof BaselineCatalogSchema>;

export function defineBaselineCatalog(value: unknown): BaselineCatalog {
  return BaselineCatalogSchema.parse(value);
}

export function resolveCatalogComponents(
  catalog: BaselineCatalog,
  requestedIds: readonly string[],
): BaselineCatalogComponent[] {
  const requested = new Set<string>();
  for (const id of requestedIds) {
    if (requested.has(id)) throw new Error(`duplicate requested baseline component id: ${id}`);
    requested.add(id);
  }
  const known = new Set(catalog.components.map((component) => component.id));
  const unknown = [...requested].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown baseline component id(s): ${unknown.sort().join(", ")}`);
  }
  return catalog.components.filter((component) => requested.has(component.id));
}
