-- Triage issue catalog. One row per distinct issue; alerts referring to the
-- same fingerprint update the existing row.
CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY,         -- fingerprint hash, see Triage.ts
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,            -- AI-generated 1-2 sentence summary
  severity        INTEGER NOT NULL,         -- 1 (low) .. 5 (critical)
  status          TEXT NOT NULL DEFAULT 'open',  -- open | triaging | reproduced | fixing | closed
  occurrences     INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL,         -- ms since epoch
  last_seen       INTEGER NOT NULL,
  axiom_query     TEXT,                     -- APL snippet that surfaces this issue
  sample_event    TEXT,                     -- JSON of last representative event
  pr_url          TEXT,                     -- set when reproducer/PR exists
  discord_msg_id  TEXT                      -- last Discord message id we posted
);

CREATE INDEX IF NOT EXISTS idx_issues_status_severity
  ON issues(status, severity DESC, last_seen DESC);
