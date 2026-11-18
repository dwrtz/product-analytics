-- 0.3: per-project replay settings (JSON; null = defaults) and the heatmaps switch. Additive; existing projects keep
-- their current behaviour (replay defaults, heatmaps off).
ALTER TABLE projects ADD COLUMN replay_config TEXT;
ALTER TABLE projects ADD COLUMN heatmaps INTEGER NOT NULL DEFAULT 0;
