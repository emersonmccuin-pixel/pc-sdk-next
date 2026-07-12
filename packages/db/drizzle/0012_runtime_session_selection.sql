-- RS-001: replace the provider-shaped orchestrator-session identity with an
-- immutable runtime/account/model/effort stamp and bind-once native identity.
-- Existing rows intentionally remain legacy-unavailable: provider/default
-- guesses are not durable truth. Their prior native id is retained only as
-- untrusted evidence, and active legacy rows are ended before new work can be
-- admitted under today's defaults.

ALTER TABLE `orchestrator_sessions`
  RENAME COLUMN `provider_session_id` TO `native_session_id`;
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions`
  ADD `selection_state` text DEFAULT 'legacy-unavailable' NOT NULL
  CHECK (`selection_state` IN ('stamped', 'legacy-unavailable'));
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` ADD `runtime_id` text;
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` ADD `account_id` text;
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions`
  ADD `effort_state` text DEFAULT 'legacy-unknown' NOT NULL
  CHECK (`effort_state` IN ('selected', 'none', 'unavailable', 'legacy-unknown'));
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` ADD `effort` text;
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions`
  ADD `native_identity_state` text DEFAULT 'legacy-untrusted' NOT NULL
  CHECK (`native_identity_state` IN ('unbound', 'bound', 'legacy-untrusted'));
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions`
  ADD `continuation_state` text DEFAULT 'legacy-unavailable' NOT NULL
  CHECK (`continuation_state` IN (
    'clean-pending', 'clean-started', 'resume-pending', 'native-resumed',
    'resume-failed', 'legacy-unavailable'
  ));
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` ADD `continuation_attempt_id` text;
--> statement-breakpoint
UPDATE `orchestrator_sessions`
SET
  `status` = 'ended',
  `ended_reason` = 'selection_unavailable',
  `ended_at` = COALESCE(
    `ended_at`,
    CAST(strftime('%s', 'now') AS integer) * 1000
  )
WHERE `status` = 'active';
--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` DROP COLUMN `provider`;
--> statement-breakpoint

-- Post-migration inserts are one path only: complete stamped, clean sessions.
-- Legacy-unavailable is solely a migration state and cannot be minted later.
CREATE TRIGGER `orch_sessions_complete_stamp_insert_guard`
BEFORE INSERT ON `orchestrator_sessions`
WHEN
  NEW.`selection_state` <> 'stamped'
  OR trim(COALESCE(NEW.`runtime_id`, '')) = ''
  OR trim(COALESCE(NEW.`account_id`, '')) = ''
  OR trim(COALESCE(NEW.`model`, '')) = ''
  OR NEW.`effort_state` NOT IN ('selected', 'none', 'unavailable')
  OR (
    NEW.`effort_state` = 'selected'
    AND trim(COALESCE(NEW.`effort`, '')) = ''
  )
  OR (
    NEW.`effort_state` IN ('none', 'unavailable')
    AND NEW.`effort` IS NOT NULL
  )
  OR NEW.`native_identity_state` <> 'unbound'
  OR NEW.`native_session_id` IS NOT NULL
  OR NEW.`continuation_state` <> 'clean-pending'
  OR trim(COALESCE(NEW.`continuation_attempt_id`, '')) = ''
  OR NEW.`status` <> 'active'
  OR NEW.`ended_reason` IS NOT NULL
  OR NEW.`ended_at` IS NOT NULL
  OR NEW.`deleted_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'orchestrator session requires a complete immutable runtime selection');
END;
--> statement-breakpoint

CREATE TRIGGER `orch_sessions_selection_immutable_guard`
BEFORE UPDATE OF
  `selection_state`, `runtime_id`, `account_id`, `model`, `effort_state`, `effort`
ON `orchestrator_sessions`
WHEN
  NEW.`selection_state` IS NOT OLD.`selection_state`
  OR NEW.`runtime_id` IS NOT OLD.`runtime_id`
  OR NEW.`account_id` IS NOT OLD.`account_id`
  OR NEW.`model` IS NOT OLD.`model`
  OR NEW.`effort_state` IS NOT OLD.`effort_state`
  OR NEW.`effort` IS NOT OLD.`effort`
BEGIN
  SELECT RAISE(ABORT, 'orchestrator session runtime selection is immutable');
END;
--> statement-breakpoint

-- The individual transition guards below are not sufficient on their own:
-- one raw statement could otherwise bind a native id without recording a
-- successful clean start, or move continuation while identity is unbound.
-- Validate the complete tuple on every update, including unrelated-column
-- updates, so an inconsistent row cannot be carried forward.
CREATE TRIGGER `orch_sessions_row_state_consistency_guard`
BEFORE UPDATE ON `orchestrator_sessions`
WHEN NOT (
  (
    NEW.`selection_state` = 'legacy-unavailable'
    AND NEW.`runtime_id` IS NULL
    AND NEW.`account_id` IS NULL
    AND NEW.`effort_state` = 'legacy-unknown'
    AND NEW.`effort` IS NULL
    AND NEW.`native_identity_state` = 'legacy-untrusted'
    AND NEW.`continuation_state` = 'legacy-unavailable'
    AND NEW.`continuation_attempt_id` IS NULL
  )
  OR (
    NEW.`selection_state` = 'stamped'
    AND trim(COALESCE(NEW.`runtime_id`, '')) <> ''
    AND trim(COALESCE(NEW.`account_id`, '')) <> ''
    AND trim(COALESCE(NEW.`model`, '')) <> ''
    AND NEW.`effort_state` IN ('selected', 'none', 'unavailable')
    AND trim(COALESCE(NEW.`continuation_attempt_id`, '')) <> ''
    AND (
      (
        NEW.`effort_state` = 'selected'
        AND trim(COALESCE(NEW.`effort`, '')) <> ''
      )
      OR (
        NEW.`effort_state` IN ('none', 'unavailable')
        AND NEW.`effort` IS NULL
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
        AND NEW.`continuation_state` IN (
          'clean-started', 'resume-pending', 'native-resumed', 'resume-failed'
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'orchestrator session row state is inconsistent');
END;
--> statement-breakpoint

-- Migrated rows have no trustworthy immutable selection. They remain visible
-- as ended evidence, but can never be reactivated through raw SQL or a future
-- repository path that forgets the eligibility check.
CREATE TRIGGER `orch_sessions_legacy_quarantine_guard`
BEFORE UPDATE OF `status` ON `orchestrator_sessions`
WHEN
  NEW.`selection_state` = 'legacy-unavailable'
  AND NEW.`status` = 'active'
BEGIN
  SELECT RAISE(ABORT, 'legacy orchestrator session cannot be reactivated');
END;
--> statement-breakpoint

-- The attempt id is a durable generation fence. It can rotate only as the
-- atomic preparation for an actual provider create/resume mint. Repeated
-- preparation is intentional after a crash: a newer id makes every receipt
-- or failure from the abandoned attempt stale.
CREATE TRIGGER `orch_sessions_continuation_attempt_change_guard`
BEFORE UPDATE OF `continuation_attempt_id`
ON `orchestrator_sessions`
WHEN
  NEW.`continuation_attempt_id` IS NOT OLD.`continuation_attempt_id`
  AND NOT (
    trim(COALESCE(NEW.`continuation_attempt_id`, '')) <> ''
    AND NEW.`selection_state` = 'stamped'
    AND NEW.`status` = 'active'
    AND NEW.`deleted_at` IS NULL
    AND (
      (
        OLD.`status` = 'active'
        AND OLD.`native_identity_state` = 'unbound'
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
  SELECT RAISE(ABORT, 'invalid orchestrator continuation attempt rotation');
END;
--> statement-breakpoint

-- Moving (or explicitly re-preparing) a bound row as resume-pending without
-- rotating its generation would let an older success/failure mutate it.
CREATE TRIGGER `orch_sessions_resume_requires_fresh_attempt_guard`
BEFORE UPDATE OF `continuation_state`
ON `orchestrator_sessions`
WHEN
  NEW.`native_identity_state` = 'bound'
  AND NEW.`continuation_state` = 'resume-pending'
  AND NEW.`continuation_attempt_id` IS OLD.`continuation_attempt_id`
BEGIN
  SELECT RAISE(ABORT, 'orchestrator resume requires a fresh continuation attempt');
END;
--> statement-breakpoint

-- Historical stamped reactivation is a resume preparation, never a plain
-- status flip. Require identity, pending state, and generation rotation in the
-- same statement. Legacy rows have their stricter quarantine guard above.
CREATE TRIGGER `orch_sessions_stamped_reactivation_guard`
BEFORE UPDATE OF `status`
ON `orchestrator_sessions`
WHEN
  OLD.`status` <> 'active'
  AND NEW.`status` = 'active'
  AND NEW.`selection_state` = 'stamped'
  AND NOT (
    OLD.`native_identity_state` = 'bound'
    AND trim(COALESCE(OLD.`native_session_id`, '')) <> ''
    AND OLD.`continuation_state` IN (
      'clean-started', 'resume-pending', 'native-resumed', 'resume-failed'
    )
    AND NEW.`native_identity_state` = 'bound'
    AND NEW.`native_session_id` IS OLD.`native_session_id`
    AND NEW.`continuation_state` = 'resume-pending'
    AND trim(COALESCE(NEW.`continuation_attempt_id`, '')) <> ''
    AND NEW.`continuation_attempt_id` IS NOT OLD.`continuation_attempt_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'stamped orchestrator reactivation requires a fresh resume attempt');
END;
--> statement-breakpoint

CREATE TRIGGER `orch_sessions_continuation_transition_guard`
BEFORE UPDATE OF `continuation_state`
ON `orchestrator_sessions`
WHEN NOT (
  NEW.`continuation_state` = OLD.`continuation_state`
  OR (
    OLD.`continuation_state` = 'clean-pending'
    AND NEW.`continuation_state` = 'clean-started'
  )
  OR (
    OLD.`continuation_state` IN ('clean-started', 'native-resumed', 'resume-failed')
    AND NEW.`continuation_state` = 'resume-pending'
  )
  OR (
    OLD.`continuation_state` = 'resume-pending'
    AND NEW.`continuation_state` IN ('native-resumed', 'resume-failed')
  )
  OR (
    OLD.`continuation_state` = 'legacy-unavailable'
    AND NEW.`continuation_state` = 'legacy-unavailable'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid orchestrator continuation transition');
END;
--> statement-breakpoint

CREATE TRIGGER `orch_sessions_native_identity_bind_once_guard`
BEFORE UPDATE OF `native_session_id`, `native_identity_state`
ON `orchestrator_sessions`
WHEN NOT (
  (
    OLD.`native_identity_state` = 'unbound'
    AND (
      (
        NEW.`native_identity_state` = 'unbound'
        AND NEW.`native_session_id` IS NULL
      )
      OR (
        NEW.`native_identity_state` = 'bound'
        AND trim(COALESCE(NEW.`native_session_id`, '')) <> ''
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
  SELECT RAISE(ABORT, 'orchestrator native session identity may bind only once');
END;
