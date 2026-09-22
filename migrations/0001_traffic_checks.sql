-- P6.1 / SPEC §9.3 — monitoring history.
CREATE TABLE IF NOT EXISTS traffic_checks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at         TEXT    NOT NULL,
  trigger            TEXT    NOT NULL,
  status             TEXT    NOT NULL,
  traffic_gb         REAL,
  threshold_gb       REAL    NOT NULL,
  usage_percent      REAL,
  remaining_gb       REAL,
  ecs_status_before  TEXT,
  desired_ecs_state  TEXT,
  action             TEXT,
  ecs_status_after   TEXT,
  control_ok         INTEGER,
  webhook_attempted  INTEGER,
  webhook_ok         INTEGER,
  error_stage        TEXT,
  error_message      TEXT,
  duration_ms        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traffic_checks_checked_at ON traffic_checks (checked_at);
