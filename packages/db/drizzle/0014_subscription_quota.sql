-- RS-004: durable provider-neutral subscription-quota current state.
-- live_outbox remains a prunable delivery buffer; it is never quota truth.

CREATE TABLE `subscription_quota` (
  `id` text PRIMARY KEY NOT NULL
    CHECK (
      length(`id`) = 26
      AND instr(`id`, char(0)) = 0
      AND substr(`id`, 1, 1) GLOB '[0-7]'
      AND `id` NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
    ),
  `runtime_id` text NOT NULL
    CHECK (
      length(`runtime_id`) BETWEEN 1 AND 200
      AND instr(`runtime_id`, char(0)) = 0
      AND `runtime_id` NOT GLOB '*[^ -~]*'
      AND substr(`runtime_id`, 1, 1) <> ' '
      AND substr(`runtime_id`, -1, 1) <> ' '
    ),
  `account_id` text NOT NULL
    CHECK (
      length(`account_id`) BETWEEN 1 AND 200
      AND instr(`account_id`, char(0)) = 0
      AND `account_id` NOT GLOB '*[^ -~]*'
      AND substr(`account_id`, 1, 1) <> ' '
      AND substr(`account_id`, -1, 1) <> ' '
    ),
  `revision` integer NOT NULL
    CHECK (`revision` BETWEEN 1 AND 9007199254740991),
  `availability` text NOT NULL
    CHECK (`availability` IN ('available', 'unavailable')),
  `unavailable_reason` text
    CHECK (`unavailable_reason` IS NULL OR `unavailable_reason` IN (
      'unsupported', 'not-applicable', 'account-unavailable',
      'runtime-unavailable', 'invalid-observation', 'observation-timeout'
    )),
  `observed_at` integer NOT NULL
    CHECK (`observed_at` BETWEEN 0 AND 9007199254740991),
  `snapshot_json` text NOT NULL
    CHECK (json_valid(`snapshot_json`) = 1)
    CHECK (json_type(`snapshot_json`) IS 'object')
    CHECK (json_type(`snapshot_json`, '$.id') IS 'text' AND json_extract(`snapshot_json`, '$.id') = `id`)
    CHECK (json_type(`snapshot_json`, '$.runtimeId') IS 'text' AND json_extract(`snapshot_json`, '$.runtimeId') = `runtime_id`)
    CHECK (json_type(`snapshot_json`, '$.accountId') IS 'text' AND json_extract(`snapshot_json`, '$.accountId') = `account_id`)
    CHECK (json_type(`snapshot_json`, '$.revision') IS 'integer' AND json_extract(`snapshot_json`, '$.revision') = `revision`)
    CHECK (json_type(`snapshot_json`, '$.availability') IS 'text' AND json_extract(`snapshot_json`, '$.availability') = `availability`)
    CHECK (json_type(`snapshot_json`, '$.observedAt') IS 'integer' AND json_extract(`snapshot_json`, '$.observedAt') = `observed_at`)
    CHECK (json_type(`snapshot_json`, '$.observations') IS 'array')
    CHECK (
      (`availability` = 'available' AND `unavailable_reason` IS NULL AND json_type(`snapshot_json`, '$.unavailableReason') IS 'null')
      OR
      (`availability` = 'unavailable' AND `unavailable_reason` IS NOT NULL
        AND json_type(`snapshot_json`, '$.unavailableReason') IS 'text'
        AND json_extract(`snapshot_json`, '$.unavailableReason') = `unavailable_reason`)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_quota_runtime_account_idx`
  ON `subscription_quota` (`runtime_id`, `account_id`);
--> statement-breakpoint

-- A view centralizes the exact nested JSON predicate so inserts and updates
-- are guarded identically. Any row visible here is invalid canonical state.
CREATE VIEW `subscription_quota_invalid` AS
SELECT q.`id`
FROM `subscription_quota` AS q
WHERE
  (SELECT count(*) FROM json_each(q.`snapshot_json`)) <> 8
  OR json_array_length(q.`snapshot_json`, '$.observations') > 64
  OR EXISTS (
    SELECT 1 FROM json_each(q.`snapshot_json`) AS field
    WHERE field.key NOT IN (
      'id', 'runtimeId', 'accountId', 'revision', 'availability',
      'unavailableReason', 'observedAt', 'observations'
    )
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(q.`snapshot_json`, '$.observations') AS item
    WHERE
      json_type(item.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(item.value)) <> 9
      OR EXISTS (
        SELECT 1 FROM json_each(item.value) AS field
        WHERE field.key NOT IN (
          'window', 'scope', 'source', 'usedFraction', 'confidence',
          'limitState', 'resetsAt', 'observedAt', 'staleAt'
        )
      )
      OR json_type(item.value, '$.window') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(item.value, '$.window')) <> 3
      OR EXISTS (
        SELECT 1 FROM json_each(item.value, '$.window') AS field
        WHERE field.key NOT IN ('id', 'label', 'durationMs')
      )
      OR json_type(item.value, '$.window.id') IS NOT 'text'
      OR length(json_extract(item.value, '$.window.id')) NOT BETWEEN 1 AND 200
      OR instr(json_extract(item.value, '$.window.id'), char(0)) <> 0
      OR json_extract(item.value, '$.window.id') GLOB '*[^ -~]*'
      OR substr(json_extract(item.value, '$.window.id'), 1, 1) = ' '
      OR substr(json_extract(item.value, '$.window.id'), -1, 1) = ' '
      OR json_type(item.value, '$.window.label') IS NOT 'text'
      OR length(json_extract(item.value, '$.window.label')) NOT BETWEEN 1 AND 100
      OR instr(json_extract(item.value, '$.window.label'), char(0)) <> 0
      OR json_extract(item.value, '$.window.label') GLOB '*[^ -~]*'
      OR substr(json_extract(item.value, '$.window.label'), 1, 1) = ' '
      OR substr(json_extract(item.value, '$.window.label'), -1, 1) = ' '
      OR NOT (
        json_type(item.value, '$.window.durationMs') IS 'null'
        OR (
          json_type(item.value, '$.window.durationMs') IS 'integer'
          AND json_extract(item.value, '$.window.durationMs') BETWEEN 1 AND 9007199254740991
        )
      )
      OR json_type(item.value, '$.scope') IS NOT 'object'
      OR json_type(item.value, '$.scope.kind') IS NOT 'text'
      OR json_extract(item.value, '$.scope.kind') NOT IN ('account', 'model')
      OR NOT (
        (
          json_extract(item.value, '$.scope.kind') = 'account'
          AND (SELECT count(*) FROM json_each(item.value, '$.scope')) = 1
        )
        OR (
          json_extract(item.value, '$.scope.kind') = 'model'
          AND (SELECT count(*) FROM json_each(item.value, '$.scope')) = 2
          AND NOT EXISTS (
            SELECT 1 FROM json_each(item.value, '$.scope') AS field
            WHERE field.key NOT IN ('kind', 'model')
          )
          AND json_type(item.value, '$.scope.model') IS 'text'
          AND length(json_extract(item.value, '$.scope.model')) BETWEEN 1 AND 100
          AND instr(json_extract(item.value, '$.scope.model'), char(0)) = 0
          AND json_extract(item.value, '$.scope.model') NOT GLOB '*[^ -~]*'
          AND substr(json_extract(item.value, '$.scope.model'), 1, 1) <> ' '
          AND substr(json_extract(item.value, '$.scope.model'), -1, 1) <> ' '
        )
      )
      OR json_type(item.value, '$.source') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(item.value, '$.source')) <> 2
      OR EXISTS (
        SELECT 1 FROM json_each(item.value, '$.source') AS field
        WHERE field.key NOT IN ('semantics', 'fraction')
      )
      OR json_type(item.value, '$.source.semantics') IS NOT 'text'
      OR json_extract(item.value, '$.source.semantics') NOT IN ('used', 'remaining')
      OR json_type(item.value, '$.source.fraction') IS NULL
      OR json_type(item.value, '$.source.fraction') NOT IN ('integer', 'real')
      OR CAST(json_extract(item.value, '$.source.fraction') AS REAL) NOT BETWEEN 0.0 AND 1.0
      OR json_type(item.value, '$.usedFraction') IS NULL
      OR json_type(item.value, '$.usedFraction') NOT IN ('integer', 'real')
      OR CAST(json_extract(item.value, '$.usedFraction') AS REAL) NOT BETWEEN 0.0 AND 1.0
      OR CAST(json_extract(item.value, '$.usedFraction') AS REAL) <> CASE
        json_extract(item.value, '$.source.semantics')
        WHEN 'used' THEN CAST(json_extract(item.value, '$.source.fraction') AS REAL)
        ELSE 1.0 - CAST(json_extract(item.value, '$.source.fraction') AS REAL)
      END
      OR json_type(item.value, '$.confidence') IS NOT 'text'
      OR json_extract(item.value, '$.confidence') NOT IN ('exact', 'derived', 'approximate')
      OR (
        json_extract(item.value, '$.source.semantics') = 'remaining'
        AND json_extract(item.value, '$.confidence') = 'exact'
      )
      OR (
        json_extract(item.value, '$.source.semantics') = 'used'
        AND json_extract(item.value, '$.confidence') = 'derived'
      )
      OR json_type(item.value, '$.limitState') IS NOT 'text'
      OR json_extract(item.value, '$.limitState') NOT IN ('allowed', 'warning', 'rejected', 'unknown')
      OR NOT (
        json_type(item.value, '$.resetsAt') IS 'null'
        OR (
          json_type(item.value, '$.resetsAt') IS 'integer'
          AND json_extract(item.value, '$.resetsAt') BETWEEN 0 AND 9007199254740991
        )
      )
      OR json_type(item.value, '$.observedAt') IS NOT 'integer'
      OR json_extract(item.value, '$.observedAt') NOT BETWEEN 0 AND 9007199254740991
      OR json_extract(item.value, '$.observedAt') > q.`observed_at`
      OR json_type(item.value, '$.staleAt') IS NOT 'integer'
      OR json_extract(item.value, '$.staleAt') NOT BETWEEN 0 AND 9007199254740991
      OR json_extract(item.value, '$.staleAt') <> CASE
        WHEN json_type(item.value, '$.resetsAt') IS 'integer'
          AND json_extract(item.value, '$.resetsAt') < json_extract(item.value, '$.observedAt')
          THEN json_extract(item.value, '$.observedAt')
        WHEN json_type(item.value, '$.resetsAt') IS 'integer'
          AND json_extract(item.value, '$.resetsAt') < CASE
            WHEN json_extract(item.value, '$.observedAt') > 9007199254140991
              THEN 9007199254740991
            ELSE json_extract(item.value, '$.observedAt') + 600000
          END
          THEN json_extract(item.value, '$.resetsAt')
        ELSE CASE
          WHEN json_extract(item.value, '$.observedAt') > 9007199254140991
            THEN 9007199254740991
          ELSE json_extract(item.value, '$.observedAt') + 600000
        END
      END
  )
  OR (
    SELECT count(*) FROM json_each(q.`snapshot_json`, '$.observations')
  ) <> (
    SELECT count(DISTINCT json_extract(item.value, '$.window.id'))
    FROM json_each(q.`snapshot_json`, '$.observations') AS item
  );
--> statement-breakpoint

CREATE TRIGGER `subscription_quota_snapshot_insert_guard`
AFTER INSERT ON `subscription_quota`
WHEN EXISTS (
  SELECT 1 FROM `subscription_quota_invalid` AS invalid
  WHERE invalid.`id` = NEW.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid subscription quota snapshot');
END;
--> statement-breakpoint

CREATE TRIGGER `subscription_quota_identity_revision_insert_guard`
BEFORE INSERT ON `subscription_quota`
WHEN
  NEW.`revision` <> 1
  OR NEW.`observed_at` > CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1000
BEGIN
  SELECT RAISE(ABORT, 'invalid subscription quota insert');
END;
--> statement-breakpoint

CREATE TRIGGER `subscription_quota_identity_revision_update_guard`
BEFORE UPDATE ON `subscription_quota`
WHEN
  NEW.`id` <> OLD.`id`
  OR NEW.`runtime_id` <> OLD.`runtime_id`
  OR NEW.`account_id` <> OLD.`account_id`
  OR NEW.`revision` <> OLD.`revision` + 1
  OR NEW.`observed_at` < OLD.`observed_at`
  OR NEW.`observed_at` > CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1000
BEGIN
  SELECT RAISE(ABORT, 'invalid subscription quota update');
END;
--> statement-breakpoint

CREATE TRIGGER `subscription_quota_snapshot_update_guard`
AFTER UPDATE ON `subscription_quota`
WHEN EXISTS (
  SELECT 1 FROM `subscription_quota_invalid` AS invalid
  WHERE invalid.`id` = NEW.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid subscription quota snapshot');
END;
--> statement-breakpoint

-- There is no quota deletion transition in RS-004. Silent removal would reset
-- durable identity/revision without a tombstone and strand live projections.
CREATE TRIGGER `subscription_quota_delete_guard`
BEFORE DELETE ON `subscription_quota`
BEGIN
  SELECT RAISE(ABORT, 'subscription quota deletion is unsupported');
END;
--> statement-breakpoint

-- The old payload is Claude-shaped and lacks runtime/source/confidence/stale
-- evidence. Quarantine it rather than infer a canonical observation.
DELETE FROM `live_outbox` WHERE `entity` = 'usage';
