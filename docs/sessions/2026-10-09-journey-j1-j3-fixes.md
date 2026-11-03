# 2026-10-09: J1/J3 journey fixes (#1049, promoted in #1050)

## What shipped (prod 7775d628)
- **J1**: `mailboxNamedIn()` (`src/infra/google-mailboxes.ts`) reads the founder's own words, which reach the tool as `configurable.founder_text`. A mailbox he names ("my work inbox") outranks the model's `account` argument in `read_emails`.
- **J3**: the prod trace for turn 7c2bc168 showed list_prs returned all 10 rows. The model then called get_pr on all 10, oldest-first pruning stubbed the list, and the model copied #991's title onto other PRs. Pruning now stubs the largest older result first, and `github_read` returns compact JSON.
- **Scorer**: `prRef` matches `| 1018 |` table rows.

## Verification
- `pnpm gate` exit 0: 696 files, 9514 tests passed, 1 skipped. CI was green on #1049 and #1050; the deploy succeeded and prod HEAD is 7775d628.
- NOT VERIFIED: the prod journey (run 5459bfa6, 21:30Z) failed every turn with "Request timed out". The OpenRouter key is at its $10 total limit and returns `403 Key limit exceeded` instantly. Re-run `scripts/journey-daily.ts` once the limit is raised.

## Open
- A 403 key-limit error shows up as a 35 s timeout (follow-up task offered).
- The get_pr fan-out after list_prs costs ~30 s; this fix doesn't stop it.
- J2: the turicks Google grant is `invalid_grant` (founder must sign in again).
