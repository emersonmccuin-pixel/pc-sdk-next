-- RS-003: complete the specialist run half of immutable runtime selection.
-- Existing rows have no durable effort or execution snapshot, so their
-- provider-shaped values remain only untrusted native evidence and they are
-- explicitly quarantined from continuation.

ALTER TABLE `agent_runs`
  ADD `snapshot_state` text DEFAULT 'legacy-unavailable' NOT NULL
  CHECK (`snapshot_state` IN ('stamped', 'legacy-unavailable'));
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `specialist_snapshot` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `native_session_id` text;
--> statement-breakpoint
UPDATE `agent_runs` SET `native_session_id` = `cc_session_id`;
--> statement-breakpoint
ALTER TABLE `agent_runs`
  ADD `native_identity_state` text DEFAULT 'legacy-untrusted' NOT NULL
  CHECK (`native_identity_state` IN ('unbound', 'bound', 'legacy-untrusted'));
--> statement-breakpoint
ALTER TABLE `agent_runs`
  ADD `continuation_state` text DEFAULT 'legacy-unavailable' NOT NULL
  CHECK (`continuation_state` IN (
    'clean-pending', 'clean-started', 'resume-pending', 'native-resumed',
    'resume-failed', 'legacy-unavailable'
  ));
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `continuation_attempt_id` text;
--> statement-breakpoint
ALTER TABLE `agent_runs`
  ADD `selection_state` text DEFAULT 'legacy-unavailable' NOT NULL
  CHECK (`selection_state` IN ('stamped', 'legacy-unavailable'));
--> statement-breakpoint
ALTER TABLE `agent_runs`
  ADD `effort_state` text DEFAULT 'legacy-unknown' NOT NULL
  CHECK (`effort_state` IN ('selected', 'none', 'unavailable', 'legacy-unknown'));
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `effort` text;
--> statement-breakpoint

-- The pre-RS-003 runtime/account/model fields did not form a complete stamp.
-- Clear them rather than accidentally letting a later reader promote them.
UPDATE `agent_runs`
SET `runtime_id` = NULL, `account_id` = NULL, `model` = NULL;
--> statement-breakpoint

DROP INDEX `agent_runs_cc_session_idx`;
--> statement-breakpoint
ALTER TABLE `agent_runs` DROP COLUMN `cc_session_id`;
--> statement-breakpoint
ALTER TABLE `agent_runs` DROP COLUMN `pod_revision_at_dispatch`;
--> statement-breakpoint
ALTER TABLE `agent_runs` DROP COLUMN `pod_revision_at_resume`;
--> statement-breakpoint
CREATE INDEX `agent_runs_native_session_idx`
  ON `agent_runs` (`native_session_id`);
--> statement-breakpoint

-- Pending asks correlate exclusively through the app-owned run id. The native
-- id was unused by every ask command/query and must not survive as a DTO leak.
DROP INDEX `pending_asks_cc_session_idx`;
--> statement-breakpoint
ALTER TABLE `pending_asks` DROP COLUMN `cc_session_id`;
--> statement-breakpoint

-- Published agent-run resource rows contain the old provider-shaped DTO.
-- They are a prunable delivery cache, not durable run truth; current state is
-- re-primed from agent_runs under the new exact contract.
DELETE FROM `live_outbox` WHERE `entity` = 'agent-run';
--> statement-breakpoint

-- Post-migration inserts have one path only: a complete immutable snapshot and
-- selection plus either an unbound clean create or parent-derived native
-- resume. Legacy-unavailable exists solely for migrated evidence.
CREATE TRIGGER `agent_runs_complete_stamp_insert_guard`
BEFORE INSERT ON `agent_runs`
WHEN
  NEW.`snapshot_state` <> 'stamped'
  OR NEW.`specialist_snapshot` IS NULL
  OR json_valid(NEW.`specialist_snapshot`) IS NOT 1
  OR json_type(NEW.`specialist_snapshot`) IS NOT 'object'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`specialist_snapshot`) AS field
    WHERE field.key NOT IN (
      'specialistId', 'revision', 'name', 'charter', 'contextDocs', 'maxTurns'
    )
  )
  OR (SELECT count(*) FROM json_each(NEW.`specialist_snapshot`)) <> 6
  OR json_type(NEW.`specialist_snapshot`, '$.specialistId') IS NOT 'text'
  OR trim(json_extract(NEW.`specialist_snapshot`, '$.specialistId')) = ''
  OR json_extract(NEW.`specialist_snapshot`, '$.specialistId') <> trim(json_extract(NEW.`specialist_snapshot`, '$.specialistId'))
  OR json_type(NEW.`specialist_snapshot`, '$.revision') IS NOT 'text'
  OR trim(json_extract(NEW.`specialist_snapshot`, '$.revision')) = ''
  OR json_extract(NEW.`specialist_snapshot`, '$.revision') <> trim(json_extract(NEW.`specialist_snapshot`, '$.revision'))
  OR json_type(NEW.`specialist_snapshot`, '$.name') IS NOT 'text'
  OR trim(json_extract(NEW.`specialist_snapshot`, '$.name')) = ''
  OR json_extract(NEW.`specialist_snapshot`, '$.name') <> trim(json_extract(NEW.`specialist_snapshot`, '$.name'))
  OR json_extract(NEW.`specialist_snapshot`, '$.name') <> NEW.`pod_name`
  OR json_type(NEW.`specialist_snapshot`, '$.charter') IS NOT 'text'
  OR json_type(NEW.`specialist_snapshot`, '$.contextDocs') IS NOT 'array'
  OR json_type(NEW.`specialist_snapshot`, '$.maxTurns') IS NOT 'integer'
  OR json_extract(NEW.`specialist_snapshot`, '$.maxTurns') < 1
  OR json_extract(NEW.`specialist_snapshot`, '$.maxTurns') > 9007199254740991
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs') AS doc
    WHERE
      json_type(doc.value) IS NOT 'object'
      OR EXISTS (
        SELECT 1 FROM json_each(doc.value) AS field
        WHERE field.key NOT IN ('id', 'title', 'body', 'updatedAt')
      )
      OR (SELECT count(*) FROM json_each(doc.value)) <> 4
      OR json_type(doc.value, '$.id') IS NOT 'text'
      OR trim(json_extract(doc.value, '$.id')) = ''
      OR json_extract(doc.value, '$.id') <> trim(json_extract(doc.value, '$.id'))
      OR json_type(doc.value, '$.title') IS NOT 'text'
      OR trim(json_extract(doc.value, '$.title')) = ''
      OR json_extract(doc.value, '$.title') <> trim(json_extract(doc.value, '$.title'))
      OR json_type(doc.value, '$.body') IS NOT 'text'
      OR json_type(doc.value, '$.updatedAt') IS NOT 'integer'
      OR json_extract(doc.value, '$.updatedAt') < 0
      OR json_extract(doc.value, '$.updatedAt') > 9007199254740991
  )
  OR (
    SELECT count(*) FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs')
  ) <> (
    SELECT count(DISTINCT json_extract(doc.value, '$.id'))
    FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs') AS doc
  )
  OR NEW.`selection_state` <> 'stamped'
  OR trim(COALESCE(NEW.`runtime_id`, '')) = ''
  OR NEW.`runtime_id` <> trim(NEW.`runtime_id`)
  OR trim(COALESCE(NEW.`account_id`, '')) = ''
  OR NEW.`account_id` <> trim(NEW.`account_id`)
  OR trim(COALESCE(NEW.`model`, '')) = ''
  OR NEW.`model` <> trim(NEW.`model`)
  OR NEW.`effort_state` NOT IN ('selected', 'none', 'unavailable')
  OR (
    NEW.`effort_state` = 'selected'
    AND trim(COALESCE(NEW.`effort`, '')) = ''
  )
  OR (NEW.`effort_state` = 'selected' AND NEW.`effort` <> trim(NEW.`effort`))
  OR (
    NEW.`effort_state` IN ('none', 'unavailable')
    AND NEW.`effort` IS NOT NULL
  )
  OR NEW.`status` <> 'queued'
  OR trim(COALESCE(NEW.`continuation_attempt_id`, '')) = ''
  OR NEW.`continuation_attempt_id` <> trim(NEW.`continuation_attempt_id`)
  OR NOT (
    (
      NEW.`continues` IS NULL
      AND NEW.`native_identity_state` = 'unbound'
      AND NEW.`native_session_id` IS NULL
      AND NEW.`continuation_state` = 'clean-pending'
    )
    OR (
      NEW.`continues` IS NOT NULL
      AND NEW.`native_identity_state` = 'bound'
       AND trim(COALESCE(NEW.`native_session_id`, '')) <> ''
       AND NEW.`native_session_id` = trim(NEW.`native_session_id`)
      AND NEW.`continuation_state` = 'resume-pending'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'agent run requires a complete immutable execution stamp');
END;
--> statement-breakpoint

-- SQLite serializes writers, so this trigger is the cross-request/cross-
-- process exclusion door for one active child per parent. The optimistic
-- read-side check remains useful UX, but cannot be the invariant.
CREATE TRIGGER `agent_runs_active_continuation_insert_guard`
BEFORE INSERT ON `agent_runs`
WHEN
  NEW.`continues` IS NOT NULL
  AND NEW.`status` IN ('queued', 'spawning', 'running', 'paused')
  AND EXISTS (
    SELECT 1 FROM `agent_runs` AS sibling
    WHERE sibling.`continues` = NEW.`continues`
      AND sibling.`status` IN ('queued', 'spawning', 'running', 'paused')
  )
BEGIN
  SELECT RAISE(ABORT, 'agent run parent already has an active continuation');
END;
--> statement-breakpoint

-- A bound continuation is derived evidence, never a caller assertion. Require
-- byte-identical snapshot/selection/native identity from its stamped parent.
CREATE TRIGGER `agent_runs_continuation_parent_insert_guard`
BEFORE INSERT ON `agent_runs`
WHEN NEW.`native_identity_state` = 'bound'
AND NOT EXISTS (
  SELECT 1 FROM `agent_runs` AS parent
  WHERE
    parent.`id` = NEW.`continues`
    AND parent.`project_id` IS NEW.`project_id`
    AND parent.`status` IN ('completed', 'failed')
    AND parent.`contract_id` IS NEW.`contract_id`
    AND parent.`worktree_dir` IS NEW.`worktree_dir`
    AND parent.`worktree_base_branch` IS NEW.`worktree_base_branch`
    AND parent.`worktree_base_sha` IS NEW.`worktree_base_sha`
    AND parent.`pm_ref` IS NEW.`pm_ref`
    AND parent.`parent_invoke_depth` IS NEW.`parent_invoke_depth`
    AND parent.`snapshot_state` = 'stamped'
    AND parent.`specialist_snapshot` IS NEW.`specialist_snapshot`
    AND parent.`selection_state` = 'stamped'
    AND parent.`runtime_id` IS NEW.`runtime_id`
    AND parent.`account_id` IS NEW.`account_id`
    AND parent.`model` IS NEW.`model`
    AND parent.`effort_state` IS NEW.`effort_state`
    AND parent.`effort` IS NEW.`effort`
    AND parent.`native_identity_state` = 'bound'
    AND parent.`native_session_id` IS NEW.`native_session_id`
)
BEGIN
  SELECT RAISE(ABORT, 'agent run continuation must inherit exact parent execution evidence');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_selection_immutable_guard`
BEFORE UPDATE OF
  `selection_state`, `runtime_id`, `account_id`, `model`, `effort_state`, `effort`
ON `agent_runs`
WHEN
  NEW.`selection_state` IS NOT OLD.`selection_state`
  OR NEW.`runtime_id` IS NOT OLD.`runtime_id`
  OR NEW.`account_id` IS NOT OLD.`account_id`
  OR NEW.`model` IS NOT OLD.`model`
  OR NEW.`effort_state` IS NOT OLD.`effort_state`
  OR NEW.`effort` IS NOT OLD.`effort`
BEGIN
  SELECT RAISE(ABORT, 'agent run runtime selection is immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_snapshot_immutable_guard`
BEFORE UPDATE OF `snapshot_state`, `specialist_snapshot`, `pod_name`, `continues`
ON `agent_runs`
WHEN
  NEW.`snapshot_state` IS NOT OLD.`snapshot_state`
  OR NEW.`specialist_snapshot` IS NOT OLD.`specialist_snapshot`
  OR NEW.`pod_name` IS NOT OLD.`pod_name`
  OR NEW.`continues` IS NOT OLD.`continues`
BEGIN
  SELECT RAISE(ABORT, 'agent run specialist snapshot is immutable');
END;
--> statement-breakpoint

-- Project/contract/repository/PM/depth are part of the exact parent-derived
-- continuation scope checked above. Freeze that scope on every new stamped
-- row, including the original parent: otherwise either side could drift after
-- admission while retaining trusted native continuation evidence.
CREATE TRIGGER `agent_runs_execution_scope_immutable_guard`
BEFORE UPDATE OF
  `project_id`, `contract_id`, `worktree_dir`, `worktree_base_branch`,
  `worktree_base_sha`, `pm_ref`, `parent_invoke_depth`
ON `agent_runs`
WHEN
  OLD.`snapshot_state` = 'stamped'
  AND (
    NEW.`project_id` IS NOT OLD.`project_id`
    OR NEW.`contract_id` IS NOT OLD.`contract_id`
    OR NEW.`worktree_dir` IS NOT OLD.`worktree_dir`
    OR NEW.`worktree_base_branch` IS NOT OLD.`worktree_base_branch`
    OR NEW.`worktree_base_sha` IS NOT OLD.`worktree_base_sha`
    OR NEW.`pm_ref` IS NOT OLD.`pm_ref`
    OR NEW.`parent_invoke_depth` IS NOT OLD.`parent_invoke_depth`
  )
BEGIN
  SELECT RAISE(ABORT, 'agent run execution scope is immutable');
END;
--> statement-breakpoint

-- Validate the complete execution tuple on every update so no unrelated raw
-- write can carry forward an inconsistent row.
CREATE TRIGGER `agent_runs_row_state_consistency_guard`
BEFORE UPDATE ON `agent_runs`
WHEN COALESCE((
  (
    NEW.`snapshot_state` = 'legacy-unavailable'
    AND NEW.`specialist_snapshot` IS NULL
    AND NEW.`selection_state` = 'legacy-unavailable'
    AND NEW.`runtime_id` IS NULL
    AND NEW.`account_id` IS NULL
    AND NEW.`model` IS NULL
    AND NEW.`effort_state` = 'legacy-unknown'
    AND NEW.`effort` IS NULL
    AND NEW.`native_identity_state` = 'legacy-untrusted'
    AND NEW.`continuation_state` = 'legacy-unavailable'
    AND NEW.`continuation_attempt_id` IS NULL
  )
  OR (
    NEW.`snapshot_state` = 'stamped'
    AND NEW.`specialist_snapshot` IS NOT NULL
    AND json_valid(NEW.`specialist_snapshot`) = 1
    AND json_type(NEW.`specialist_snapshot`) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.`specialist_snapshot`) AS field
      WHERE field.key NOT IN (
        'specialistId', 'revision', 'name', 'charter', 'contextDocs', 'maxTurns'
      )
    )
    AND (SELECT count(*) FROM json_each(NEW.`specialist_snapshot`)) = 6
    AND json_type(NEW.`specialist_snapshot`, '$.specialistId') = 'text'
    AND trim(json_extract(NEW.`specialist_snapshot`, '$.specialistId')) <> ''
    AND json_extract(NEW.`specialist_snapshot`, '$.specialistId') = trim(json_extract(NEW.`specialist_snapshot`, '$.specialistId'))
    AND json_type(NEW.`specialist_snapshot`, '$.revision') = 'text'
    AND trim(json_extract(NEW.`specialist_snapshot`, '$.revision')) <> ''
    AND json_extract(NEW.`specialist_snapshot`, '$.revision') = trim(json_extract(NEW.`specialist_snapshot`, '$.revision'))
    AND json_type(NEW.`specialist_snapshot`, '$.name') = 'text'
    AND trim(json_extract(NEW.`specialist_snapshot`, '$.name')) <> ''
    AND json_extract(NEW.`specialist_snapshot`, '$.name') = trim(json_extract(NEW.`specialist_snapshot`, '$.name'))
    AND json_extract(NEW.`specialist_snapshot`, '$.name') = NEW.`pod_name`
    AND json_type(NEW.`specialist_snapshot`, '$.charter') = 'text'
    AND json_type(NEW.`specialist_snapshot`, '$.contextDocs') = 'array'
    AND json_type(NEW.`specialist_snapshot`, '$.maxTurns') = 'integer'
    AND json_extract(NEW.`specialist_snapshot`, '$.maxTurns') >= 1
    AND json_extract(NEW.`specialist_snapshot`, '$.maxTurns') <= 9007199254740991
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs') AS doc
      WHERE
        json_type(doc.value) IS NOT 'object'
        OR EXISTS (
          SELECT 1 FROM json_each(doc.value) AS field
          WHERE field.key NOT IN ('id', 'title', 'body', 'updatedAt')
        )
        OR (SELECT count(*) FROM json_each(doc.value)) <> 4
        OR json_type(doc.value, '$.id') IS NOT 'text'
        OR trim(json_extract(doc.value, '$.id')) = ''
        OR json_extract(doc.value, '$.id') <> trim(json_extract(doc.value, '$.id'))
        OR json_type(doc.value, '$.title') IS NOT 'text'
        OR trim(json_extract(doc.value, '$.title')) = ''
        OR json_extract(doc.value, '$.title') <> trim(json_extract(doc.value, '$.title'))
        OR json_type(doc.value, '$.body') IS NOT 'text'
        OR json_type(doc.value, '$.updatedAt') IS NOT 'integer'
        OR json_extract(doc.value, '$.updatedAt') < 0
        OR json_extract(doc.value, '$.updatedAt') > 9007199254740991
    )
    AND (
      SELECT count(*) FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs')
    ) = (
      SELECT count(DISTINCT json_extract(doc.value, '$.id'))
      FROM json_each(NEW.`specialist_snapshot`, '$.contextDocs') AS doc
    )
    AND NEW.`selection_state` = 'stamped'
    AND trim(COALESCE(NEW.`runtime_id`, '')) <> ''
    AND NEW.`runtime_id` = trim(NEW.`runtime_id`)
    AND trim(COALESCE(NEW.`account_id`, '')) <> ''
    AND NEW.`account_id` = trim(NEW.`account_id`)
    AND trim(COALESCE(NEW.`model`, '')) <> ''
    AND NEW.`model` = trim(NEW.`model`)
    AND NEW.`effort_state` IN ('selected', 'none', 'unavailable')
    AND trim(COALESCE(NEW.`continuation_attempt_id`, '')) <> ''
    AND NEW.`continuation_attempt_id` = trim(NEW.`continuation_attempt_id`)
    AND (
      (
        NEW.`effort_state` = 'selected'
        AND trim(COALESCE(NEW.`effort`, '')) <> ''
        AND NEW.`effort` = trim(NEW.`effort`)
      )
      OR (
        NEW.`effort_state` IN ('none', 'unavailable')
        AND NEW.`effort` IS NULL
      )
    )
    AND (
      (
        NEW.`continuation_state` = 'clean-pending'
        AND NEW.`status` IN ('queued', 'spawning', 'failed', 'cancelled')
      )
      OR (
        NEW.`continuation_state` = 'resume-pending'
        AND NEW.`status` IN ('queued', 'spawning', 'paused', 'failed', 'cancelled')
      )
      OR (
        NEW.`continuation_state` IN ('clean-started', 'native-resumed')
        AND NEW.`status` IN ('spawning', 'running', 'paused', 'completed', 'failed', 'cancelled')
      )
      OR (
        NEW.`continuation_state` = 'resume-failed'
        AND NEW.`status` IN ('spawning', 'paused', 'failed', 'cancelled')
      )
    )
    AND (
      (
        NEW.`native_identity_state` = 'unbound'
        AND NEW.`native_session_id` IS NULL
        AND NEW.`continuation_state` = 'clean-pending'
      )
      OR (
        NEW.`native_identity_state` = 'bound'
        AND trim(COALESCE(NEW.`native_session_id`, '')) <> ''
        AND NEW.`native_session_id` = trim(NEW.`native_session_id`)
        AND NEW.`continuation_state` IN (
          'clean-started', 'resume-pending', 'native-resumed', 'resume-failed'
        )
      )
    )
  )
), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'agent run execution row is inconsistent');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_native_identity_bind_once_guard`
BEFORE UPDATE OF `native_session_id`, `native_identity_state`
ON `agent_runs`
WHEN NOT (
  (
    OLD.`native_identity_state` = 'unbound'
    AND (
      (
        NEW.`native_identity_state` = 'unbound'
        AND NEW.`native_session_id` IS NULL
      )
      OR (
        OLD.`continuation_state` = 'clean-pending'
        AND NEW.`continuation_state` = 'clean-started'
        AND NEW.`status` = 'spawning'
        AND NEW.`native_identity_state` = 'bound'
        AND trim(COALESCE(NEW.`native_session_id`, '')) <> ''
        AND NEW.`continuation_attempt_id` IS OLD.`continuation_attempt_id`
      )
    )
  )
  OR (
    OLD.`native_identity_state` = 'bound'
    AND NEW.`native_identity_state` = 'bound'
    AND NEW.`native_session_id` IS OLD.`native_session_id`
  )
  OR (
    OLD.`native_identity_state` = 'legacy-untrusted'
    AND NEW.`native_identity_state` = 'legacy-untrusted'
    AND NEW.`native_session_id` IS OLD.`native_session_id`
  )
)
BEGIN
  SELECT RAISE(ABORT, 'agent run native identity may bind only once');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_running_requires_receipt_guard`
BEFORE UPDATE OF `status`
ON `agent_runs`
WHEN
  NEW.`status` = 'running'
  AND NOT (
    NEW.`native_identity_state` = 'bound'
    AND trim(COALESCE(NEW.`native_session_id`, '')) <> ''
    AND NEW.`continuation_state` IN ('clean-started', 'native-resumed')
  )
BEGIN
  SELECT RAISE(ABORT, 'agent run cannot run before an exact native session receipt');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_continuation_attempt_change_guard`
BEFORE UPDATE OF `continuation_attempt_id`
ON `agent_runs`
WHEN
  NEW.`continuation_attempt_id` IS NOT OLD.`continuation_attempt_id`
  AND NOT (
    trim(COALESCE(NEW.`continuation_attempt_id`, '')) <> ''
    AND NEW.`selection_state` = 'stamped'
    AND NEW.`snapshot_state` = 'stamped'
    AND NEW.`status` IN ('queued', 'spawning', 'running', 'paused')
    AND (
      (
        OLD.`native_identity_state` = 'unbound'
        AND OLD.`native_session_id` IS NULL
        AND OLD.`continuation_state` = 'clean-pending'
        AND NEW.`native_identity_state` = 'unbound'
        AND NEW.`native_session_id` IS NULL
        AND NEW.`continuation_state` = 'clean-pending'
      )
      OR (
        OLD.`native_identity_state` = 'bound'
        AND trim(COALESCE(OLD.`native_session_id`, '')) <> ''
        AND OLD.`continuation_state` IN (
          'clean-started', 'resume-pending', 'native-resumed', 'resume-failed'
        )
        AND NEW.`native_identity_state` = 'bound'
        AND NEW.`native_session_id` IS OLD.`native_session_id`
        AND NEW.`continuation_state` = 'resume-pending'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid agent run continuation attempt rotation');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_resume_requires_fresh_attempt_guard`
BEFORE UPDATE OF `continuation_state`
ON `agent_runs`
WHEN
  NEW.`native_identity_state` = 'bound'
  AND NEW.`continuation_state` = 'resume-pending'
  AND NEW.`continuation_state` IS NOT OLD.`continuation_state`
  AND NEW.`continuation_attempt_id` IS OLD.`continuation_attempt_id`
BEGIN
  SELECT RAISE(ABORT, 'agent run resume requires a fresh continuation attempt');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_continuation_transition_guard`
BEFORE UPDATE OF `continuation_state`
ON `agent_runs`
WHEN NOT (
  NEW.`continuation_state` = OLD.`continuation_state`
  OR (
    OLD.`continuation_state` = 'clean-pending'
    AND NEW.`continuation_state` = 'clean-started'
    AND NEW.`status` = 'spawning'
  )
  OR (
    OLD.`continuation_state` IN ('clean-started', 'native-resumed', 'resume-failed')
    AND NEW.`continuation_state` = 'resume-pending'
  )
  OR (
    OLD.`continuation_state` = 'resume-pending'
    AND (
      (NEW.`continuation_state` = 'native-resumed' AND NEW.`status` = 'spawning')
      OR (
        NEW.`continuation_state` = 'resume-failed'
        AND NEW.`status` IN ('spawning', 'paused')
      )
    )
  )
  OR (
    OLD.`continuation_state` = 'legacy-unavailable'
    AND NEW.`continuation_state` = 'legacy-unavailable'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent run continuation transition');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_status_value_guard`
BEFORE UPDATE OF `status`
ON `agent_runs`
WHEN NEW.`status` NOT IN (
  'queued', 'spawning', 'running', 'paused', 'completed', 'failed', 'cancelled'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent run status');
END;
--> statement-breakpoint

CREATE TRIGGER `agent_runs_terminal_reactivation_guard`
BEFORE UPDATE OF `status`
ON `agent_runs`
WHEN
  OLD.`status` IN ('completed', 'failed', 'cancelled')
  AND NEW.`status` IS NOT OLD.`status`
BEGIN
  SELECT RAISE(ABORT, 'terminal agent run status is immutable');
END;
