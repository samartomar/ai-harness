/**
 * The framework plugin packages are optional peers of `@aihq/core`, imported
 * only by `src/framework-plugin/load-framework-plugin.ts` through their literal
 * specifiers. Their exports are verified at run time, so Core types them as
 * unknown here instead of depending on the packages' own declarations.
 */
declare module "@aihq/framework-ecc" {
  export const aihFrameworkPluginV1: unknown;
}

declare module "@aihq/framework-superpowers" {
  export const aihFrameworkPluginV1: unknown;
}
