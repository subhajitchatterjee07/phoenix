## Ticket
PHX-0xx: <title> ([board](https://claude.ai/artifact/RUKvrgK8Mg2STL5RY7wf2u))

## What
-

## Why
<!-- The "because". Why this approach and not the obvious alternative? -->

## Crash scenario I considered
<!-- "kill -9 between line X and Y leaves ... and restart does ...". Or: "None: no runtime code." -->

## How I tested it
-

## Author self-check
- [ ] At most 100 changed lines (lockfiles and docs/*.md excluded)
- [ ] CI is green
- [ ] Anything unpredictable (LLM, now(), random, HTTP, MCP) runs inside a `step()`
- [ ] Every worker write is guarded: fencing token AND live lease, same statement
- [ ] Every transaction ends (COMMIT or ROLLBACK) on every path, including a throw
