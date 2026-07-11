-- Bounded auto-continue on turn-budget exhaustion (max-turns fix part 2).
-- Durable per-chain counter: survives a server restart mid-chain, so the
-- MAX_AUTO_CONTINUES ceiling is enforced off the row, not in-memory state.
-- NOT NULL DEFAULT 0 — legacy rows and fresh dispatches start an unused budget.
ALTER TABLE `agent_runs` ADD `auto_continue_count` integer DEFAULT 0 NOT NULL;
