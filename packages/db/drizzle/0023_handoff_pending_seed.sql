-- Phase 2 app-owned cross-account context handoff: a durable row-level
-- marker that the first delivered turn on a handed-off session must compile
-- and inject the prior session's transcript as native seedContext before it
-- counts as consumed. Defaults false for every existing row.

ALTER TABLE `orchestrator_sessions` ADD `pending_handoff_seed` integer DEFAULT 0 NOT NULL;
