-- Worktree lifecycle — worktree-row run bindings + durable stranded state
-- (docs/worktree-lifecycle.md 'Recovery': "worktree present without a live
-- run/lease → stranded and surfaced").
-- Additive + nullable only. NULL bindings = legacy rows. `status` gains the
-- 'stranded' value (no CHECK constraint exists — TS union widens); the partial
-- unique indexes on active name/path are untouched: a stranded row frees its
-- name/path for a new active row.
ALTER TABLE `worktrees` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `agent_run_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `contract_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `base_sha` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `stranded_reason` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `stranded_at` integer;
