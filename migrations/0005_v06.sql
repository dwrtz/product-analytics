-- 0.6: projects shown read-only to signed-out visitors when the instance runs with PUBLIC_DEMO=1 (design.md "Public demo").
ALTER TABLE projects ADD COLUMN public_demo INTEGER NOT NULL DEFAULT 0;
