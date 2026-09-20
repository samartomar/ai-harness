import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FONT_DIR = "src/org-policy/workbench/ui/proto/fonts";

const SCREENS_DIR = "prototype/policy-workbench/screens";
/**
 * Icons the prototype injects from JS data rather than writing into markup, so
 * `collectIconNames`'s HTML scan cannot see them: `psychology_alt` from
 * `admin-scan.html`'s GROUPS rows, `description`/`settings` from `user-shell.js`'s
 * policy-source table, `verified` from a `user-start.html` card. A missing name
 * shows the ligature's literal text instead of the glyph; the offline browser
 * spec measures every icon span and fails when one renders as a word.
 */
const EXTRA_ICONS = ["description", "psychology_alt", "settings", "verified"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FAMILIES = [
  {
    cssUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    license: { file: "inter-OFL.txt", url: "https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt" },
  },
  {
    cssUrl: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap",
    license: { file: "jetbrains-mono-OFL.txt", url: "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt" },
  },
];

const LICENSE_FILES = [
  "inter-OFL.txt",
  "jetbrains-mono-OFL.txt",
  "material-symbols-APACHE-2.0.txt",
];

function screenFiles(extensions) {
  return readdirSync(SCREENS_DIR)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .map((name) => join(SCREENS_DIR, name));
}

function collectIconNames() {
  const names = new Set(EXTRA_ICONS);
  const pattern = /material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g;
  for (const file of screenFiles([".html", ".js"])) {
    const text = readFileSync(file, "utf8").replaceAll('\\"', '"');
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * The axis ranges the prototype itself asks Google for. Pinning narrower ranges
 * changes how icons are drawn: `font-optical-sizing` is `auto` by default, so a
 * static `opsz` instance renders every icon at one optical size while the
 * prototype's variable range follows each icon's font-size. The ranges are read
 * out of the prototype's own Material Symbols URL rather than restated here.
 */
function collectAxes() {
  const pattern =
    /fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined:opsz,wght,FILL,GRAD@([^"'&\s]+)/;
  for (const file of screenFiles([".css", ".html", ".js"])) {
    const found = readFileSync(file, "utf8").replaceAll("&amp;", "&").match(pattern);
    if (!found) continue;
    const [opsz, wght, FILL, GRAD] = found[1].split(",");
    if (opsz && wght && FILL && GRAD) return { opsz, wght, FILL, GRAD };
  }
  throw new Error("no Material Symbols Outlined axis specification found in the prototype");
}

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

async function fetchBytes(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

function parseFontFaceBlocks(css, latinOnly) {
  const blocks = [];
  const pattern = /(?:\/\*\s*([^*]+?)\s*\*\/)?\s*@font-face\s*\{([^}]+)\}/g;
  for (const match of css.matchAll(pattern)) {
    const subset = (match[1] ?? "").trim();
    if (latinOnly && subset !== "latin") continue;
    const body = match[2];
    const read = (property) => {
      const found = body.match(new RegExp(`${property}:\\s*([^;]+);`));
      return found ? found[1].trim().replace(/^['"]|['"]$/g, "") : null;
    };
    const urlMatch = body.match(/url\((https:[^)]+)\)/);
    if (!urlMatch) continue;
    blocks.push({
      family: read("font-family"),
      style: read("font-style") ?? "normal",
      weight: read("font-weight"),
      unicodeRange: read("unicode-range"),
      url: urlMatch[1],
    });
  }
  return blocks;
}

function groupByUrl(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    const group = groups.get(block.url) ?? [];
    group.push(block);
    groups.set(block.url, group);
  }
  return [...groups.entries()].map(([url, group]) => {
    // A variable face declares a weight RANGE ("100 700"); a static one a single
    // number. Both collapse to the low/high pair that names the vendored file.
    const numbers = group.flatMap((block) => (block.weight ?? "").trim().split(/\s+/).map(Number));
    const weights = [...new Set(numbers.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    const weight = weights.length === 1 ? String(weights[0]) : `${weights[0]} ${weights[weights.length - 1]}`;
    const first = group[0];
    return { url, family: first.family, style: first.style, weight, unicodeRange: first.unicodeRange };
  });
}

function fileNameFor(family, weight) {
  return `${family.toLowerCase().replaceAll(" ", "-")}-${weight.replaceAll(" ", "-")}.woff2`;
}

async function runFetch() {
  const iconNames = collectIconNames();
  const axes = collectAxes();

  const iconUrl =
    `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD` +
    `@${axes.opsz},${axes.wght},${axes.FILL},${axes.GRAD}` +
    `&icon_names=${iconNames.join(",")}&display=block`;

  const sources = [...FAMILIES.map((family) => family.cssUrl), iconUrl];
  const files = [];
  let iconCss = "";

  for (let index = 0; index < sources.length; index++) {
    const css = await fetchText(sources[index]);
    const latinOnly = index < FAMILIES.length;
    // Google's icon stylesheet also carries the `.material-symbols-outlined`
    // class rule (family, 24px, ligatures, nowrap…). Every prototype icon span
    // depends on it, so it is kept verbatim — never restated by hand.
    if (!latinOnly) iconCss = css.replace(/@font-face\s*\{[^}]*\}/g, "").trim();
    const groups = groupByUrl(parseFontFaceBlocks(css, latinOnly));
    if (groups.length === 0) throw new Error(`no @font-face blocks parsed from ${sources[index]}`);
    for (const group of groups) {
      const file = fileNameFor(group.family, group.weight);
      const bytes = await fetchBytes(group.url);
      writeFileSync(join(FONT_DIR, file), bytes);
      files.push({
        file,
        family: group.family,
        style: group.style,
        weight: group.weight,
        unicodeRange: group.unicodeRange ?? null,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      console.log(`fetched ${file} (${bytes.length} bytes)`);
    }
  }

  mkdirSync(join(FONT_DIR, "licenses"), { recursive: true });
  for (const family of FAMILIES) {
    const text = await fetchText(family.license.url);
    writeFileSync(join(FONT_DIR, "licenses", family.license.file), text);
    console.log(`fetched licenses/${family.license.file}`);
  }
  const materialLicense = await fetchText("https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE");
  writeFileSync(join(FONT_DIR, "licenses", "material-symbols-APACHE-2.0.txt"), materialLicense);
  console.log("fetched licenses/material-symbols-APACHE-2.0.txt");

  if (iconCss === "") throw new Error("no .material-symbols-outlined class rule parsed from Google");
  files.sort((a, b) => a.file.localeCompare(b.file));
  const manifest = {
    schema: 2,
    iconNames,
    axes,
    sources,
    iconCss,
    files,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  writeFileSync(join(FONT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote manifest.json (${files.length} files, ${manifest.totalBytes} bytes, ${iconNames.length} icons)`);

  writeFileSync(
    join(FONT_DIR, "README.md"),
    [
      "# Vendored fonts for the policy workbench prototype",
      "",
      "This folder holds the woff2 fonts (Inter, JetBrains Mono, Material Symbols Outlined) loaded by `prototype/policy-workbench/screens/`, vendored so the product works offline.",
      "Regenerate with `node tools/wb-fonts.mjs --fetch` (the only step that needs the network), then check integrity with `node tools/wb-fonts.mjs --verify`.",
      "Inter and JetBrains Mono are licensed under the SIL Open Font License 1.1 (see `licenses/inter-OFL.txt` and `licenses/jetbrains-mono-OFL.txt`).",
      "Material Symbols Outlined is licensed under the Apache License 2.0 (see `licenses/material-symbols-APACHE-2.0.txt`).",
      "",
    ].join("\n"),
  );
  console.log("wrote README.md");
}

function readManifest() {
  return JSON.parse(readFileSync(join(FONT_DIR, "manifest.json"), "utf8"));
}

function runVerify() {
  const problems = [];
  let manifest;
  try {
    manifest = readManifest();
  } catch (error) {
    console.error(`manifest unreadable: ${error.message}`);
    process.exit(1);
  }

  for (const entry of manifest.files) {
    const path = join(FONT_DIR, entry.file);
    if (!existsSync(path)) {
      problems.push(`missing file: ${entry.file}`);
      continue;
    }
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes) problems.push(`${entry.file}: bytes ${bytes.length} != manifest ${entry.bytes}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) problems.push(`${entry.file}: sha256 mismatch`);
  }

  const expected = new Set(manifest.iconNames);
  for (const name of collectIconNames()) {
    if (!expected.has(name)) problems.push(`icon used by prototype but not in manifest: ${name}`);
  }

  if (typeof manifest.iconCss !== "string" || !manifest.iconCss.includes(".material-symbols-outlined"))
    problems.push("manifest has no verbatim .material-symbols-outlined class rule");
  const axes = collectAxes();
  for (const [axis, value] of Object.entries(axes)) {
    if (manifest.axes?.[axis] !== value)
      problems.push(`axis ${axis}: manifest ${manifest.axes?.[axis]} != prototype ${value}`);
  }

  for (const file of LICENSE_FILES) {
    const path = join(FONT_DIR, "licenses", file);
    if (!existsSync(path) || statSync(path).size === 0) problems.push(`missing or empty licence: licenses/${file}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`fonts ok: ${manifest.files.length} files, ${manifest.totalBytes} bytes, ${manifest.iconNames.length} icons`);
}

/**
 * The offline replacement for the two Google Fonts stylesheets the prototype
 * links: the vendored `@font-face` blocks as data URIs, followed by the icon
 * stylesheet's own class rule exactly as Google served it.
 */
export function fontFaceCss(fontDir = FONT_DIR) {
  const manifest = JSON.parse(readFileSync(join(fontDir, "manifest.json"), "utf8"));
  const faces = manifest.files
    .map((entry) => {
      const base64 = readFileSync(join(fontDir, entry.file)).toString("base64");
      const lines = [
        `font-family: "${entry.family}";`,
        `font-style: ${entry.style};`,
        `font-weight: ${entry.weight};`,
        "font-display: block;",
        `src: url(data:font/woff2;base64,${base64}) format("woff2");`,
      ];
      if (entry.unicodeRange) lines.push(`unicode-range: ${entry.unicodeRange};`);
      return `@font-face {\n  ${lines.join("\n  ")}\n}`;
    })
    .join("\n");
  const iconCss = typeof manifest.iconCss === "string" ? manifest.iconCss.trim() : "";
  if (iconCss === "") throw new Error("Font manifest has no icon class rule. Re-run --fetch.");
  return `${faces}\n${iconCss}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  try {
    if (command === "--fetch") {
      mkdirSync(FONT_DIR, { recursive: true });
      await runFetch();
    } else if (command === "--verify") {
      runVerify();
    } else if (command === "--css") {
      process.stdout.write(`${fontFaceCss()}\n`);
    } else {
      console.error("usage: node tools/wb-fonts.mjs [--fetch|--verify|--css]");
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
