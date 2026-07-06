/**
 * High-confidence provider credential shapes reused anywhere aih needs to
 * identify literal tokens in source-side output or config.
 *
 * Keep AWS/private-key regexes in gitleaks.ts; those patterns are rendered into
 * the managed gitleaks config and redaction imports them from that source.
 */
export interface ProviderTokenPattern {
  kind: string;
  re: RegExp;
}

export const PROVIDER_TOKEN_PATTERNS: readonly ProviderTokenPattern[] = [
  { kind: "github token", re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{10,}\b/ },
  { kind: "github fine-grained PAT", re: /github_pat_[A-Za-z0-9_]{10,}/ },
  { kind: "openai/anthropic-style key", re: /sk-[A-Za-z0-9_-]{20,}/ },
  { kind: "slack token", re: /xox[abprsoe]-[A-Za-z0-9-]{10,}/ },
  { kind: "google api key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: "azure storage account key", re: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/i },
  {
    kind: "azure storage shared access signature",
    re: /\bSharedAccessSignature=[^\s"']*?\bsig=[A-Za-z0-9%+/=_-]{8,}[^\s"']*/i,
  },
  { kind: "npm access token", re: /npm_[A-Za-z0-9]{36}/ },
];
