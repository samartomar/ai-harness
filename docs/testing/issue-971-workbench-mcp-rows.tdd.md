# Issue #971 — Workbench MCP request rows evidence

## Goal and boundary

The portable Policy Workbench rendered the three AIH-owned ECC MCP declarations this Core build
gates — `github` and `context7` with no managed stdio projector, `playwright` with no protected
Scanner evidence record — with no selection control at all. The owner decision of 2026-09-04 is
that every center-panel row accepts requested intent: gates are labels and next routes on a
selectable row, selection records requested intent only, and the gate holds at export and again
at target evaluation. This change adds the optional `governance.aihMcpRequests` grammar, the
resolver report, the catalog partition that names each gate from data, and the row control, without
changing any exported byte of a policy that requests nothing and without touching the legacy
import migrations.

Tests were written first and failed for the intended reasons before any source edit:

- `tests/org-policy/studio-catalog-inventory.test.ts` inverts "offers only projector-backed MCP
  identities as center-panel controls" into a click and unclick round trip whose export is
  byte-identical to the pre-selection export, asserts the row source mark on its own element,
  proves every `#mcp-rows` row carries a `.tick[aria-pressed]` before and after every request is
  recorded, and pins the catalog partition over every AIH-owned inventory id;
- `tests/org-policy/studio-profile-composition.test.ts` inverts "keeps Playwright unavailable when
  a profile is composed": Vibe and Enterprise author no request while the row stays selectable;
- `tests/org-policy/studio-aih-mcp-requests.test.ts` (new) proves the browser validator mirrors the
  Node rules, refuses a request for an identity this build ships as a control, sorts requests into
  the pinned order however the administrator clicks, and rolls a colliding request back
  byte-for-byte;
- `tests/org-policy/aih-mcp-request.test.ts` (new) pins every Node grammar rule, its message, and
  its issue path, including the empty-array refusal;
- `tests/org-policy/effective.test.ts` proves a request never becomes a candidate, an active MCP
  server id, or a blocking condition, that the key is absent when nothing is requested, and that a
  request for an identity the runtime ships as a control is marked `controlShipped`;
- `tests/config/json-schema.test.ts` validates the regenerated committed schema through Ajv.

## Same-PC before and after

Measurements used Node 24 and Vitest on the same Windows PC. The untouched baseline is
`origin/main` at `4e2a9902`. The Workbench lane ran alone in both cases; the final run used the
4 GiB Node heap that `.github/workflows/ci.yml` sets, because one worker of a default-heap run of
the same tree exhausted the 2 GB default limit before any assertion ran.

| Command or lane | Before | After | Result |
|---|---:|---:|---:|
| `npm run test:workbench:cov` files | 37 passed | 38 passed | one new lane file |
| `npm run test:workbench:cov` tests | 375 passed | 387 passed | twelve new or inverted cases |
| `npm run test:workbench:cov` wall time | 87.38 s | 97.92 s | 12.1% slower |
| focused changed files (7 files) | not applicable | 125 passed in 49.27 s | green |

The lane grows by the new import round trips in `studio-aih-mcp-requests.test.ts`; no existing
assertion was weakened or removed.

## Coverage proof

The untouched baseline and the final tree produced the exact same production coverage counts on
the lane's independent floors (89 / 80 / 94 / 92):

| Metric | Before | After |
|---|---:|---:|
| Statements | 89.54% (274/306) | 89.54% (274/306) |
| Branches | 80.64% (225/279) | 80.64% (225/279) |
| Functions | 94.44% (68/72) | 94.44% (68/72) |
| Lines | 92.44% (257/278) | 92.44% (257/278) |

The numbers are identical because the Workbench browser code lives inside a `String.raw` template
that v8 never instruments; the real evidence for the new browser branches is the happy-dom
assertions listed above, which exercise both gate kinds in both selection states, the import
validator, the export path, and the drawer.

## Gates run on the final tree

| Command | Outcome |
|---|---|
| `npm run typecheck` | exit 0 |
| `npx biome ci src tests` | exit 0 on every changed file; 31 pre-existing warnings elsewhere |
| `npm run docs:lint` | exit 0 |
| `npm run check:self-hosting-canon` | 6 passed |
| `npm run check:artifacts` | passed |
| `npm test` (implementer run, default heap, 8 workers) | 848.09 s; 484 files passed, 12 failed on timeouts or `spawnSync ETIMEDOUT`, each passing alone with `--maxWorkers=1`; no failing file touches this change |

## Residual cost

Under a 2 GB default heap the lane can lose a whole worker to a heap-limit exit while a large DOM
file is running, which surfaces as a file that "failed" with no assertion. Measure the lane with
`NODE_OPTIONS=--max-old-space-size=4096`, as CI does. The lane's DOM-heavy files remain the
critical path named in `docs/testing/issue-957-workbench-dom-amplification.tdd.md`; the core
extraction tracked in #967 is the change that would make them cheap.
