-- DL-002: browser-user-approved destructive worktree abandonment.
-- Legacy landing_status='abandoned' rows deliberately retain NULL receipts;
-- no migration can invent cleanup authority.

ALTER TABLE `agent_contracts` ADD `abandonment_receipt` text;
--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `abandonment_teardown_receipt` text;
--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD `abandonment_error` text;
--> statement-breakpoint

-- Before DL-002, continuation admission advanced the contract producer but
-- left the durable worktree row on the original run. Repair only a uniquely
-- provable same-contract/same-worktree chain; ambiguity remains untouched and
-- therefore ineligible for destructive authority.
UPDATE `worktrees` AS w
SET `agent_run_id` = (
  SELECT c.`agent_run_id` FROM `agent_contracts` c WHERE c.`id` = w.`contract_id`
)
WHERE w.`status` IN ('active', 'stranded')
  AND EXISTS (
    SELECT 1
    FROM `agent_contracts` c
    JOIN `agent_runs` current_run ON current_run.`id` = c.`agent_run_id`
    JOIN `agent_runs` prior_run ON prior_run.`id` = w.`agent_run_id`
    WHERE c.`id` = w.`contract_id`
      AND c.`project_id` = w.`project_id`
      AND c.`worktree_path` = w.`path`
      AND c.`worktree_base_branch` = w.`base_branch`
      AND c.`worktree_base_sha` = w.`base_sha`
      AND c.`agent_run_id` IS NOT NULL
      AND c.`agent_run_id` <> w.`agent_run_id`
      AND current_run.`project_id` = c.`project_id`
      AND current_run.`contract_id` = c.`id`
      AND current_run.`worktree_dir` = c.`worktree_path`
      AND current_run.`worktree_base_branch` = c.`worktree_base_branch`
      AND current_run.`worktree_base_sha` = c.`worktree_base_sha`
      AND prior_run.`project_id` = c.`project_id`
      AND prior_run.`contract_id` = c.`id`
      AND prior_run.`worktree_dir` = c.`worktree_path`
      AND prior_run.`worktree_base_branch` = c.`worktree_base_branch`
      AND prior_run.`worktree_base_sha` = c.`worktree_base_sha`
      AND NOT EXISTS (
        SELECT 1 FROM `worktrees` other
        WHERE other.`id` <> w.`id`
          AND other.`contract_id` = c.`id`
          AND other.`status` IN ('active', 'stranded')
      )
  );
--> statement-breakpoint

-- Contracts are always inserted before approval. This keeps the only
-- authority door on the exact guarded UPDATE below and prevents raw INSERT
-- from bypassing version/worktree/live-run admission.
CREATE TRIGGER `agent_contracts_abandonment_insert_guard`
BEFORE INSERT ON `agent_contracts`
WHEN NEW.`landing_status` IN ('abandoning', 'abandoned')
  OR NEW.`abandonment_receipt` IS NOT NULL
  OR NEW.`abandonment_teardown_receipt` IS NOT NULL
  OR NEW.`abandonment_error` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'contract abandonment requires guarded update authority');
END;
--> statement-breakpoint

-- Authority and positive teardown settlement are immutable after first write.
CREATE TRIGGER `agent_contracts_abandonment_receipt_immutable`
BEFORE UPDATE OF `abandonment_receipt` ON `agent_contracts`
WHEN OLD.`abandonment_receipt` IS NOT NULL
  AND NEW.`abandonment_receipt` IS NOT OLD.`abandonment_receipt`
BEGIN
  SELECT RAISE(ABORT, 'abandonment authority receipt is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_contracts_abandonment_teardown_immutable`
BEFORE UPDATE OF `abandonment_teardown_receipt` ON `agent_contracts`
WHEN OLD.`abandonment_teardown_receipt` IS NOT NULL
  AND NEW.`abandonment_teardown_receipt` IS NOT OLD.`abandonment_teardown_receipt`
BEGIN
  SELECT RAISE(ABORT, 'abandonment teardown receipt is immutable');
END;
--> statement-breakpoint

-- First-write authority must at least carry the protocol/identity fields the
-- exact application guard validates before this SQL boundary.
CREATE TRIGGER `agent_contracts_abandonment_receipt_shape_guard`
BEFORE UPDATE OF `abandonment_receipt` ON `agent_contracts`
WHEN OLD.`abandonment_receipt` IS NULL
  AND NEW.`abandonment_receipt` IS NOT NULL AND COALESCE((
  json_valid(NEW.`abandonment_receipt`) <> 1
  OR json_extract(NEW.`abandonment_receipt`, '$.protocol') <> 'worktree-abandonment-v1'
  OR json_extract(NEW.`abandonment_receipt`, '$.approvedBy') <> 'user'
  OR json_extract(NEW.`abandonment_receipt`, '$.approvalSurface') <> 'browser'
  OR json_extract(NEW.`abandonment_receipt`, '$.approvalReason') <> 'explicit-browser-confirmation'
  OR json_extract(NEW.`abandonment_receipt`, '$.contractId') <> NEW.`id`
  OR json_extract(NEW.`abandonment_receipt`, '$.projectId') <> NEW.`project_id`
  OR json_extract(NEW.`abandonment_receipt`, '$.producerRunId') <> NEW.`agent_run_id`
  OR json_extract(NEW.`abandonment_receipt`, '$.worktreePath') <> NEW.`worktree_path`
  OR json_extract(NEW.`abandonment_receipt`, '$.baseBranch') <> NEW.`worktree_base_branch`
  OR json_extract(NEW.`abandonment_receipt`, '$.approvedContractVersion') <> OLD.`version`
  OR NEW.`review_run_id` IS NOT NULL
  OR NEW.`merge_sha` IS NOT NULL
  OR NEW.`landed_at` IS NOT NULL
  OR (
    OLD.`landing_status` NOT IN ('conflict', 'failed', 'stale-base', 'abandoned')
    AND OLD.`landing_status` IS NOT NULL
  )
  OR EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`contract_id` = NEW.`id`
      AND r.`status` IN ('queued', 'spawning', 'running', 'paused')
  )
  OR NOT EXISTS (
    SELECT 1 FROM `worktrees` w
    WHERE w.`id` = json_extract(NEW.`abandonment_receipt`, '$.worktreeId')
      AND w.`project_id` = NEW.`project_id`
      AND w.`agent_run_id` = NEW.`agent_run_id`
      AND w.`contract_id` = NEW.`id`
      AND w.`path` = NEW.`worktree_path`
      AND w.`name` = json_extract(NEW.`abandonment_receipt`, '$.branch')
      AND w.`branch` = json_extract(NEW.`abandonment_receipt`, '$.branch')
      AND w.`base_branch` = NEW.`worktree_base_branch`
      AND w.`status` = json_extract(NEW.`abandonment_receipt`, '$.worktreeStatus')
  )
), 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid abandonment authority receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_contracts_abandonment_teardown_shape_guard`
BEFORE UPDATE OF `abandonment_teardown_receipt` ON `agent_contracts`
WHEN OLD.`abandonment_teardown_receipt` IS NULL
  AND NEW.`abandonment_teardown_receipt` IS NOT NULL AND COALESCE((
  json_valid(NEW.`abandonment_teardown_receipt`) <> 1
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.protocol') <> 'worktree-abandonment-teardown-v1'
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.authorityRequestId')
    <> json_extract(NEW.`abandonment_receipt`, '$.requestId')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.worktreePath')
    <> json_extract(NEW.`abandonment_receipt`, '$.worktreePath')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.branch')
    <> json_extract(NEW.`abandonment_receipt`, '$.branch')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.approvedBranchTip')
    <> json_extract(NEW.`abandonment_receipt`, '$.branchTip')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.observedBranchTip')
    <> json_extract(NEW.`abandonment_receipt`, '$.branchTip')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.repositoryIdentity.protocol')
    <> json_extract(NEW.`abandonment_receipt`, '$.repositoryIdentity.protocol')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.repositoryIdentity.gitCommonDir')
    <> json_extract(NEW.`abandonment_receipt`, '$.repositoryIdentity.gitCommonDir')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.repositoryIdentity.leaseKey')
    <> json_extract(NEW.`abandonment_receipt`, '$.repositoryIdentity.leaseKey')
  OR json_type(NEW.`abandonment_teardown_receipt`, '$.startedAt') <> 'integer'
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.startedAt') < 0
  OR json_type(NEW.`abandonment_teardown_receipt`, '$.finishedAt') <> 'integer'
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.finishedAt')
    < json_extract(NEW.`abandonment_teardown_receipt`, '$.startedAt')
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.directoryAbsent') <> 1
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.registrationAbsent') <> 1
  OR json_extract(NEW.`abandonment_teardown_receipt`, '$.branchPreserved') <> 1
  OR NOT EXISTS (
    SELECT 1 FROM `worktrees` w
    WHERE w.`id` = json_extract(NEW.`abandonment_receipt`, '$.worktreeId')
      AND w.`project_id` = NEW.`project_id`
      AND w.`agent_run_id` = NEW.`agent_run_id`
      AND w.`contract_id` = NEW.`id`
      AND w.`path` = json_extract(NEW.`abandonment_receipt`, '$.worktreePath')
      AND w.`name` = json_extract(NEW.`abandonment_receipt`, '$.branch')
      AND w.`branch` = json_extract(NEW.`abandonment_receipt`, '$.branch')
      AND w.`base_branch` = json_extract(NEW.`abandonment_receipt`, '$.baseBranch')
      AND w.`status` = 'destroyed'
      AND w.`destroyed_at` = json_extract(
        NEW.`abandonment_teardown_receipt`, '$.finishedAt'
      )
  )
), 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid abandonment teardown receipt');
END;
--> statement-breakpoint

-- State/receipt coherence. The receipt-less abandoned variant is retained
-- solely for legacy readability and carries no cleanup authority.
CREATE TRIGGER `agent_contracts_abandonment_state_guard`
BEFORE UPDATE OF `landing_status`, `abandonment_receipt`, `abandonment_teardown_receipt`, `abandonment_error`
ON `agent_contracts`
WHEN NOT (
  (
    NEW.`landing_status` = 'abandoning'
    AND NEW.`abandonment_receipt` IS NOT NULL
    AND NEW.`abandonment_teardown_receipt` IS NULL
    AND (
      NEW.`abandonment_error` IS NULL
      OR (length(NEW.`abandonment_error`) > 0 AND NEW.`abandonment_error` = trim(NEW.`abandonment_error`))
    )
  )
  OR (
    NEW.`landing_status` = 'abandoned'
    AND NEW.`abandonment_error` IS NULL
    AND (
      (NEW.`abandonment_receipt` IS NULL AND NEW.`abandonment_teardown_receipt` IS NULL)
      OR (NEW.`abandonment_receipt` IS NOT NULL AND NEW.`abandonment_teardown_receipt` IS NOT NULL)
    )
  )
  OR (
    (NEW.`landing_status` IS NULL OR NEW.`landing_status` NOT IN ('abandoning', 'abandoned'))
    AND NEW.`abandonment_receipt` IS NULL
    AND NEW.`abandonment_teardown_receipt` IS NULL
    AND NEW.`abandonment_error` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid abandonment state/receipt combination');
END;
--> statement-breakpoint

-- Legacy receipt-less `abandoned` rows remain readable, but no post-migration
-- writer may manufacture another one. All new destructive settlements require
-- the immutable authority and positive teardown receipts above.
CREATE TRIGGER `agent_contracts_legacy_abandoned_transition_guard`
BEFORE UPDATE OF `landing_status` ON `agent_contracts`
WHEN NEW.`landing_status` = 'abandoned'
  AND OLD.`landing_status` IS NOT 'abandoned'
  AND NEW.`abandonment_receipt` IS NULL
  AND NEW.`abandonment_teardown_receipt` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'new abandonment requires authority and teardown receipts');
END;
--> statement-breakpoint

-- A continuation or replacement run can never be inserted after landing or
-- browser authority reserves the contract. Legacy abandoned rows are also
-- frozen until a fresh explicit browser approval repairs them.
CREATE TRIGGER `agent_runs_abandonment_insert_fence`
BEFORE INSERT ON `agent_runs`
WHEN NEW.`contract_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `agent_contracts` c
  WHERE c.`id` = NEW.`contract_id`
    AND (
      c.`abandonment_receipt` IS NOT NULL
      OR c.`landing_status` IN ('pending', 'abandoning', 'landed', 'abandoned')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'contract abandonment or landing forbids new agent runs');
END;
--> statement-breakpoint

-- Contract snapshots in the replay buffer predate the now-required receipt
-- fields. HTTP re-seeds durable current truth on every socket epoch.
DELETE FROM `live_outbox` WHERE `entity` = 'contract';
