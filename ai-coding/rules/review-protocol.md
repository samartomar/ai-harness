# Review

> Load when: reviewing a PR, verifying a change, or acting on review/external feedback.

Follow the proportionate review contract in `CONTRIBUTING.md`:

- **One owner, one independent review for risky changes.** Use Astra with low
  reasoning effort to cover correctness, security, and the touched domain in
  one pass. Trust/execution authority, credentials, destructive operations,
  schema compatibility, and CI/release machinery require that review. Routine
  work does not automatically need subagents, specialist chains, or panels.
- **Add a reviewer only for a named unresolved boundary.** Record the question
  and why the existing review cannot resolve it. Consolidate findings; repair
  confirmed defects in one owned pass and rerun affected checks. Do not repeat
  unchanged verification or restart reviews merely because a new task begins.
- **Use the selected local completion gate.** Run
  `npm run verify:local -- --base <ref> --head <ref>` with explicit working-change
  inclusion when needed, and report its result and hosted gaps. Focused unit
  tests support TDD; CLI-boundary changes also need passing and failing cases
  against temporary fixtures. Full validation is deliberate; real installed
  publication acceptance and protected CI remain required where applicable.
- **Verify review claims against current source.** Check symbols, flags, tests,
  and the applicable revision before acting. Revalidate old reports against
  current `main`; neither accept nor reject a finding solely because of its age.
  Record the evidence and disposition of confirmed or rejected findings in the PR.

Human authorization for external actions is unchanged. Reviews and local checks
do not authorize publishing, pushing, merging, or dispatching remote agents.
