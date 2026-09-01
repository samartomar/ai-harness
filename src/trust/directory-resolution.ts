import { z } from "zod";
import { ExactSemverV2Schema } from "../org-policy/governance-decision-v2.js";

const MAX_DIRECTORY_BYTES = 1024 * 1024;
const MAX_DISCOVERED_URLS = 64;
const DIRECTORY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGISTRY_NAME_IN_TEXT =
  /\b([A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export const DIRECTORY_REGISTRY_ORIGIN = "https://registry.modelcontextprotocol.io" as const;

export type DirectoryProviderV1 = "pulsemcp" | "mcpmarket";

export interface DirectoryDiscoverySourceV1 {
  provider: DirectoryProviderV1;
  url: string;
  slug: string;
}

const canonicalHttpsUrl = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({ code: "custom", message: "URL must be canonical HTTPS" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "URL must be canonical HTTPS" });
  }
});

const canonicalPublicHttpsUrl = canonicalHttpsUrl.superRefine((value, context) => {
  try {
    if (new URL(value).search !== "") {
      context.addIssue({ code: "custom", message: "public URL must not contain a query" });
    }
  } catch {
    // canonicalHttpsUrl reports the malformed URL.
  }
});

const npmRegistryOrigin = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/" ||
      (value !== url.origin && value !== `${url.origin}/`)
    ) {
      context.addIssue({
        code: "custom",
        message: "npm registry must be a canonical HTTPS origin",
      });
    }
  } catch {
    context.addIssue({ code: "custom", message: "npm registry must be a canonical HTTPS origin" });
  }
});

const githubRepositoryUrl = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const repositoryName = (parts[1] ?? "").replace(/\.git$/, "");
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      parts.length !== 2 ||
      !REGISTRY_NAME.test(`${parts[0] ?? ""}/${repositoryName}`)
    ) {
      context.addIssue({
        code: "custom",
        message: "GitHub repository must be a canonical owner/repository URL",
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "GitHub repository must be a canonical owner/repository URL",
    });
  }
});

const repository = z
  .object({
    url: githubRepositoryUrl,
    source: z.literal("github"),
  })
  .strip();

const environmentVariable = z
  .object({
    name: z.string().regex(ENVIRONMENT_NAME),
    isSecret: z.boolean().optional(),
    format: z.string().max(100).optional(),
  })
  .strip();

const registryPackage = z
  .object({
    registryType: z.string().max(32),
    registryBaseUrl: npmRegistryOrigin.optional(),
    identifier: z.string().min(1).max(512),
    version: ExactSemverV2Schema.optional(),
    runtimeHint: z.string().min(1).max(64).optional(),
    transport: z.object({ type: z.string().min(1).max(64) }).strip(),
    environmentVariables: z.array(environmentVariable).max(64).optional(),
  })
  .strip();

const registryRemote = z
  .object({
    type: z.string().min(1).max(64),
    url: canonicalPublicHttpsUrl,
  })
  .strip();

const registryServer = z
  .object({
    name: z.string().regex(REGISTRY_NAME),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
    version: ExactSemverV2Schema,
    repository: repository.optional(),
    packages: z.array(registryPackage).max(64).optional(),
    remotes: z.array(registryRemote).max(64).optional(),
  })
  .strip();

const registryEntry = z
  .object({
    server: registryServer,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export const DirectoryRegistryResponseV1Schema = z
  .object({
    servers: z.array(registryEntry).max(100),
    metadata: z
      .object({
        count: z.number().int().min(0).max(100_000),
        nextCursor: z.string().max(1_000).optional(),
      })
      .strip(),
  })
  .strip();

export type DirectoryRegistryResponseV1 = z.infer<typeof DirectoryRegistryResponseV1Schema>;

export const DirectoryClaimV1Schema = z
  .object({
    provider: z.enum(["pulsemcp", "mcpmarket"]),
    discoveryUrl: canonicalHttpsUrl,
    slug: z.string().regex(DIRECTORY_SLUG),
    title: z.string().min(1).max(200).optional(),
    registryName: z.string().regex(REGISTRY_NAME).optional(),
    version: ExactSemverV2Schema.optional(),
    repository: z.string().regex(REGISTRY_NAME).optional(),
    endpoints: z
      .array(
        z
          .object({
            url: canonicalHttpsUrl,
            transport: z.enum(["sse", "streamable-http"]).optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

export type DirectoryClaimV1 = z.infer<typeof DirectoryClaimV1Schema>;

export const DirectoryResolutionConflictV1Schema = z
  .object({
    field: z.enum(["version", "repository", "endpoint"]),
    claimed: z.string().min(1).max(4_096),
    observed: z.string().min(1).max(4_096),
    code: z.enum([
      "directory.version-mismatch",
      "directory.repository-mismatch",
      "directory.endpoint-mismatch",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.field !== "endpoint") return;
    const endpointList = (input: string, allowNone: boolean): boolean => {
      if (allowNone && input === "none") return true;
      const endpoints = input.split(", ");
      return (
        endpoints.length > 0 &&
        endpoints.length <= 16 &&
        endpoints.every((endpoint) => canonicalPublicHttpsUrl.safeParse(endpoint).success)
      );
    };
    if (!endpointList(value.claimed, false)) {
      context.addIssue({
        code: "custom",
        path: ["claimed"],
        message: "endpoint conflict claimed value must contain canonical public HTTPS URLs",
      });
    }
    if (!endpointList(value.observed, true)) {
      context.addIssue({
        code: "custom",
        path: ["observed"],
        message:
          "endpoint conflict observed value must contain canonical public HTTPS URLs or none",
      });
    }
  });

export type DirectoryResolutionConflictV1 = z.infer<typeof DirectoryResolutionConflictV1Schema>;

const resolutionOptionId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const npmResolutionExecution = z
  .object({
    transport: z.string().min(1).max(64),
    resolver: z.literal("npx").optional(),
  })
  .strict();
const remoteResolutionExecution = z
  .object({
    transport: z.string().min(1).max(64),
  })
  .strict();
const registryServerBinding = z
  .object({
    name: z.string().regex(REGISTRY_NAME),
    version: ExactSemverV2Schema,
  })
  .strict();
const npmResolutionSource = z
  .object({
    type: z.literal("npm"),
    registry: npmRegistryOrigin,
    package: z.string().regex(PACKAGE_NAME),
    version: ExactSemverV2Schema,
  })
  .strict();
const remoteResolutionSource = z
  .object({ type: z.literal("remote"), endpoint: canonicalPublicHttpsUrl })
  .strict();
const registryResolutionSource = z.discriminatedUnion("type", [
  npmResolutionSource,
  remoteResolutionSource,
]);

function resolutionSourceKey(source: z.infer<typeof registryResolutionSource>): string {
  return source.type === "npm"
    ? `npm\u0000${source.registry}\u0000${source.package}\u0000${source.version}`
    : `remote\u0000${source.endpoint}`;
}

export const DirectoryResolutionOptionV1Schema = z.union([
  z
    .object({
      id: resolutionOptionId,
      server: registryServerBinding,
      source: npmResolutionSource,
      execution: npmResolutionExecution,
      secrets: z.array(z.string().regex(ENVIRONMENT_NAME)).max(64),
    })
    .strict(),
  z
    .object({
      id: resolutionOptionId,
      server: registryServerBinding,
      source: remoteResolutionSource,
      execution: remoteResolutionExecution,
      secrets: z.array(z.string().regex(ENVIRONMENT_NAME)).max(64),
    })
    .strict(),
]);

export type DirectoryResolutionOptionV1 = z.infer<typeof DirectoryResolutionOptionV1Schema>;

export const DirectoryResolutionV1Schema = z
  .object({
    state: z.enum(["resolved", "mismatched", "ambiguous", "unresolved"]),
    authority: z.object({ state: z.literal("not-authority") }).strict(),
    claim: DirectoryClaimV1Schema,
    registry: z
      .object({
        origin: z.literal(DIRECTORY_REGISTRY_ORIGIN),
        name: z.string().regex(REGISTRY_NAME),
        version: ExactSemverV2Schema,
        repository: z.string().regex(REGISTRY_NAME).optional(),
        sources: z.array(registryResolutionSource).max(128),
      })
      .strict()
      .optional(),
    conflicts: z.array(DirectoryResolutionConflictV1Schema).max(16),
    options: z.array(DirectoryResolutionOptionV1Schema).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const exactState = value.state === "resolved" || value.state === "mismatched";
    if (exactState && value.registry === undefined) {
      context.addIssue({
        code: "custom",
        path: ["registry"],
        message: "resolved directory state requires official registry identity",
      });
    }
    if (value.state === "resolved" && value.conflicts.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["conflicts"],
        message: "resolved directory state cannot contain conflicts",
      });
    }
    if (value.state === "mismatched" && value.conflicts.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["conflicts"],
        message: "mismatched directory state requires a conflict",
      });
    }
    if (
      !exactState &&
      (value.registry !== undefined || value.conflicts.length > 0 || value.options.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "ambiguous or unresolved directory state cannot claim exact options",
      });
    }
    const expectedCode = {
      version: "directory.version-mismatch",
      repository: "directory.repository-mismatch",
      endpoint: "directory.endpoint-mismatch",
    } as const;
    for (const [index, conflict] of value.conflicts.entries()) {
      if (conflict.code !== expectedCode[conflict.field]) {
        context.addIssue({
          code: "custom",
          path: ["conflicts", index, "code"],
          message: "directory conflict field and code are mismatched",
        });
      }
    }
    if (new Set(value.options.map((option) => option.id)).size !== value.options.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "duplicate directory resolution option",
      });
    }
    if (value.registry !== undefined) {
      const registrySources = new Set(value.registry.sources.map(resolutionSourceKey));
      if (registrySources.size !== value.registry.sources.length) {
        context.addIssue({
          code: "custom",
          path: ["registry", "sources"],
          message: "directory registry sources must be unique",
        });
      }
      const optionSources = new Set(
        value.options.map((option) => resolutionSourceKey(option.source)),
      );
      for (const [index, option] of value.options.entries()) {
        if (
          option.server.name !== value.registry.name ||
          option.server.version !== value.registry.version
        ) {
          context.addIssue({
            code: "custom",
            path: ["options", index, "server"],
            message: "directory resolution option server binding does not match registry identity",
          });
        }
        if (!registrySources.has(resolutionSourceKey(option.source))) {
          context.addIssue({
            code: "custom",
            path: ["options", index, "source"],
            message: "directory resolution option source binding is absent from registry record",
          });
        }
      }
      if (optionSources.size !== registrySources.size) {
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "directory resolution options do not cover the registry source record",
        });
      }
    }
  });

export type DirectoryResolutionV1 = z.infer<typeof DirectoryResolutionV1Schema>;

function canonicalDirectoryUrl(raw: string): DirectoryDiscoverySourceV1 {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("directory discovery URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("directory discovery URL must be canonical HTTPS without credentials");
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let provider: DirectoryProviderV1;
  if (host === "pulsemcp.com" || host === "www.pulsemcp.com") {
    provider = "pulsemcp";
    if (parts.length !== 2 || parts[0] !== "servers") {
      throw new TypeError("directory discovery URL must identify one PulseMCP server");
    }
  } else if (host === "mcpmarket.com" || host === "www.mcpmarket.com") {
    provider = "mcpmarket";
    if (parts.length !== 2 || parts[0] !== "server") {
      throw new TypeError("directory discovery URL must identify one MCP Market server");
    }
  } else {
    throw new TypeError("directory discovery URL provider is unsupported");
  }
  const slug = parts[1] ?? "";
  if (!DIRECTORY_SLUG.test(slug)) {
    throw new TypeError("directory discovery URL server slug is invalid");
  }
  const canonicalHost = provider === "pulsemcp" ? "www.pulsemcp.com" : "mcpmarket.com";
  const prefix = provider === "pulsemcp" ? "servers" : "server";
  return { provider, slug, url: `https://${canonicalHost}/${prefix}/${slug}` };
}

export function parseDirectoryDiscoveryUrlV1(raw: string): DirectoryDiscoverySourceV1 {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    throw new TypeError("directory discovery URL must contain 1-2048 characters");
  }
  return canonicalDirectoryUrl(raw);
}

function decodeHtmlEntities(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
  };
  return value.replace(/&(amp|quot|#39|lt|gt);/g, (entity) => entities[entity] ?? entity);
}

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function tagEnd(value: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "i",
  ).exec(tag);
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || undefined;
}

function tagIsHidden(tag: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(tag)) return true;
  if (htmlAttribute(tag, "aria-hidden")?.toLowerCase() === "true") return true;
  const style = htmlAttribute(tag, "style")?.toLowerCase() ?? "";
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i.test(style);
}

interface HtmlDiscoverySurface {
  visibleText: string;
  links: string[];
  title?: string;
}

function htmlDiscoverySurface(value: string): HtmlDiscoverySurface {
  const text: string[] = [];
  const links: string[] = [];
  let headingText: string[] = [];
  let title: string | undefined;
  const stack: Array<{ name: string; hidden: boolean }> = [];
  let cursor = 0;
  const hidden = (): boolean => stack.some((entry) => entry.hidden);
  const appendVisible = (fragment: string): void => {
    if (hidden()) return;
    text.push(fragment);
    if (title === undefined && stack.some((entry) => entry.name === "h1")) {
      headingText.push(fragment);
    }
  };
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open === -1) {
      appendVisible(value.slice(cursor));
      break;
    }
    appendVisible(value.slice(cursor, open));
    if (value.startsWith("<!--", open)) {
      const commentEnd = value.indexOf("-->", open + 4);
      if (commentEnd === -1) break;
      cursor = commentEnd + 3;
      continue;
    }
    const close = tagEnd(value, open + 1);
    if (close === -1) break;
    const rawTag = value.slice(open + 1, close).trim();
    const closing = rawTag.startsWith("/");
    const name = /^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(rawTag)?.[1]?.toLowerCase();
    if (name !== undefined) {
      if (closing) {
        const match = stack.map((entry) => entry.name).lastIndexOf(name);
        if (match !== -1) {
          const entry = stack[match];
          if (name === "h1" && entry?.hidden === false && title === undefined) {
            const candidate = decodeHtmlEntities(headingText.join(" ")).replace(/\s+/g, " ").trim();
            if (candidate.length > 0) title = candidate.slice(0, 200);
            headingText = [];
          }
          stack.splice(match);
        }
      } else {
        const parentHidden = hidden();
        const ownHidden =
          parentHidden ||
          name === "script" ||
          name === "style" ||
          name === "template" ||
          name === "noscript" ||
          tagIsHidden(rawTag);
        if (!ownHidden && name === "a") {
          const href = htmlAttribute(rawTag, "href");
          if (href !== undefined) links.push(href);
        }
        if (!VOID_HTML_ELEMENTS.has(name) && !rawTag.endsWith("/")) {
          stack.push({ name, hidden: ownHidden });
        }
      }
    }
    appendVisible(" ");
    cursor = close + 1;
  }
  return {
    visibleText: decodeHtmlEntities(text.join(" ")).replace(/\s+/g, " ").trim(),
    links: links.slice(0, MAX_DISCOVERED_URLS),
    ...(title === undefined ? {} : { title }),
  };
}

function discoveredUrls(visibleText: string, explicitLinks: string[]): string[] {
  const values: string[] = [];
  const collect = (surface: string): void => {
    let cursor = 0;
    while (values.length < MAX_DISCOVERED_URLS) {
      const start = surface.indexOf("https://", cursor);
      if (start === -1) return;
      let end = start + "https://".length;
      while (end < surface.length) {
        const char = surface[end] ?? "";
        if (/\s|[<>'"()]/.test(char)) break;
        end += 1;
      }
      const candidate = decodeHtmlEntities(surface.slice(start, end).replace(/[.,;:]+$/, ""));
      try {
        const url = new URL(candidate);
        if (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.port === "" &&
          url.search === "" &&
          url.hash === "" &&
          candidate.length <= 2_048
        ) {
          values.push(url.toString());
        }
      } catch {
        // Directory text is untrusted discovery data; malformed URLs are ignored.
      }
      cursor = Math.max(end, start + 8);
    }
  };
  collect(visibleText);
  for (const link of explicitLinks) collect(link);
  return [...new Set(values)].slice(0, MAX_DISCOVERED_URLS);
}

function normalizedGitHubRepository(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return undefined;
    const repositoryName = (parts[1] ?? "").replace(/\.git$/, "");
    const value = `${parts[0] ?? ""}/${repositoryName}`;
    return REGISTRY_NAME.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function endpointClaim(
  urlValue: string,
): { url: string; transport?: "sse" | "streamable-http" } | undefined {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    if (
      host === "github.com" ||
      host === "pulsemcp.com" ||
      host.endsWith(".pulsemcp.com") ||
      host === "mcpmarket.com" ||
      host.endsWith(".mcpmarket.com") ||
      host === "registry.modelcontextprotocol.io" ||
      host === "www.npmjs.com"
    ) {
      return undefined;
    }
    const path = url.pathname.toLowerCase();
    if (!path.includes("/mcp") && !path.endsWith("/sse")) return undefined;
    return {
      url: url.toString(),
      ...(path.endsWith("/sse")
        ? { transport: "sse" as const }
        : { transport: "streamable-http" as const }),
    };
  } catch {
    return undefined;
  }
}

export function extractDirectoryClaimV1(
  source: DirectoryDiscoverySourceV1,
  html: string,
): DirectoryClaimV1 {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_DIRECTORY_BYTES) {
    throw new TypeError("directory discovery response must not exceed 1 MiB");
  }
  const checkedSource = canonicalDirectoryUrl(source.url);
  if (checkedSource.provider !== source.provider || checkedSource.slug !== source.slug) {
    throw new TypeError("directory discovery source is mismatched");
  }
  const surface = htmlDiscoverySurface(html);
  const visibleText = surface.visibleText;
  const urls = discoveredUrls(visibleText, surface.links);
  const endpoints = urls
    .map(endpointClaim)
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .filter(
      (value, index, all) => all.findIndex((candidate) => candidate.url === value.url) === index,
    )
    .slice(0, 16);
  const title = surface.title;
  const repositoryValue = urls.map(normalizedGitHubRepository).find((value) => value !== undefined);
  const nameIndex = visibleText.indexOf("NAME");
  const nameSurface = nameIndex === -1 ? "" : visibleText.slice(nameIndex, nameIndex + 1_024);
  const registryName = REGISTRY_NAME_IN_TEXT.exec(nameSurface)?.[1];
  const version = /Current Version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/i.exec(
    visibleText,
  )?.[1];
  return {
    provider: source.provider,
    discoveryUrl: source.url,
    slug: source.slug,
    ...(title === undefined ? {} : { title }),
    ...(registryName === undefined ? {} : { registryName }),
    ...(version === undefined ? {} : { version }),
    ...(repositoryValue === undefined ? {} : { repository: repositoryValue }),
    endpoints,
  };
}

function normalizedRepository(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return undefined;
    return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function endpointHost(value: string): string {
  return new URL(value).hostname.toLowerCase();
}

function optionSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

function remoteOptionId(endpoint: string): string {
  const url = new URL(endpoint);
  return optionSlug(`remote-${url.hostname.replaceAll(".", "-")}-${url.pathname}`);
}

function resolutionOptions(server: z.infer<typeof registryServer>): DirectoryResolutionOptionV1[] {
  const options: DirectoryResolutionOptionV1[] = [];
  const serverBinding = { name: server.name, version: server.version };
  for (const item of server.packages ?? []) {
    if (
      item.registryType !== "npm" ||
      !PACKAGE_NAME.test(item.identifier) ||
      item.version === undefined ||
      item.transport.type !== "stdio"
    ) {
      continue;
    }
    const registry = item.registryBaseUrl ?? "https://registry.npmjs.org";
    const execution: { transport: string; resolver?: "npx" } = {
      transport: item.transport.type,
    };
    if (item.runtimeHint === "npx") execution.resolver = "npx";
    options.push({
      id: `npm-${optionSlug(item.identifier)}-${item.version}`,
      server: serverBinding,
      source: { type: "npm", registry, package: item.identifier, version: item.version },
      execution,
      secrets: [
        ...new Set(
          (item.environmentVariables ?? [])
            .filter((entry) => entry.isSecret)
            .map((entry) => entry.name),
        ),
      ].sort(),
    });
  }
  for (const item of server.remotes ?? []) {
    options.push({
      id: remoteOptionId(item.url),
      server: serverBinding,
      source: { type: "remote", endpoint: item.url },
      execution: { transport: item.type },
      secrets: [],
    });
  }
  return options.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function matchingRegistryServers(
  claim: DirectoryClaimV1,
  registry: DirectoryRegistryResponseV1,
): DirectoryRegistryResponseV1["servers"] {
  if (claim.registryName !== undefined) {
    return registry.servers.filter((entry) => entry.server.name === claim.registryName);
  }
  if (claim.repository !== undefined) {
    const requested = claim.repository.toLowerCase();
    const matches = registry.servers.filter(
      (entry) => normalizedRepository(entry.server.repository?.url) === requested,
    );
    if (matches.length > 0) return matches;
  }
  const hosts = new Set(claim.endpoints.map((entry) => endpointHost(entry.url)));
  if (hosts.size > 0) {
    return registry.servers.filter((entry) =>
      (entry.server.remotes ?? []).some((remote) => hosts.has(endpointHost(remote.url))),
    );
  }
  return [];
}

export function resolveDirectoryClaimV1(
  claim: DirectoryClaimV1,
  registryInput: DirectoryRegistryResponseV1,
): DirectoryResolutionV1 {
  const registry = DirectoryRegistryResponseV1Schema.parse(registryInput);
  if (registry.metadata.nextCursor !== undefined) {
    return {
      state: "unresolved",
      authority: { state: "not-authority" },
      claim,
      conflicts: [],
      options: [],
    };
  }
  const matches = matchingRegistryServers(claim, registry);
  if (matches.length !== 1) {
    return {
      state: matches.length > 1 ? "ambiguous" : "unresolved",
      authority: { state: "not-authority" },
      claim,
      conflicts: [],
      options: [],
    };
  }
  const selected = matches[0];
  if (selected === undefined) throw new Error("expected one registry server");
  const server = selected.server;
  const conflicts: DirectoryResolutionConflictV1[] = [];
  const observedRepository = normalizedRepository(server.repository?.url);
  if (claim.repository !== undefined && observedRepository === undefined) {
    return {
      state: "unresolved",
      authority: { state: "not-authority" },
      claim,
      conflicts: [],
      options: [],
    };
  }
  if (claim.version !== undefined && claim.version !== server.version) {
    conflicts.push({
      field: "version",
      claimed: claim.version,
      observed: server.version,
      code: "directory.version-mismatch",
    });
  }
  if (
    claim.repository !== undefined &&
    observedRepository !== undefined &&
    claim.repository.toLowerCase() !== observedRepository
  ) {
    conflicts.push({
      field: "repository",
      claimed: claim.repository,
      observed: observedRepository,
      code: "directory.repository-mismatch",
    });
  }
  const observedEndpoints = (server.remotes ?? []).map((entry) => entry.url).sort();
  const unmatchedEndpoints = claim.endpoints
    .map((entry) => entry.url)
    .filter((endpoint) => !observedEndpoints.includes(endpoint));
  if (unmatchedEndpoints.length > 0) {
    conflicts.push({
      field: "endpoint",
      claimed: unmatchedEndpoints.join(", "),
      observed: observedEndpoints.join(", ") || "none",
      code: "directory.endpoint-mismatch",
    });
  }
  const options = resolutionOptions(server);
  return {
    state: conflicts.length === 0 ? "resolved" : "mismatched",
    authority: { state: "not-authority" },
    claim,
    registry: {
      origin: DIRECTORY_REGISTRY_ORIGIN,
      name: server.name,
      version: server.version,
      ...(observedRepository === undefined ? {} : { repository: observedRepository }),
      sources: options.map((option) => ({ ...option.source })),
    },
    conflicts,
    options,
  };
}
