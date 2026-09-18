/**
 * The changes screen's line diff (NEW-SHELL-PLAN.md S5, "Changes vs whole
 * file"): the current policy text against the policy the page started with.
 * DOM-free. A longest-common-subsequence diff over the lines that differ
 * after the shared head and tail; past `MAX_CELLS` it falls back to showing
 * the whole differing middle as removed then added, which stays correct.
 */

export type DiffLineKind = " " | "+" | "-";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 1-based line in the current text; absent for a removed line. */
  readonly line?: number;
}

export interface DiffHunkGap {
  readonly kind: "gap";
  readonly skipped: number;
}

const MAX_CELLS = 2_000_000;

function lines(text: string): string[] {
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

export function policyLineDiff(before: string, after: string): DiffLine[] {
  const left = lines(before);
  const right = lines(after);
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  )
    tail += 1;
  const leftMiddle = left.slice(head, left.length - tail);
  const rightMiddle = right.slice(head, right.length - tail);
  const out: DiffLine[] = [];
  for (let index = 0; index < head; index += 1)
    out.push({ kind: " ", text: right[index]!, line: index + 1 });
  let line = head;
  const n = leftMiddle.length;
  const m = rightMiddle.length;
  if (n * m > MAX_CELLS) {
    for (const text of leftMiddle) out.push({ kind: "-", text });
    for (const text of rightMiddle) out.push({ kind: "+", text, line: ++line });
  } else {
    // lengths[i][j]: LCS length of leftMiddle[i..] and rightMiddle[j..].
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        lengths[i * width + j] =
          leftMiddle[i] === rightMiddle[j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && leftMiddle[i] === rightMiddle[j]) {
        out.push({ kind: " ", text: rightMiddle[j]!, line: ++line });
        i += 1;
        j += 1;
      } else if (
        i < n &&
        (j === m || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
      ) {
        // Removals first, as a unified diff prints them.
        out.push({ kind: "-", text: leftMiddle[i]! });
        i += 1;
      } else {
        out.push({ kind: "+", text: rightMiddle[j]!, line: ++line });
        j += 1;
      }
    }
  }
  for (let index = right.length - tail; index < right.length; index += 1)
    out.push({ kind: " ", text: right[index]!, line: ++line });
  return out;
}

/** Changed lines with `context` unchanged lines around each change; gaps stand for the rest. */
export function changeHunks(diff: readonly DiffLine[], context = 3): (DiffLine | DiffHunkGap)[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((entry, index) => {
    if (entry.kind === " ") return;
    for (
      let near = Math.max(0, index - context);
      near <= Math.min(diff.length - 1, index + context);
      near += 1
    )
      keep[near] = true;
  });
  const out: (DiffLine | DiffHunkGap)[] = [];
  let skipped = 0;
  diff.forEach((entry, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ kind: "gap", skipped });
      skipped = 0;
      out.push(entry);
    } else skipped += 1;
  });
  if (skipped > 0 && out.length > 0) out.push({ kind: "gap", skipped });
  return out;
}
