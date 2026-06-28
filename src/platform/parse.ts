import { type CertEntry, derBase64ToPem, type GpuInfo } from "./base.js";

/** First integer anywhere in `stdout` (handles trailing newlines/whitespace). */
export function parseFirstInt(stdout: string): number | undefined {
  const m = stdout.match(/-?\d+/);
  return m ? Number.parseInt(m[0], 10) : undefined;
}

/** Parse `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): GpuInfo {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return { vendor: "none", backend: "cpu", vramGb: 0 };
  const [memRaw, ...nameParts] = line.split(",");
  const mib = Number.parseInt((memRaw ?? "").trim(), 10);
  const vramGb = Number.isFinite(mib) ? Math.round(mib / 1024) : 0;
  const name = nameParts.join(",").trim() || undefined;
  return { vendor: "nvidia", backend: "cuda", vramGb, name };
}

/** Parse tab-separated `base64<TAB>subject` lines (Windows cert export). */
export function parseCertLines(stdout: string): CertEntry[] {
  const out: CertEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    const base64 = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : "(unknown subject)";
    if (base64.length < 32) continue;
    out.push({ subject, pem: derBase64ToPem(base64) });
  }
  return out;
}

/**
 * Extract PEM certificate blocks from `security`/openssl `-p` style output.
 *
 * A linear `indexOf` walk rather than `/BEGIN[\s\S]*?END/g`: that lazy match
 * between two literal anchors is a polynomial-ReDoS footgun (CodeQL
 * `js/polynomial-redos`) — on output with many `BEGIN` markers and no closing
 * `END`, the engine rescans to end from every `BEGIN`, O(n²). The walk finds
 * each `BEGIN` then its nearest following `END` (the same blocks the lazy regex
 * matched, in order) with non-overlapping O(n) scans.
 */
export function parsePemBlocks(stdout: string, subject = "(matched CA)"): CertEntry[] {
  const BEGIN = "-----BEGIN CERTIFICATE-----";
  const END = "-----END CERTIFICATE-----";
  const out: CertEntry[] = [];
  let from = 0;
  for (let start = stdout.indexOf(BEGIN, from); start >= 0; start = stdout.indexOf(BEGIN, from)) {
    const endAt = stdout.indexOf(END, start + BEGIN.length);
    if (endAt < 0) break; // an unterminated BEGIN matches nothing, exactly as the regex did
    const block = stdout.slice(start, endAt + END.length);
    out.push({ subject, pem: `${block.trim()}\n` });
    from = endAt + END.length;
  }
  return out;
}
