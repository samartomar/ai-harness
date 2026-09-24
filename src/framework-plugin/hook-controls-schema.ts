import { z } from "zod";

/**
 * The framework hook-control carrier, one grammar for both authorities:
 *
 * - enterprise policy `governance.frameworkHookControls` (schema 3, Core 0.7.0);
 * - the project's `.aih-config.json` `frameworkHookControls` (the user list).
 *
 * Keyed by framework id (the closed plugin set). Core checks syntax only: which
 * hook ids and profiles exist is the plugin's inventory, and the plugin refuses
 * an id or profile it does not have. A user may only ADD disables; enterprise
 * outranks user ({@link mergeFrameworkHookControlRequestV1}).
 */

const HookIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9:-]{0,99}$/, "must be a framework hook id such as session:start");

export const FrameworkHookControlEntrySchema = z
  .object({
    /** The framework's own hook profile id, when the framework has profiles. */
    profile: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/, "must be a framework hook profile id")
      .optional(),
    disabledHookIds: z
      .array(HookIdSchema)
      .max(128)
      .refine((ids) => new Set(ids).size === ids.length, "hook ids must be unique"),
  })
  .strict();

export const FrameworkHookControlsSchema = z
  .object({
    ecc: FrameworkHookControlEntrySchema.optional(),
    superpowers: FrameworkHookControlEntrySchema.optional(),
  })
  .strict();

export type FrameworkHookControlEntry = z.infer<typeof FrameworkHookControlEntrySchema>;
export type FrameworkHookControls = z.infer<typeof FrameworkHookControlsSchema>;
