-- 0.5: per-project usage limits, sampling and alert settings (JSON; null = no limits, existing projects keep today's
-- behaviour), the current month's cap state written by the project store (JSON), and the exception autocapture switch.
ALTER TABLE projects ADD COLUMN limits TEXT;
ALTER TABLE projects ADD COLUMN cap_state TEXT;
ALTER TABLE projects ADD COLUMN error_tracking INTEGER NOT NULL DEFAULT 0;
