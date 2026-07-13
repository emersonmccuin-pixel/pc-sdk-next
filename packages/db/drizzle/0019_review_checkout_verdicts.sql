-- DL-004 hostile-review closure: phase evidence is checkout-bound, and a
-- terminal verdict survives teardown until its contract effect commits.

ALTER TABLE `review_checkouts` ADD COLUMN `verdict_receipt` text;
--> statement-breakpoint
ALTER TABLE `review_checkouts` ADD COLUMN `verdict_applied_at` integer;
--> statement-breakpoint
CREATE INDEX `review_checkouts_verdict_recovery_idx`
  ON `review_checkouts` (`verdict_applied_at`, `updated_at`)
  WHERE `verdict_receipt` IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_verdict_insert_guard`
BEFORE INSERT ON `review_checkouts`
WHEN NEW.`verdict_receipt` IS NOT NULL OR NEW.`verdict_applied_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'review checkout verdict evidence must be appended');
END;
--> statement-breakpoint

-- 0018's table CHECK validated only the three identity values, not the closed
-- nested shape used by the domain. Close the raw-insert door before any new
-- workspace authority can be persisted with provider/native spill fields.
DROP TRIGGER `review_checkouts_insert_guard`;
--> statement-breakpoint
CREATE TRIGGER `review_checkouts_insert_guard`
BEFORE INSERT ON `review_checkouts`
WHEN NEW.`status` <> 'reserved'
  OR NEW.`provision_receipt` IS NOT NULL
  OR NEW.`preparation_receipt` IS NOT NULL
  OR NEW.`readiness_receipt` IS NOT NULL
  OR NEW.`verdict_receipt` IS NOT NULL
  OR NEW.`verdict_applied_at` IS NOT NULL
  OR NEW.`teardown_receipt` IS NOT NULL
  OR NEW.`cleanup_error` IS NOT NULL
  OR NEW.`destroyed_at` IS NOT NULL
  OR length(NEW.`id`) <> 26
  OR substr(NEW.`id`, 1, 1) NOT GLOB '[0-7]'
  OR NEW.`id` GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR length(NEW.`project_id`) <> 26
  OR substr(NEW.`project_id`, 1, 1) NOT GLOB '[0-7]'
  OR NEW.`project_id` GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR length(NEW.`contract_id`) <> 26
  OR substr(NEW.`contract_id`, 1, 1) NOT GLOB '[0-7]'
  OR NEW.`contract_id` GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR length(NEW.`producer_run_id`) <> 26
  OR substr(NEW.`producer_run_id`, 1, 1) NOT GLOB '[0-7]'
  OR NEW.`producer_run_id` GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR length(NEW.`reviewer_run_id`) <> 26
  OR substr(NEW.`reviewer_run_id`, 1, 1) NOT GLOB '[0-7]'
  OR NEW.`reviewer_run_id` GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR typeof(NEW.`contract_version`) <> 'integer'
  OR NEW.`contract_version` NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.`created_at`) <> 'integer'
  OR NEW.`created_at` NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` IS NOT NEW.`created_at`
  OR trim(NEW.`worktree_path`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR NEW.`worktree_path` <>
    trim(NEW.`worktree_path`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR trim(NEW.`owned_root_real_path`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR NEW.`owned_root_real_path` <>
    trim(NEW.`owned_root_real_path`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`repository_identity`) IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`repository_identity`) AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`repository_identity`)) <> 3
  OR json_extract(NEW.`repository_identity`, '$.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`repository_identity`, '$.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`repository_identity`, '$.gitCommonDir') <>
    trim(json_extract(NEW.`repository_identity`, '$.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`repository_identity`, '$.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`repository_identity`, '$.leaseKey')) <> 71
  OR substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`repository_identity`, '$.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'
  OR EXISTS (SELECT 1 FROM `agent_runs` r WHERE r.`id` = NEW.`reviewer_run_id`)
  OR NOT EXISTS (
    SELECT 1 FROM `agent_contracts` c
    WHERE c.`id` = NEW.`contract_id`
      AND c.`project_id` = NEW.`project_id`
      AND c.`version` = NEW.`contract_version`
      AND c.`agent_run_id` = NEW.`producer_run_id`
      AND c.`review_run_id` = NEW.`reviewer_run_id`
      AND c.`review_sealed_commit` = NEW.`sealed_commit`
      AND c.`verification_status` = 'passed'
      AND c.`landing_status` IS NULL
      AND c.`abandonment_receipt` IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout reservation authority');
END;
--> statement-breakpoint

DROP TRIGGER `review_checkouts_provision_guard`;
--> statement-breakpoint
CREATE TRIGGER `review_checkouts_provision_guard`
BEFORE UPDATE OF `provision_receipt` ON `review_checkouts`
WHEN OLD.`provision_receipt` IS NOT NULL
  OR NEW.`provision_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` NOT BETWEEN 0 AND 9007199254740991
  OR NOT json_valid(NEW.`provision_receipt`)
  OR json_type(NEW.`provision_receipt`) IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`provision_receipt`) AS field
    WHERE field.key NOT IN (
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'registrationCount',
      'registrationPath', 'headSha', 'detachedHead', 'trackedChanges',
      'stagedChanges', 'observedAt'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`provision_receipt`)) <> 18
  OR json_type(NEW.`provision_receipt`, '$.repositoryIdentity') IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`provision_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`provision_receipt`, '$.repositoryIdentity')) <> 3
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir') <>
    trim(json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey')) <> 71
  OR substr(json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'
  OR json_extract(NEW.`provision_receipt`, '$.protocol') IS NOT 'review-checkout-provision-v1'
  OR json_extract(NEW.`provision_receipt`, '$.id') IS NOT NEW.`id`
  OR json_extract(NEW.`provision_receipt`, '$.projectId') IS NOT NEW.`project_id`
  OR json_extract(NEW.`provision_receipt`, '$.contractId') IS NOT NEW.`contract_id`
  OR json_extract(NEW.`provision_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
  OR json_extract(NEW.`provision_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
  OR json_extract(NEW.`provision_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
  OR json_extract(NEW.`provision_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`provision_receipt`, '$.registrationPath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`provision_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
  OR json_extract(NEW.`provision_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
  OR json_extract(NEW.`provision_receipt`, '$.headSha') IS NOT NEW.`sealed_commit`
  OR json_extract(NEW.`provision_receipt`, '$.registrationCount') IS NOT 1
  OR json_extract(NEW.`provision_receipt`, '$.detachedHead') IS NOT 1
  OR json_extract(NEW.`provision_receipt`, '$.trackedChanges') IS NOT 0
  OR json_extract(NEW.`provision_receipt`, '$.stagedChanges') IS NOT 0
  OR json_type(NEW.`provision_receipt`, '$.observedAt') IS NOT 'integer'
  OR json_extract(NEW.`provision_receipt`, '$.observedAt') NOT BETWEEN 0 AND 9007199254740991
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir')
       IS NOT json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey')
       IS NOT json_extract(NEW.`repository_identity`, '$.leaseKey')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout provision receipt');
END;
--> statement-breakpoint

DROP TRIGGER `review_checkouts_teardown_guard`;
--> statement-breakpoint
CREATE TRIGGER `review_checkouts_teardown_guard`
BEFORE UPDATE OF `teardown_receipt` ON `review_checkouts`
WHEN OLD.`teardown_receipt` IS NOT NULL
  OR NEW.`teardown_receipt` IS NULL
  OR NEW.`status` <> 'destroyed'
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.`destroyed_at`) <> 'integer'
  OR NEW.`destroyed_at` IS NOT NEW.`updated_at`
  OR NOT json_valid(NEW.`teardown_receipt`)
  OR json_type(NEW.`teardown_receipt`) IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`teardown_receipt`) AS field
    WHERE field.key NOT IN (
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'startedAt', 'finishedAt',
      'directoryAbsent', 'registrationAbsent', 'branchDeletion'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`teardown_receipt`)) <> 16
  OR json_type(NEW.`teardown_receipt`, '$.repositoryIdentity') IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`teardown_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`teardown_receipt`, '$.repositoryIdentity')) <> 3
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir') <>
    trim(json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey')) <> 71
  OR substr(json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'
  OR json_extract(NEW.`teardown_receipt`, '$.protocol') IS NOT 'review-checkout-teardown-v1'
  OR json_extract(NEW.`teardown_receipt`, '$.id') IS NOT NEW.`id`
  OR json_extract(NEW.`teardown_receipt`, '$.projectId') IS NOT NEW.`project_id`
  OR json_extract(NEW.`teardown_receipt`, '$.contractId') IS NOT NEW.`contract_id`
  OR json_extract(NEW.`teardown_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
  OR json_extract(NEW.`teardown_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
  OR json_extract(NEW.`teardown_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
  OR json_extract(NEW.`teardown_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`teardown_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
  OR json_extract(NEW.`teardown_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
  OR json_type(NEW.`teardown_receipt`, '$.startedAt') IS NOT 'integer'
  OR json_extract(NEW.`teardown_receipt`, '$.startedAt') NOT BETWEEN 0 AND 9007199254740991
  OR json_type(NEW.`teardown_receipt`, '$.finishedAt') IS NOT 'integer'
  OR json_extract(NEW.`teardown_receipt`, '$.finishedAt') NOT BETWEEN
       json_extract(NEW.`teardown_receipt`, '$.startedAt') AND 9007199254740991
  OR json_extract(NEW.`teardown_receipt`, '$.directoryAbsent') IS NOT 1
  OR json_extract(NEW.`teardown_receipt`, '$.registrationAbsent') IS NOT 1
  OR json_extract(NEW.`teardown_receipt`, '$.branchDeletion') IS NOT 'not-applicable-detached'
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir')
       IS NOT json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey')
       IS NOT json_extract(NEW.`repository_identity`, '$.leaseKey')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout teardown receipt');
END;
--> statement-breakpoint

DROP TRIGGER `review_checkouts_preparation_guard`;
--> statement-breakpoint
DROP TRIGGER `review_checkouts_readiness_guard`;
--> statement-breakpoint
-- Binding cannot be inferred for rows written by the pre-DL-004 prototype.
-- Clear both copies so a later boot fails closed and re-prepares/retires them.
-- Advance the run revision as part of the quarantine. A browser may retain a
-- pre-upgrade equal-revision outbox frame across reconnect; the newer HTTP seed
-- must outrank that stale in-memory projection.
UPDATE `agent_runs`
SET `preparation_receipt` = NULL, `readiness_receipt` = NULL, `rev` = `rev` + 1
WHERE `id` IN (SELECT `reviewer_run_id` FROM `review_checkouts`)
  AND (`preparation_receipt` IS NOT NULL OR `readiness_receipt` IS NOT NULL);
--> statement-breakpoint
UPDATE `review_checkouts`
SET `preparation_receipt` = NULL, `readiness_receipt` = NULL
WHERE `preparation_receipt` IS NOT NULL OR `readiness_receipt` IS NOT NULL;
--> statement-breakpoint
-- The pre-0019 teardown owner removed the checkout before it interpreted the
-- terminal reviewer payload. Preserve a typed unavailable decision only when
-- the exact target/producer frame can still consume it; stale frames become
-- void so their exact marker can retire without reviving legacy approve/reject
-- payload after its unbound phase evidence was quarantined.
UPDATE `review_checkouts` AS rc
SET `verdict_receipt` = json_object(
  'protocol', 'review-checkout-verdict-v1',
  'id', rc.`id`,
  'projectId', rc.`project_id`,
  'contractId', rc.`contract_id`,
  'contractVersion', rc.`contract_version`,
  'producerRunId', rc.`producer_run_id`,
  'reviewerRunId', rc.`reviewer_run_id`,
  'repositoryIdentity', json(rc.`repository_identity`),
  'worktreePath', rc.`worktree_path`,
  'ownedRootRealPath', rc.`owned_root_real_path`,
  'sealedCommit', rc.`sealed_commit`,
  'reviewerContractId', (
    SELECT r.`contract_id` FROM `agent_runs` r WHERE r.`id` = rc.`reviewer_run_id`
  ),
  'terminalStatus', (
    SELECT r.`status` FROM `agent_runs` r WHERE r.`id` = rc.`reviewer_run_id`
  ),
  'outcome', CASE WHEN
    EXISTS (
      SELECT 1 FROM `agent_contracts` c
      WHERE c.`id` = rc.`contract_id`
        AND c.`version` = rc.`contract_version`
        AND c.`agent_run_id` = rc.`producer_run_id`
        AND c.`review_run_id` = rc.`reviewer_run_id`
        AND c.`review_sealed_commit` = rc.`sealed_commit`
        AND c.`verification_status` = 'passed'
        AND c.`landing_status` IS NULL
        AND c.`abandonment_receipt` IS NULL
        AND json_extract(c.`deliverable`, '$.commit') = rc.`sealed_commit`
    )
    AND EXISTS (
      SELECT 1 FROM `agent_runs` producer
      WHERE producer.`id` = rc.`producer_run_id`
        AND producer.`contract_id` = rc.`contract_id`
        AND producer.`status` IN ('completed', 'failed', 'cancelled')
        AND producer.`lifecycle_state` = 'reviewing'
    )
    AND NOT EXISTS (
      SELECT 1 FROM `agent_runs` live
      WHERE live.`contract_id` = rc.`contract_id`
        AND live.`status` IN ('queued', 'spawning', 'running', 'paused')
    )
    THEN 'unavailable' ELSE 'void' END,
  'findings', json('[]'),
  'recordedAt', COALESCE(rc.`destroyed_at`, rc.`updated_at`)
)
WHERE rc.`status` = 'destroyed'
  AND rc.`verdict_receipt` IS NULL
  AND rc.`verdict_applied_at` IS NULL
  AND rc.`teardown_receipt` IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`id` = rc.`reviewer_run_id`
      AND r.`status` IN ('completed', 'failed', 'cancelled')
      AND r.`contract_id` IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM `agent_contracts` c
    WHERE c.`id` = rc.`contract_id`
      AND c.`review_run_id` = rc.`reviewer_run_id`
  );
--> statement-breakpoint
UPDATE `live_outbox`
SET `payload` = json_set(
  `payload`,
  '$.run.preparationReceipt', NULL,
  '$.run.readinessReceipt', NULL
)
WHERE `entity` = 'agent-run'
  AND `entity_id` IN (SELECT `reviewer_run_id` FROM `review_checkouts`)
  AND json_valid(`payload`)
  AND json_type(`payload`, '$.run') = 'object';
--> statement-breakpoint
-- A client may already hold a cursor after the corrected historical frame.
-- Append the newest corrected reviewer frame once so every reconnect observes
-- an equal/newer canonical projection without deleting an interior sequence.
INSERT INTO `live_outbox` (
  `id`, `scope`, `project_id`, `type`, `entity`, `entity_id`, `version`,
  `payload`, `created_at`, `published_at`
)
SELECT
  '0' || substr(hex(randomblob(13)), 1, 25),
  e.`scope`, e.`project_id`, e.`type`, e.`entity`, e.`entity_id`, r.`rev`,
  json_set(e.`payload`, '$.run.rev', r.`rev`), e.`created_at`, NULL
FROM `live_outbox` e
INNER JOIN `agent_runs` r ON r.`id` = e.`entity_id`
WHERE e.`entity` = 'agent-run'
  AND e.`entity_id` IN (SELECT `reviewer_run_id` FROM `review_checkouts`)
  AND e.`seq` = (
    SELECT max(latest.`seq`)
    FROM `live_outbox` latest
    WHERE latest.`entity` = 'agent-run'
      AND latest.`entity_id` = e.`entity_id`
  );
--> statement-breakpoint
CREATE TRIGGER `review_checkouts_preparation_guard`
BEFORE UPDATE OF `preparation_receipt` ON `review_checkouts`
WHEN OLD.`preparation_receipt` IS NOT NULL
  OR NEW.`preparation_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` NOT BETWEEN 0 AND 9007199254740991
  OR NEW.`readiness_receipt` IS NOT NULL
  OR NOT json_valid(NEW.`preparation_receipt`)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`preparation_receipt`) AS field
    WHERE field.key NOT IN (
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'evidence'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`preparation_receipt`)) <> 12
  OR json_type(NEW.`preparation_receipt`, '$.repositoryIdentity') IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`preparation_receipt`, '$.repositoryIdentity')) <> 3
  OR json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`preparation_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.gitCommonDir') <>
    trim(json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`preparation_receipt`, '$.repositoryIdentity.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.leaseKey')) <> 71
  OR substr(json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'

  OR json_extract(NEW.`preparation_receipt`, '$.protocol') IS NOT 'review-checkout-phase-v1'
  OR json_extract(NEW.`preparation_receipt`, '$.id') IS NOT NEW.`id`
  OR json_extract(NEW.`preparation_receipt`, '$.projectId') IS NOT NEW.`project_id`
  OR json_extract(NEW.`preparation_receipt`, '$.contractId') IS NOT NEW.`contract_id`
  OR json_extract(NEW.`preparation_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
  OR json_extract(NEW.`preparation_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
  OR json_extract(NEW.`preparation_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
  OR json_extract(NEW.`preparation_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`preparation_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
  OR json_extract(NEW.`preparation_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
  OR json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.protocol') IS NOT
       json_extract(NEW.`repository_identity`, '$.protocol')
  OR json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT
       json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`preparation_receipt`, '$.repositoryIdentity.leaseKey') IS NOT
       json_extract(NEW.`repository_identity`, '$.leaseKey')
  OR json_extract(NEW.`preparation_receipt`, '$.evidence.phase') IS NOT 'preparation'
  OR json_type(NEW.`preparation_receipt`, '$.evidence.ok') NOT IN ('true', 'false')
  OR json_extract(NEW.`preparation_receipt`, '$.evidence.reason') IS 'existing-worktree-preparation'
  OR NOT (
    json_type(NEW.`preparation_receipt`, '$.evidence') = 'object'
    AND json_type(NEW.`preparation_receipt`, '$.evidence.finishedAt') = 'integer'
    AND json_extract(NEW.`preparation_receipt`, '$.evidence.finishedAt') BETWEEN 0 AND 9007199254740991
    AND (
      (
        json_extract(NEW.`preparation_receipt`, '$.evidence.outcome') = 'executed'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.evidence') AS field
          WHERE field.key NOT IN ('phase', 'outcome', 'ok', 'steps', 'finishedAt')
        )
        AND (SELECT count(*) FROM json_each(NEW.`preparation_receipt`, '$.evidence')) = 5
        AND json_type(NEW.`preparation_receipt`, '$.evidence.steps') = 'array'
        AND json_array_length(NEW.`preparation_receipt`, '$.evidence.steps') > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.evidence.steps') AS step
          WHERE json_type(step.value) <> 'object'
            OR (SELECT count(*) FROM json_each(step.value)) <> 6
            OR EXISTS (
              SELECT 1 FROM json_each(step.value) AS field
              WHERE field.key NOT IN (
                'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
              )
            )
            OR json_type(step.value, '$.command') <> 'text'
            OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
            OR json_extract(step.value, '$.command') <>
              trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
            OR json_type(step.value, '$.exitCode') <> 'integer'
            OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
            OR json_type(step.value, '$.durationMs') <> 'integer'
            OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
            OR json_type(step.value, '$.stdoutTail') <> 'text'
            OR json_type(step.value, '$.stderrTail') <> 'text'
            OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
        )
        AND (
          (json_extract(NEW.`preparation_receipt`, '$.evidence.ok') = 1 AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.evidence.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          ))
          OR (json_extract(NEW.`preparation_receipt`, '$.evidence.ok') = 0 AND EXISTS (
            SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.evidence.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          ))
        )
      )
      OR (
        json_extract(NEW.`preparation_receipt`, '$.evidence.outcome') = 'not-required'
        AND json_extract(NEW.`preparation_receipt`, '$.evidence.reason') = 'no-commands-configured'
        AND json_extract(NEW.`preparation_receipt`, '$.evidence.ok') = 1
        AND json_type(NEW.`preparation_receipt`, '$.evidence.steps') = 'array'
        AND json_array_length(NEW.`preparation_receipt`, '$.evidence.steps') = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`preparation_receipt`, '$.evidence') AS field
          WHERE field.key NOT IN ('phase', 'outcome', 'reason', 'ok', 'steps', 'finishedAt')
        )
        AND (SELECT count(*) FROM json_each(NEW.`preparation_receipt`, '$.evidence')) = 6
      )
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`id` = NEW.`reviewer_run_id`
      AND r.`status` = 'queued'
      AND r.`preparation_receipt` = json_extract(NEW.`preparation_receipt`, '$.evidence')
      AND r.`readiness_receipt` IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid checkout-bound review preparation receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_readiness_guard`
BEFORE UPDATE OF `readiness_receipt` ON `review_checkouts`
WHEN OLD.`readiness_receipt` IS NOT NULL
  OR NEW.`readiness_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` NOT BETWEEN 0 AND 9007199254740991
  OR OLD.`preparation_receipt` IS NULL
  OR json_extract(OLD.`preparation_receipt`, '$.evidence.ok') IS NOT 1
  OR NOT json_valid(NEW.`readiness_receipt`)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`readiness_receipt`) AS field
    WHERE field.key NOT IN (
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'evidence'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`readiness_receipt`)) <> 12
  OR json_type(NEW.`readiness_receipt`, '$.repositoryIdentity') IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`readiness_receipt`, '$.repositoryIdentity')) <> 3
  OR json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`readiness_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.gitCommonDir') <>
    trim(json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`readiness_receipt`, '$.repositoryIdentity.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.leaseKey')) <> 71
  OR substr(json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'

  OR json_extract(NEW.`readiness_receipt`, '$.protocol') IS NOT 'review-checkout-phase-v1'
  OR json_extract(NEW.`readiness_receipt`, '$.id') IS NOT NEW.`id`
  OR json_extract(NEW.`readiness_receipt`, '$.projectId') IS NOT NEW.`project_id`
  OR json_extract(NEW.`readiness_receipt`, '$.contractId') IS NOT NEW.`contract_id`
  OR json_extract(NEW.`readiness_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
  OR json_extract(NEW.`readiness_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
  OR json_extract(NEW.`readiness_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
  OR json_extract(NEW.`readiness_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`readiness_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
  OR json_extract(NEW.`readiness_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
  OR json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.protocol') IS NOT
       json_extract(NEW.`repository_identity`, '$.protocol')
  OR json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT
       json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`readiness_receipt`, '$.repositoryIdentity.leaseKey') IS NOT
       json_extract(NEW.`repository_identity`, '$.leaseKey')
  OR json_extract(NEW.`readiness_receipt`, '$.evidence.phase') IS NOT 'readiness'
  OR json_type(NEW.`readiness_receipt`, '$.evidence.ok') NOT IN ('true', 'false')
  OR NOT (
    json_type(NEW.`readiness_receipt`, '$.evidence') = 'object'
    AND json_type(NEW.`readiness_receipt`, '$.evidence.finishedAt') = 'integer'
    AND json_extract(NEW.`readiness_receipt`, '$.evidence.finishedAt') BETWEEN 0 AND 9007199254740991
    AND (
      (
        json_extract(NEW.`readiness_receipt`, '$.evidence.outcome') = 'executed'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.evidence') AS field
          WHERE field.key NOT IN ('phase', 'outcome', 'ok', 'steps', 'finishedAt')
        )
        AND (SELECT count(*) FROM json_each(NEW.`readiness_receipt`, '$.evidence')) = 5
        AND json_type(NEW.`readiness_receipt`, '$.evidence.steps') = 'array'
        AND json_array_length(NEW.`readiness_receipt`, '$.evidence.steps') > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.evidence.steps') AS step
          WHERE json_type(step.value) <> 'object'
            OR (SELECT count(*) FROM json_each(step.value)) <> 6
            OR EXISTS (
              SELECT 1 FROM json_each(step.value) AS field
              WHERE field.key NOT IN (
                'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
              )
            )
            OR json_type(step.value, '$.command') <> 'text'
            OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
            OR json_extract(step.value, '$.command') <>
              trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
            OR json_type(step.value, '$.exitCode') <> 'integer'
            OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
            OR json_type(step.value, '$.durationMs') <> 'integer'
            OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
            OR json_type(step.value, '$.stdoutTail') <> 'text'
            OR json_type(step.value, '$.stderrTail') <> 'text'
            OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
        )
        AND (
          (json_extract(NEW.`readiness_receipt`, '$.evidence.ok') = 1 AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.evidence.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          ))
          OR (json_extract(NEW.`readiness_receipt`, '$.evidence.ok') = 0 AND EXISTS (
            SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.evidence.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          ))
        )
      )
      OR (
        json_extract(NEW.`readiness_receipt`, '$.evidence.outcome') = 'not-required'
        AND json_extract(NEW.`readiness_receipt`, '$.evidence.reason') = 'no-commands-configured'
        AND json_extract(NEW.`readiness_receipt`, '$.evidence.ok') = 1
        AND json_type(NEW.`readiness_receipt`, '$.evidence.steps') = 'array'
        AND json_array_length(NEW.`readiness_receipt`, '$.evidence.steps') = 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`readiness_receipt`, '$.evidence') AS field
          WHERE field.key NOT IN ('phase', 'outcome', 'reason', 'ok', 'steps', 'finishedAt')
        )
        AND (SELECT count(*) FROM json_each(NEW.`readiness_receipt`, '$.evidence')) = 6
      )
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`id` = NEW.`reviewer_run_id`
      AND r.`status` = 'queued'
      AND r.`preparation_receipt` = json_extract(OLD.`preparation_receipt`, '$.evidence')
      AND r.`readiness_receipt` = json_extract(NEW.`readiness_receipt`, '$.evidence')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid checkout-bound review readiness receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_review_preparation_immutable`
BEFORE UPDATE OF `preparation_receipt` ON `agent_runs`
WHEN EXISTS (
  SELECT 1 FROM `review_checkouts` rc
  WHERE rc.`reviewer_run_id` = OLD.`id`
    AND rc.`preparation_receipt` IS NOT NULL
)
AND NEW.`preparation_receipt` IS NOT OLD.`preparation_receipt`
BEGIN
  SELECT RAISE(ABORT, 'reviewer preparation evidence is immutable once checkout-bound');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_review_readiness_immutable`
BEFORE UPDATE OF `readiness_receipt` ON `agent_runs`
WHEN EXISTS (
  SELECT 1 FROM `review_checkouts` rc
  WHERE rc.`reviewer_run_id` = OLD.`id`
    AND rc.`readiness_receipt` IS NOT NULL
)
AND NEW.`readiness_receipt` IS NOT OLD.`readiness_receipt`
BEGIN
  SELECT RAISE(ABORT, 'reviewer readiness evidence is immutable once checkout-bound');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_verdict_guard`
BEFORE UPDATE OF `verdict_receipt` ON `review_checkouts`
WHEN OLD.`verdict_receipt` IS NOT NULL
  OR NEW.`verdict_receipt` IS NULL
  OR NEW.`status` NOT IN ('provisioned', 'teardown-pending')
  OR typeof(NEW.`updated_at`) <> 'integer'
  OR NEW.`updated_at` NOT BETWEEN 0 AND 9007199254740991
  OR NEW.`teardown_receipt` IS NOT NULL
  OR NEW.`verdict_applied_at` IS NOT NULL
  OR NOT json_valid(NEW.`verdict_receipt`)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`verdict_receipt`) AS field
    WHERE field.key NOT IN (
      'protocol', 'id', 'projectId', 'contractId', 'contractVersion',
      'producerRunId', 'reviewerRunId', 'repositoryIdentity', 'worktreePath',
      'ownedRootRealPath', 'sealedCommit', 'reviewerContractId',
      'terminalStatus', 'outcome', 'findings', 'recordedAt'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`verdict_receipt`)) <> 16
  OR json_type(NEW.`verdict_receipt`, '$.repositoryIdentity') IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`verdict_receipt`, '$.repositoryIdentity') AS field
    WHERE field.key NOT IN ('protocol', 'gitCommonDir', 'leaseKey')
  )
  OR (SELECT count(*) FROM json_each(NEW.`verdict_receipt`, '$.repositoryIdentity')) <> 3
  OR json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_type(NEW.`verdict_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT 'text'
  OR trim(json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
  OR json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.gitCommonDir') <>
    trim(json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.gitCommonDir'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  OR json_type(NEW.`verdict_receipt`, '$.repositoryIdentity.leaseKey') IS NOT 'text'
  OR length(json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.leaseKey')) <> 71
  OR substr(json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.leaseKey'), 1, 7) <> 'sha256:'
  OR substr(json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.leaseKey'), 8)
    GLOB '*[^0-9a-f]*'

  OR json_extract(NEW.`verdict_receipt`, '$.protocol') IS NOT 'review-checkout-verdict-v1'
  OR json_extract(NEW.`verdict_receipt`, '$.id') IS NOT NEW.`id`
  OR json_extract(NEW.`verdict_receipt`, '$.projectId') IS NOT NEW.`project_id`
  OR json_extract(NEW.`verdict_receipt`, '$.contractId') IS NOT NEW.`contract_id`
  OR json_extract(NEW.`verdict_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
  OR json_extract(NEW.`verdict_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
  OR json_extract(NEW.`verdict_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
  OR json_extract(NEW.`verdict_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
  OR json_extract(NEW.`verdict_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
  OR json_extract(NEW.`verdict_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
  OR json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.protocol') IS NOT
       json_extract(NEW.`repository_identity`, '$.protocol')
  OR json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.gitCommonDir') IS NOT
       json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`verdict_receipt`, '$.repositoryIdentity.leaseKey') IS NOT
       json_extract(NEW.`repository_identity`, '$.leaseKey')
  OR json_extract(NEW.`verdict_receipt`, '$.outcome') NOT IN (
    'approve', 'reject', 'unavailable', 'void', 'overridden'
  )
  OR json_extract(NEW.`verdict_receipt`, '$.terminalStatus') NOT IN (
    'completed', 'failed', 'cancelled'
  )
  OR json_type(NEW.`verdict_receipt`, '$.findings') IS NOT 'array'
  OR json_type(NEW.`verdict_receipt`, '$.recordedAt') IS NOT 'integer'
  OR json_extract(NEW.`verdict_receipt`, '$.recordedAt') NOT BETWEEN 0 AND 9007199254740991
  OR (
    json_extract(NEW.`verdict_receipt`, '$.outcome') IN ('unavailable', 'void', 'overridden')
    AND json_array_length(NEW.`verdict_receipt`, '$.findings') <> 0
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`verdict_receipt`, '$.findings') AS finding
    WHERE json_type(finding.value) <> 'object'
      OR (SELECT count(*) FROM json_each(finding.value)) NOT IN (3, 4)
      OR EXISTS (
        SELECT 1 FROM json_each(finding.value) AS field
        WHERE field.key NOT IN ('file', 'line', 'summary', 'severity')
      )
      OR json_type(finding.value, '$.file') <> 'text'
      OR json_type(finding.value, '$.summary') <> 'text'
      OR json_extract(finding.value, '$.severity') NOT IN ('critical', 'major', 'minor')
      OR (json_type(finding.value, '$.line') IS NOT NULL
        AND json_type(finding.value, '$.line') NOT IN ('integer', 'real'))
  )
  OR NOT EXISTS (
    -- Every verdict outcome is consumable only by its still-current exact
    -- review marker. Void and overridden may relax the stable target frame,
    -- but cannot retire a newer review reservation.
    SELECT 1 FROM `agent_contracts` marked_target
    WHERE marked_target.`id` = NEW.`contract_id`
      AND marked_target.`review_run_id` = NEW.`reviewer_run_id`
  )
  OR (
    json_extract(NEW.`verdict_receipt`, '$.outcome') IN ('approve', 'reject', 'unavailable')
    AND (
      -- Stable verdict evidence may be minted only while its exact target
      -- reservation is still consumable. Drifted frames retire as void or
      -- overridden; they must never become destroyed-unapplied poison.
      NOT EXISTS (
        SELECT 1 FROM `agent_contracts` target
        WHERE target.`id` = NEW.`contract_id`
          AND target.`version` = NEW.`contract_version`
          AND target.`agent_run_id` = NEW.`producer_run_id`
          AND target.`review_run_id` = NEW.`reviewer_run_id`
          AND target.`review_sealed_commit` = NEW.`sealed_commit`
          AND target.`verification_status` = 'passed'
          AND target.`landing_status` IS NULL
          AND target.`abandonment_receipt` IS NULL
          AND json_extract(target.`deliverable`, '$.commit') = NEW.`sealed_commit`
      )
      OR NOT EXISTS (
        SELECT 1 FROM `agent_runs` producer
        WHERE producer.`id` = NEW.`producer_run_id`
          AND producer.`contract_id` = NEW.`contract_id`
          AND producer.`status` IN ('completed', 'failed', 'cancelled')
          AND producer.`lifecycle_state` = 'reviewing'
      )
      OR EXISTS (
        SELECT 1 FROM `agent_runs` live
        WHERE live.`contract_id` = NEW.`contract_id`
          AND live.`status` IN ('queued', 'spawning', 'running', 'paused')
      )
    )
  )
  OR (
    json_extract(NEW.`verdict_receipt`, '$.outcome') IN ('approve', 'reject')
    AND (
      -- Approve/reject is authorized only by the exact runtime-ready checkout
      -- evidence. Quarantined legacy phases can record unavailable/void only.
      NEW.`status` <> 'provisioned'
      OR NEW.`cleanup_error` IS NOT NULL
      OR NEW.`destroyed_at` IS NOT NULL
      OR NEW.`provision_receipt` IS NULL
      OR json_extract(NEW.`provision_receipt`, '$.protocol') IS NOT 'review-checkout-provision-v1'
      OR json_extract(NEW.`provision_receipt`, '$.id') IS NOT NEW.`id`
      OR json_extract(NEW.`provision_receipt`, '$.projectId') IS NOT NEW.`project_id`
      OR json_extract(NEW.`provision_receipt`, '$.contractId') IS NOT NEW.`contract_id`
      OR json_extract(NEW.`provision_receipt`, '$.contractVersion') IS NOT NEW.`contract_version`
      OR json_extract(NEW.`provision_receipt`, '$.producerRunId') IS NOT NEW.`producer_run_id`
      OR json_extract(NEW.`provision_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
      OR json_extract(NEW.`provision_receipt`, '$.worktreePath') IS NOT NEW.`worktree_path`
      OR json_extract(NEW.`provision_receipt`, '$.ownedRootRealPath') IS NOT NEW.`owned_root_real_path`
      OR json_extract(NEW.`provision_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
      OR json_extract(NEW.`provision_receipt`, '$.registrationCount') IS NOT 1
      OR json_extract(NEW.`provision_receipt`, '$.registrationPath') IS NOT NEW.`worktree_path`
      OR json_extract(NEW.`provision_receipt`, '$.headSha') IS NOT NEW.`sealed_commit`
      OR json_extract(NEW.`provision_receipt`, '$.detachedHead') IS NOT 1
      OR json_extract(NEW.`provision_receipt`, '$.trackedChanges') IS NOT 0
      OR json_extract(NEW.`provision_receipt`, '$.stagedChanges') IS NOT 0
      OR NEW.`preparation_receipt` IS NULL
      OR NEW.`readiness_receipt` IS NULL
      OR json_extract(NEW.`preparation_receipt`, '$.protocol') IS NOT 'review-checkout-phase-v1'
      OR json_extract(NEW.`preparation_receipt`, '$.id') IS NOT NEW.`id`
      OR json_extract(NEW.`preparation_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
      OR json_extract(NEW.`preparation_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
      OR json_extract(NEW.`preparation_receipt`, '$.evidence.phase') IS NOT 'preparation'
      OR json_extract(NEW.`preparation_receipt`, '$.evidence.ok') IS NOT 1
      OR json_extract(NEW.`preparation_receipt`, '$.evidence.outcome') NOT IN ('executed', 'not-required')
      OR json_extract(NEW.`readiness_receipt`, '$.protocol') IS NOT 'review-checkout-phase-v1'
      OR json_extract(NEW.`readiness_receipt`, '$.id') IS NOT NEW.`id`
      OR json_extract(NEW.`readiness_receipt`, '$.reviewerRunId') IS NOT NEW.`reviewer_run_id`
      OR json_extract(NEW.`readiness_receipt`, '$.sealedCommit') IS NOT NEW.`sealed_commit`
      OR json_extract(NEW.`readiness_receipt`, '$.evidence.phase') IS NOT 'readiness'
      OR json_extract(NEW.`readiness_receipt`, '$.evidence.ok') IS NOT 1
      OR json_extract(NEW.`readiness_receipt`, '$.evidence.outcome') NOT IN ('executed', 'not-required')
      OR NOT EXISTS (
        SELECT 1 FROM `agent_runs` phase_run
        WHERE phase_run.`id` = NEW.`reviewer_run_id`
          AND phase_run.`preparation_receipt` = json_extract(NEW.`preparation_receipt`, '$.evidence')
          AND phase_run.`readiness_receipt` = json_extract(NEW.`readiness_receipt`, '$.evidence')
      )
      OR NOT EXISTS (
        SELECT 1 FROM `agent_runs` producer
        WHERE producer.`id` = NEW.`producer_run_id`
          AND producer.`status` IN ('completed', 'failed', 'cancelled')
          AND producer.`lifecycle_state` = 'reviewing'
      )
      OR json_extract(NEW.`verdict_receipt`, '$.terminalStatus') <> 'completed'
      OR NOT EXISTS (
        SELECT 1 FROM `agent_contracts` reviewer
        WHERE reviewer.`id` = json_extract(NEW.`verdict_receipt`, '$.reviewerContractId')
          AND reviewer.`verification_status` = 'passed'
          AND json_extract(reviewer.`deliverable`, '$.data.verdict') =
              json_extract(NEW.`verdict_receipt`, '$.outcome')
          AND json_array_length(reviewer.`deliverable`, '$.data.findings') =
              json_array_length(NEW.`verdict_receipt`, '$.findings')
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.`verdict_receipt`, '$.findings') AS receipt_finding
            WHERE json_extract(receipt_finding.value, '$.file') IS NOT
                json_extract(reviewer.`deliverable`,
                  '$.data.findings[' || receipt_finding.key || '].file')
              OR json_extract(receipt_finding.value, '$.line') IS NOT
                json_extract(reviewer.`deliverable`,
                  '$.data.findings[' || receipt_finding.key || '].line')
              OR json_extract(receipt_finding.value, '$.summary') IS NOT
                json_extract(reviewer.`deliverable`,
                  '$.data.findings[' || receipt_finding.key || '].summary')
              OR json_extract(receipt_finding.value, '$.severity') IS NOT
                json_extract(reviewer.`deliverable`,
                  '$.data.findings[' || receipt_finding.key || '].severity')
          )
      )
    )
  )
  OR NOT EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`id` = NEW.`reviewer_run_id`
      AND r.`status` = json_extract(NEW.`verdict_receipt`, '$.terminalStatus')
      AND r.`status` IN ('completed', 'failed', 'cancelled')
      AND r.`contract_id` = json_extract(NEW.`verdict_receipt`, '$.reviewerContractId')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout verdict receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_verdict_applied_guard`
BEFORE UPDATE OF `verdict_applied_at` ON `review_checkouts`
WHEN OLD.`verdict_applied_at` IS NOT NULL
  OR NEW.`verdict_applied_at` IS NULL
  OR NEW.`status` <> 'destroyed'
  OR NEW.`teardown_receipt` IS NULL
  OR NEW.`verdict_receipt` IS NULL
  OR json_type(NEW.`verdict_applied_at`) IS NOT 'integer'
  OR NEW.`verdict_applied_at` NOT BETWEEN NEW.`destroyed_at` AND 9007199254740991
  OR NOT EXISTS (
    SELECT 1 FROM `agent_contracts` c
    WHERE c.`id` = NEW.`contract_id`
      AND c.`review_run_id` IS NULL
      AND (
        (json_extract(NEW.`verdict_receipt`, '$.outcome') = 'approve'
          AND c.`verification_status` = 'passed'
          AND c.`landing_status` = 'pending'
          AND c.`landing_authorizer` = 'reviewer')
        OR (json_extract(NEW.`verdict_receipt`, '$.outcome') = 'reject'
          AND c.`verification_status` = 'failed'
          AND c.`landing_status` IS NULL)
        OR json_extract(NEW.`verdict_receipt`, '$.outcome') IN (
          'unavailable', 'void', 'overridden'
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'review verdict effect requires positive teardown and atomic marker settlement');
END;
