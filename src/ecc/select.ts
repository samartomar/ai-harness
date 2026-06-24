import type { RepoStack } from "../profile/scan.js";

/**
 * ECC's real language-pack tokens (the args to `ecc-install` / `install.sh`,
 * e.g. `--target cursor typescript python`). Source: affaan-m/ECC `rules/`
 * layout. Order here is the canonical install order we emit.
 */
export const ECC_LANGUAGE_PACKS = [
  "typescript",
  "python",
  "golang",
  "swift",
  "php",
  "ruby",
  "web",
  "angular",
  "vue",
  "nuxt",
  "arkts",
] as const;

export type EccLanguagePack = (typeof ECC_LANGUAGE_PACKS)[number];

export interface EccLanguageSelection {
  /** ECC language packs to install for the detected stack (deterministic order). */
  packs: EccLanguagePack[];
  /**
   * True when nothing about the stack was detectable (empty/new repo). The
   * installer then takes the FULL profile (everything) and the user re-runs
   * `aih ecc` once there is code to scope it down.
   */
  installEverything: boolean;
}

/** Map one detected language to its ECC language pack, if ECC ships one. */
function languagePack(language: string): EccLanguagePack | undefined {
  // TypeScript and JavaScript both map to ECC's `typescript` pack (it covers
  // .js/JSDoc explicitly), so a plain-Node repo still gets the right rules.
  if (language === "TypeScript/Node.js" || language === "JavaScript/Node.js") return "typescript";
  if (language === "Python") return "python";
  if (language === "Go") return "golang";
  if (language === "Swift") return "swift";
  if (language === "PHP") return "php";
  if (language === "Ruby") return "ruby";
  // Rust / .NET / Java have no dedicated ECC language pack yet — the baseline
  // (common rules + agents) still installs via the chosen profile.
  return undefined;
}

/** Map one detected framework to an ECC language pack, if it implies one. */
function frameworkPack(framework: string): EccLanguagePack | undefined {
  if (framework === "Angular") return "angular";
  if (framework === "Nuxt") return "nuxt";
  if (framework === "Vue") return "vue";
  if (framework === "Next.js" || framework === "React" || framework === "Svelte") return "web";
  return undefined;
}

/**
 * Choose the ECC language packs for a repo from the detected stack. With a
 * detectable stack, select the packs that match its languages/frameworks. With
 * NO detectable stack (empty/new repo), signal `installEverything` so the
 * installer takes the full profile; the user re-runs once there is code and the
 * selection scopes down to exactly what applies.
 */
export function eccLanguages(stack: RepoStack): EccLanguageSelection {
  const detectedAnything =
    stack.languages.length > 0 || stack.frameworks.length > 0 || stack.deployment.length > 0;

  if (!detectedAnything) {
    return { packs: [], installEverything: true };
  }

  const wanted = new Set<EccLanguagePack>();
  for (const language of stack.languages) {
    const pack = languagePack(language);
    if (pack) wanted.add(pack);
  }
  for (const framework of stack.frameworks) {
    const pack = frameworkPack(framework);
    if (pack) wanted.add(pack);
  }
  // Web frameworks already imply `web`; if Vue/Angular/Nuxt matched, keep the
  // more specific pack(s) AND `web` is only added when a bare web framework hit.
  const packs = ECC_LANGUAGE_PACKS.filter((p) => wanted.has(p));
  return { packs, installEverything: false };
}
