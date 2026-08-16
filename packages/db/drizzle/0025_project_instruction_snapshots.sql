-- PI-001: one immutable, app-owned root AGENTS.md snapshot per orchestrator
-- app session and specialist run. Null is a pre-mint/legacy state only.

ALTER TABLE `orchestrator_sessions` ADD `project_instruction_snapshot` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `project_instruction_snapshot` text;
--> statement-breakpoint
CREATE TRIGGER `orchestrator_session_project_instruction_snapshot_immutable`
BEFORE UPDATE OF `project_instruction_snapshot` ON `orchestrator_sessions`
WHEN OLD.`project_instruction_snapshot` IS NOT NULL
  AND NEW.`project_instruction_snapshot` IS NOT OLD.`project_instruction_snapshot`
BEGIN
  SELECT RAISE(ABORT, 'orchestrator project instruction snapshot is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `agent_run_project_instruction_snapshot_immutable`
BEFORE UPDATE OF `project_instruction_snapshot` ON `agent_runs`
WHEN OLD.`project_instruction_snapshot` IS NOT NULL
  AND NEW.`project_instruction_snapshot` IS NOT OLD.`project_instruction_snapshot`
BEGIN
  SELECT RAISE(ABORT, 'agent run project instruction snapshot is immutable');
END;

