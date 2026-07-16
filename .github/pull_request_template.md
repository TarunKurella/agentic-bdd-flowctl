## What changed

Describe the source pattern, graph/compiler behavior, or documentation change.

## Evidence and soundness

- [ ] New executable behavior is source-grounded.
- [ ] Unsupported or ambiguous behavior remains conditional/unresolved.
- [ ] No UAT values, credentials, generated `.flowctl` state, or approvals are committed.
- [ ] AI/ast-grep output is used only as evidence or investigation guidance.

## Verification

- [ ] `npm run check`
- [ ] `npm run check:package`
- [ ] Focused regression test for the changed behavior
- [ ] Fixture/traceability assertion when graph or BDD semantics changed
