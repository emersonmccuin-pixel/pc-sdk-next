-- DL-004: workspace-owned detached independent-review checkout authority.
-- The reservation is durable before Git mutation; every later write is a
-- guarded state transition through the workspace repository.

CREATE TABLE `review_checkouts` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`),
  `contract_id` text NOT NULL REFERENCES `agent_contracts`(`id`),
  `contract_version` integer NOT NULL CHECK (`contract_version` > 0),
  `producer_run_id` text NOT NULL,
  `reviewer_run_id` text NOT NULL,
  `repository_identity` text NOT NULL CHECK (
    json_valid(`repository_identity`)
    AND json_extract(`repository_identity`, '$.protocol') IS 'git-common-dir-v1'
    AND length(json_extract(`repository_identity`, '$.gitCommonDir')) > 0
    AND json_extract(`repository_identity`, '$.leaseKey') GLOB 'sha256:[0-9a-f]*'
    AND length(json_extract(`repository_identity`, '$.leaseKey')) = 71
  ),
  `worktree_path` text NOT NULL CHECK (length(trim(`worktree_path`)) > 0),
  `owned_root_real_path` text NOT NULL CHECK (length(trim(`owned_root_real_path`)) > 0),
  `sealed_commit` text NOT NULL CHECK (
    length(`sealed_commit`) IN (40, 64) AND `sealed_commit` NOT GLOB '*[^0-9a-f]*'
  ),
  `status` text NOT NULL CHECK (`status` IN (
    'reserved', 'provisioned', 'teardown-pending', 'destroyed'
  )),
  `provision_receipt` text,
  `preparation_receipt` text,
  `readiness_receipt` text,
  `teardown_receipt` text,
  `cleanup_error` text,
  `created_at` integer NOT NULL CHECK (`created_at` >= 0),
  `updated_at` integer NOT NULL CHECK (`updated_at` >= `created_at`),
  `destroyed_at` integer,
  CHECK (
    (`status` = 'reserved'
      AND `provision_receipt` IS NULL
      AND `teardown_receipt` IS NULL
      AND `cleanup_error` IS NULL
      AND `destroyed_at` IS NULL)
    OR (`status` = 'provisioned'
      AND `provision_receipt` IS NOT NULL
      AND `teardown_receipt` IS NULL
      AND `cleanup_error` IS NULL
      AND `destroyed_at` IS NULL)
    OR (`status` = 'teardown-pending'
      AND `teardown_receipt` IS NULL
      AND `destroyed_at` IS NULL)
    OR (`status` = 'destroyed'
      AND `teardown_receipt` IS NOT NULL
      AND `cleanup_error` IS NULL
      AND `destroyed_at` = `updated_at`)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_checkouts_reviewer_idx`
  ON `review_checkouts` (`reviewer_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_checkouts_contract_current_idx`
  ON `review_checkouts` (`contract_id`) WHERE `status` <> 'destroyed';
--> statement-breakpoint
CREATE UNIQUE INDEX `review_checkouts_path_current_idx`
  ON `review_checkouts` (`worktree_path`) WHERE `status` <> 'destroyed';
--> statement-breakpoint
CREATE INDEX `review_checkouts_recovery_idx`
  ON `review_checkouts` (`status`, `updated_at`);
--> statement-breakpoint

-- Reservation must match the exact already-reserved contract frame. The
-- reviewer run must not exist yet: its insertion is downstream of the
-- workspace's positive provision/preparation/readiness gate.
CREATE TRIGGER `review_checkouts_insert_guard`
BEFORE INSERT ON `review_checkouts`
WHEN NEW.`status` <> 'reserved'
  OR NEW.`provision_receipt` IS NOT NULL
  OR NEW.`preparation_receipt` IS NOT NULL
  OR NEW.`readiness_receipt` IS NOT NULL
  OR NEW.`teardown_receipt` IS NOT NULL
  OR NEW.`cleanup_error` IS NOT NULL
  OR NEW.`destroyed_at` IS NOT NULL
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

CREATE TRIGGER `review_checkouts_no_delete`
BEFORE DELETE ON `review_checkouts`
BEGIN
  SELECT RAISE(ABORT, 'review checkout evidence is append-only');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_authority_immutable`
BEFORE UPDATE ON `review_checkouts`
WHEN NEW.`id` IS NOT OLD.`id`
  OR NEW.`project_id` IS NOT OLD.`project_id`
  OR NEW.`contract_id` IS NOT OLD.`contract_id`
  OR NEW.`contract_version` IS NOT OLD.`contract_version`
  OR NEW.`producer_run_id` IS NOT OLD.`producer_run_id`
  OR NEW.`reviewer_run_id` IS NOT OLD.`reviewer_run_id`
  OR NEW.`repository_identity` IS NOT OLD.`repository_identity`
  OR NEW.`worktree_path` IS NOT OLD.`worktree_path`
  OR NEW.`owned_root_real_path` IS NOT OLD.`owned_root_real_path`
  OR NEW.`sealed_commit` IS NOT OLD.`sealed_commit`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'review checkout authority is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_state_guard`
BEFORE UPDATE OF `status` ON `review_checkouts`
WHEN NOT (
  (OLD.`status` = NEW.`status`)
  OR (OLD.`status` = 'reserved' AND NEW.`status` IN ('provisioned', 'teardown-pending'))
  OR (OLD.`status` = 'provisioned' AND NEW.`status` = 'teardown-pending')
  OR (OLD.`status` = 'teardown-pending' AND NEW.`status` = 'destroyed')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout state transition');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_provision_guard`
BEFORE UPDATE OF `provision_receipt` ON `review_checkouts`
WHEN OLD.`provision_receipt` IS NOT NULL
  OR NEW.`provision_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR NOT json_valid(NEW.`provision_receipt`)
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
  OR json_extract(NEW.`provision_receipt`, '$.observedAt') < 0
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.gitCommonDir')
       IS NOT json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`provision_receipt`, '$.repositoryIdentity.leaseKey')
       IS NOT json_extract(NEW.`repository_identity`, '$.leaseKey')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout provision receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_preparation_guard`
BEFORE UPDATE OF `preparation_receipt` ON `review_checkouts`
WHEN OLD.`preparation_receipt` IS NOT NULL
  OR NEW.`preparation_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR NEW.`readiness_receipt` IS NOT NULL
  OR NOT json_valid(NEW.`preparation_receipt`)
  OR json_extract(NEW.`preparation_receipt`, '$.phase') IS NOT 'preparation'
  OR json_type(NEW.`preparation_receipt`, '$.ok') NOT IN ('true', 'false')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout preparation receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_readiness_guard`
BEFORE UPDATE OF `readiness_receipt` ON `review_checkouts`
WHEN OLD.`readiness_receipt` IS NOT NULL
  OR NEW.`readiness_receipt` IS NULL
  OR NEW.`status` <> 'provisioned'
  OR OLD.`preparation_receipt` IS NULL
  OR json_extract(OLD.`preparation_receipt`, '$.ok') IS NOT 1
  OR NOT json_valid(NEW.`readiness_receipt`)
  OR json_extract(NEW.`readiness_receipt`, '$.phase') IS NOT 'readiness'
  OR json_type(NEW.`readiness_receipt`, '$.ok') NOT IN ('true', 'false')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout readiness receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_cleanup_error_guard`
BEFORE UPDATE OF `cleanup_error` ON `review_checkouts`
WHEN NEW.`cleanup_error` IS NOT NULL AND (
  NEW.`status` <> 'teardown-pending'
  OR length(trim(NEW.`cleanup_error`)) = 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout cleanup error');
END;
--> statement-breakpoint

CREATE TRIGGER `review_checkouts_teardown_guard`
BEFORE UPDATE OF `teardown_receipt` ON `review_checkouts`
WHEN OLD.`teardown_receipt` IS NOT NULL
  OR NEW.`teardown_receipt` IS NULL
  OR NEW.`status` <> 'destroyed'
  OR NOT json_valid(NEW.`teardown_receipt`)
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
  OR json_extract(NEW.`teardown_receipt`, '$.startedAt') < 0
  OR json_type(NEW.`teardown_receipt`, '$.finishedAt') IS NOT 'integer'
  OR json_extract(NEW.`teardown_receipt`, '$.finishedAt') < json_extract(NEW.`teardown_receipt`, '$.startedAt')
  OR json_extract(NEW.`teardown_receipt`, '$.directoryAbsent') IS NOT 1
  OR json_extract(NEW.`teardown_receipt`, '$.registrationAbsent') IS NOT 1
  OR json_extract(NEW.`teardown_receipt`, '$.branchDeletion') IS NOT 'not-applicable-detached'
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.protocol') IS NOT 'git-common-dir-v1'
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.gitCommonDir')
       IS NOT json_extract(NEW.`repository_identity`, '$.gitCommonDir')
  OR json_extract(NEW.`teardown_receipt`, '$.repositoryIdentity.leaseKey')
       IS NOT json_extract(NEW.`repository_identity`, '$.leaseKey')
BEGIN
  SELECT RAISE(ABORT, 'invalid review checkout teardown receipt');
END;
