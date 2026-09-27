import { z } from "zod";

/**
 * The framework hook-control carrier, one grammar for both authorities:
 *
 * - enterprise policy `governance.frameworkHookControls` (schema 3, Core 0.7.0);
 * - the project's `.aih-config.json` `frameworkHookControls` (the user list).
 *
 * Keyed by framework id (the closed plugin set). Core checks syntax only: which
 * hook ids and profiles exist is the plugin's inventory, and the plugin refuses
 * an id or profile it does not have. Enterprise policy is the only profile
 * source; the user list has its own narrower grammar that may only ADD disables
 * ({@link FrameworkUserHookControlsSchema}).
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

/**
 * The user list grammar: disables only. A profile (or any other field) is not a
 * user control — a profile switches every hook at once, past each row's
 * individual disable eligibility, so only enterprise policy may set one.
 */
export const FrameworkUserHookControlEntrySchema = FrameworkHookControlEntrySchema.pick({
  disabledHookIds: true,
}).strict();

export const FrameworkUserHookControlsSchema = z
  .object({
    ecc: FrameworkUserHookControlEntrySchema.optional(),
    superpowers: FrameworkUserHookControlEntrySchema.optional(),
  })
  .strict();

export type FrameworkHookControlEntry = z.infer<typeof FrameworkHookControlEntrySchema>;
export type FrameworkHookControls = z.infer<typeof FrameworkHookControlsSchema>;
export type FrameworkUserHookControlEntry = z.infer<typeof FrameworkUserHookControlEntrySchema>;
export type FrameworkUserHookControls = z.infer<typeof FrameworkUserHookControlsSchema>;
