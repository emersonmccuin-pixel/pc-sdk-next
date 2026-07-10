-- Phase 3 — runtime-selection stamping (docs/agent-runtime-architecture.md
-- guard rule 2): every agent run records the runtime, account, and model it
-- executed under. NULL only for pre-Phase-3 rows.
ALTER TABLE `agent_runs` ADD `runtime_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `model` text;
