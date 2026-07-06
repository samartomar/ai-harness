import { basename, extname } from "node:path";

// Extensions that are never shell/interpreter scripts. This excludes
// installer-named media/archive assets while still covering extensionless
// setup scripts such as `install` and `setup`.
const NON_SCRIPT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
]);

const MALICIOUS_CODE_SCRIPT_EXTENSIONS = new Set([
  "",
  ".bash",
  ".bat",
  ".cjs",
  ".cmd",
  ".js",
  ".mjs",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".zsh",
]);

const EXECUTABLE_INSTALL_SCRIPT_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".zsh",
]);

const SCRIPT_LIKE_SUBSTRINGS = [
  "install",
  "setup",
  "configure",
  "bootstrap",
  "entrypoint",
  "postinstall",
  "preinstall",
  "build",
  "script",
];

function isIgnoredPackageManifest(name: string): boolean {
  return name === "package.json" || name === "package-lock.json";
}

function hasScriptLikeName(name: string): boolean {
  return SCRIPT_LIKE_SUBSTRINGS.some((needle) => name.includes(needle));
}

export function isMaliciousCodeScanFilePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (isIgnoredPackageManifest(name)) return false;
  const ext = extname(name);
  if (MALICIOUS_CODE_SCRIPT_EXTENSIONS.has(ext)) return true;
  if (NON_SCRIPT_EXTENSIONS.has(ext)) return false;
  return hasScriptLikeName(name);
}

export function isInstallScriptEvidenceFilePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (isIgnoredPackageManifest(name)) return false;
  const ext = extname(name);
  if (NON_SCRIPT_EXTENSIONS.has(ext)) return false;
  if (EXECUTABLE_INSTALL_SCRIPT_EXTENSIONS.has(ext)) return true;
  if (ext === "") return hasScriptLikeName(name);
  return MALICIOUS_CODE_SCRIPT_EXTENSIONS.has(ext) && hasScriptLikeName(name);
}
