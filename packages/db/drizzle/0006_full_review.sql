-- Worktree lifecycle — full independent review loop
-- (docs/worktree-lifecycle.md 'Full independent review', guard 4).
-- Additive + nullable only. `review_round` = reviewer dispatches consumed
-- (bounded retry, doc: "a bounded retry/escalation policy prevents endless
-- Review/Fix loops"); `review_run_id` = the in-flight review run — the durable
-- marker crash recovery reads to re-dispatch instead of wedging. NULL =
-- non-full-review / legacy row.
ALTER TABLE `agent_contracts` ADD `review_round` integer;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `review_run_id` text;
