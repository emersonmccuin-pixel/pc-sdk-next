-- Worktree lifecycle — per-project WorktreeProfile + provisioning receipts
-- (docs/worktree-lifecycle.md 'Provisioning and readiness').
-- Additive + nullable only. NULL profile = profile-less provisioning (today's
-- behavior); NULL receipts = non-repo / profile-less / pre-receipt rows.
ALTER TABLE `projects` ADD `worktree_profile` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `git_receipt` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `preparation_receipt` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `readiness_receipt` text;
