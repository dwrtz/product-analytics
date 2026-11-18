-- 0.2: per-project session recording switch. Additive; existing projects keep recording off.
ALTER TABLE projects ADD COLUMN session_recording INTEGER NOT NULL DEFAULT 0;
