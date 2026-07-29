import { z } from "zod";

export const CapabilityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);

export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
