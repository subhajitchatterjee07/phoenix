-- H5 (PHX-066, design notes 22 Nov 2026; LLD §2, §4.3): one row per external provider.
-- Every worker waits until `until` before calling that provider; a 429 or 5xx pushes it forward.
CREATE TABLE provider_cooldown (
  provider  TEXT        PRIMARY KEY,         -- 'llm' (the dispatcher keeps per-row backoff)
  until     TIMESTAMPTZ NOT NULL
);
