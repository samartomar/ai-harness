import type { RepoStack } from "../profile/scan.js";
import { allModuleSlugs } from "./rules.js";

/** Frameworks that imply the web/frontend rule module. */
const WEB_FRAMEWORKS = new Set(["Next.js", "React", "Vue", "Svelte", "Angular"]);
/** Frameworks that imply the serverless/AWS module. */
const SERVERLESS_FRAMEWORKS = new Set(["Serverless Framework", "AWS SAM", "AWS CDK"]);

export interface ModuleSelection {
  /** ECC module slugs to install, deterministic order (common first). */
  modules: string[];
  /** True when the repo had no detectable stack, so EVERYTHING was installed. */
  installedEverything: boolean;
}

/** Map one detected language to its ECC module slug, if any. */
function languageModule(language: string): string | undefined {
  if (language === "TypeScript/Node.js") return "typescript";
  if (language === "JavaScript/Node.js") return "javascript";
  if (language === "Python") return "python";
  if (language === "Go") return "go";
  if (language === "Rust") return "rust";
  if (language === ".NET") return "dotnet";
  if (language.startsWith("Java/")) return "java";
  return undefined;
}

/**
 * Choose the ECC modules for a repo. With a detected stack, install `common`
 * plus the matching language/framework modules. With NO detectable stack (an
 * empty/new repo), install EVERYTHING — the user re-runs `aih ecc` once the repo
 * has code and the selection self-heals down to what actually applies.
 */
export function selectModules(stack: RepoStack): ModuleSelection {
  const detectedAnything =
    stack.languages.length > 0 || stack.frameworks.length > 0 || stack.deployment.length > 0;

  if (!detectedAnything) {
    return { modules: allModuleSlugs(), installedEverything: true };
  }

  const wanted = new Set<string>(["common"]);
  for (const language of stack.languages) {
    const slug = languageModule(language);
    if (slug) wanted.add(slug);
  }
  if (stack.frameworks.some((f) => SERVERLESS_FRAMEWORKS.has(f))) wanted.add("serverless-aws");
  if (stack.frameworks.some((f) => WEB_FRAMEWORKS.has(f))) wanted.add("web");

  // Deterministic order: follow the canonical module order, common first.
  const modules = allModuleSlugs().filter((slug) => wanted.has(slug));
  return { modules, installedEverything: false };
}
