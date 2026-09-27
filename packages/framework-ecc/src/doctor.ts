import type { FrameworkDoctorHookV1 } from "@aihq/core/framework-host";

/** ECC installation is developer-managed; aih has no ECC receipts to diagnose. */
export const doctor: FrameworkDoctorHookV1 = Object.freeze({
  checks: async () => [],
});
