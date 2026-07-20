-- Recovery-view dismissal: let the user clear terminal runs that have
-- nothing to auto-recover (no sealed deliverable, no stranded worktree).

ALTER TABLE `agent_runs` ADD COLUMN `dismissed_at` integer;
