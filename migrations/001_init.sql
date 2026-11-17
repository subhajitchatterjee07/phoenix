-- Phoenix schema v1 (source: docs/LLD.md section 2)

CREATE TABLE tasks (
  task_id           BIGSERIAL PRIMARY KEY,
  goal              TEXT        NOT NULL,
  input             JSONB       NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','WAITING_APPROVAL','DONE','FAILED')),
  owner             TEXT,                    -- worker id, NULL if unowned
  lease_expires_at  TIMESTAMPTZ,             -- NULL if unowned
  fencing_token     BIGINT      NOT NULL DEFAULT 0,   -- +1 on every claim, never reset
  max_steps         INT         NOT NULL DEFAULT 200,
  token_budget      BIGINT,                  -- NULL = unlimited
  tokens_used       BIGINT      NOT NULL DEFAULT 0,
  failure_reason    TEXT,                    -- set when FAILED
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the claim query's access path
CREATE INDEX tasks_claimable ON tasks (status, lease_expires_at)
  WHERE status IN ('PENDING','RUNNING');

CREATE TABLE events (                        -- append-only log of FINISHED steps
  task_id         BIGINT      NOT NULL REFERENCES tasks,
  step_id         INT         NOT NULL,      -- 1..N, assigned in call order
  step_type       TEXT        NOT NULL,      -- registry name, e.g. 'llm_summarize'
  input_hash      TEXT        NOT NULL,      -- sha256 of canonical args (replay sanity check)
  status          TEXT        NOT NULL CHECK (status IN ('OK','ERROR')),
  result_inline   JSONB,                     -- small results
  result_pointer  TEXT,                      -- blob key for large results
  error           TEXT,                      -- human-readable, NULL if OK
  attempts        INT         NOT NULL DEFAULT 1,
  tokens          INT         NOT NULL DEFAULT 0,
  fencing_token   BIGINT      NOT NULL,      -- which claim wrote it (audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_id)
);

CREATE TABLE outbox (
  idem_key        TEXT        PRIMARY KEY,   -- sha256('{task_id}:{step_id}')
  task_id         BIGINT      NOT NULL REFERENCES tasks,
  step_id         INT         NOT NULL,
  kind            TEXT        NOT NULL,      -- 'email'
  guarantee       TEXT        NOT NULL CHECK (guarantee IN ('AT_LEAST_ONCE','AT_MOST_ONCE')),
  recipient       TEXT        NOT NULL,
  payload         JSONB       NOT NULL,      -- subject, body
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'PENDING';

CREATE TABLE decisions (
  task_id     BIGINT      NOT NULL REFERENCES tasks,
  step_id     INT         NOT NULL,          -- the request_approval step
  decision    TEXT        NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_by  TEXT        NOT NULL,
  comment     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_id)
);
