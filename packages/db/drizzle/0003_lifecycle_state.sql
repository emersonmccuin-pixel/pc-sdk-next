-- Worktree lifecycle — durable pipeline state machine
-- (docs/worktree-lifecycle.md 'Lifecycle states').
-- Additive + nullable only; the 7-value `status` column stays untouched and
-- authoritative for dispatch. NULL = legacy/non-repo run.
ALTER TABLE `agent_runs` ADD `lifecycle_state` text;
