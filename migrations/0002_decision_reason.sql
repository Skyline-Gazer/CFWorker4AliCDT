-- Decision reasons are available only for runs that reached `decide()`.
-- Existing rows and runs without a decision remain NULL; never backfill a guess.
ALTER TABLE traffic_checks ADD COLUMN decision_reason TEXT;
