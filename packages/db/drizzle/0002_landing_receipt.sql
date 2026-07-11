-- Worktree lifecycle — full merge receipt + landing policy
-- (docs/worktree-lifecycle.md 'Merge receipt' / 'Delivery policies').
-- Additive + nullable only; `landed_sha` keeps its branch-tip meaning and the
-- merge commit lives in the NEW columns. NULL = pre-receipt / legacy row.
ALTER TABLE `agent_contracts` ADD `target_sha_before` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `target_sha_after` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `merge_sha` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `landing_authorizer` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `verified_base_sha` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `landing_policy` text;
