# Contributing to Phoenix

These rules are the single source of truth for how code reaches `dev` and `main`.
Tickets live on the [build board](https://claude.ai/artifact/RUKvrgK8Mg2STL5RY7wf2u).

## Branches
| Branch | Receives | Rule |
|---|---|---|
| `main` | Release PRs from `dev` only | Every merge is tagged (`v0.1.0`, ...) |
| `dev` | PRs from personal branches | Must always build and pass tests |
| `subhajit/PHX-0xx-short-name` | Subhajit's tickets | Branch from `dev` |
| `claude/PHX-0xx-short-name` | Claude's tickets | Branch from `dev` |
| `hotfix/PHX-0xx-short-name` | Urgent fixes | Branch from `main` |

No direct pushes to `main` or `dev`; a ruleset enforces it.

## Pull requests
- One ticket = one PR, at most **100 changed lines**. Lockfiles and `docs/*.md` don't count.
  Bigger? Split the ticket first.
- Title: `PHX-031: send_email writes events + outbox in one transaction`.
- Fill in every section of the template, especially **Why** and **Crash scenario**.
- CI must be green before review.
- Merge into `dev` with **Squash and merge**. Merge into `main` with a **merge commit**.

## Commit authorship
A named human is always the commit author. When Claude wrote the code, add a
`Co-Authored-By: Claude ...` trailer. Claude is never the sole author.

## Review flow
- **Claude's PRs:** Subhajit reviews: comment, request changes, merge.
- **Subhajit's PRs:**
  1. Claude reviews first. Comments are questions ("what if the worker dies here?"), not fixes.
  2. Subhajit replies to every comment with a *because*.
  3. Next session, Subhajit re-reviews the diff cold against the checklist below, then merges.
- Never merge a PR in the same session it was opened.
- Every review thread must be resolved before merging (the ruleset enforces it).

## Reviewer checklist
1. Is anything unpredictable (LLM, `now()`, random, HTTP, MCP) outside a `step()`? (rule 1)
2. Does replay return saved results instead of re-running finished steps? (rule 2)
3. Is every worker write guarded by token AND live lease in the same statement? (rule 3)
4. Is any side effect done directly instead of events + outbox in one transaction? (rule 4)
5. Does a rejected guarded write drop the task and return to the loop? (rule 5)
6. Does one box call another directly instead of through Postgres? (rule 6)
7. For every `BEGIN`: where does it end on every path, including a throw?
8. `kill -9` on each line of the change: what is left in the database?
9. Is there a test that fails without this change? Are BIGINT columns parsed?

## Releases
1. Every ticket of the release is merged; run the full chaos suite on `dev`.
2. Open PR `dev` → `main` titled `Release vX.Y.Z`, listing the ticket keys. (Exempt from the
   100-line rule.)
3. Merge with a merge commit, then tag `main`: `git tag vX.Y.Z && git push --tags`.

## Hotfixes
Branch `hotfix/...` from `main`, PR into `main`, tag a patch version, then open a PR
`main` → `dev` so the next release doesn't undo the fix.
