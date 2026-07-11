CREATE TABLE `conversation_events_cf001` (
  `event_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL,
  `sequence` integer NOT NULL CHECK (`sequence` > 0),
  `family` text NOT NULL,
  `event_type` text NOT NULL,
  `turn_id` text,
  `item_id` text NOT NULL,
  `stream_id` text,
  `delta_index` integer CHECK (`delta_index` IS NULL OR (`delta_index` >= 0 AND `stream_id` IS NOT NULL)),
  `payload` text NOT NULL,
  `client_message_id` text,
  `occurred_at` integer NOT NULL,
  `projection_state` text DEFAULT 'visible' NOT NULL CHECK (`projection_state` IN ('visible', 'legacy-hidden'))
);
--> statement-breakpoint
CREATE TEMP TABLE `conversation_legacy_stream_map` (
  `native_id` text PRIMARY KEY NOT NULL,
  `canonical_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
INSERT INTO `conversation_legacy_stream_map` (`native_id`, `canonical_id`)
WITH `legacy_ids` (`native_id`, `source_event_id`) AS (
  SELECT `sdk_uuid`, `id`
  FROM `conversation_events`
  WHERE NULLIF(`sdk_uuid`, '') IS NOT NULL
  UNION ALL
  SELECT CAST(`entry`.`value` AS text),
    `legacy`.`id` || ':retract:' || CAST(`entry`.`key` AS text)
  FROM `conversation_events` AS `legacy`,
    json_each(`legacy`.`event`, '$.uuids') AS `entry`
  WHERE `legacy`.`kind` = 'retract'
    AND NULLIF(CAST(`entry`.`value` AS text), '') IS NOT NULL
)
SELECT
  `native_id`,
  'legacy-stream:' || lower(hex(MIN(`source_event_id`)))
FROM `legacy_ids`
GROUP BY `native_id`;
--> statement-breakpoint
INSERT INTO `conversation_events_cf001` (
  `event_id`, `project_id`, `conversation_id`, `session_id`, `sequence`,
  `family`, `event_type`, `turn_id`, `item_id`, `stream_id`, `delta_index`,
  `payload`, `client_message_id`, `occurred_at`, `projection_state`
)
SELECT
  `id`, `project_id`, `session_id`, `session_id`, `seq`,
  CASE
    WHEN `kind` = 'user' THEN 'user'
    WHEN `kind` = 'assistant-text' THEN 'assistant'
    WHEN `kind` = 'thinking' THEN 'activity'
    WHEN `kind` IN ('tool-call', 'tool-result', 'tool-denied') THEN 'tool'
    WHEN `kind` IN ('agent-dispatch', 'agent-envelope', 'sidechain') THEN 'agent'
    WHEN `kind` IN ('usage', 'turn-duration') THEN 'telemetry'
    WHEN `kind` = 'system' THEN 'system'
    ELSE 'control'
  END,
  CASE WHEN `kind` = 'thinking' THEN 'legacy-thinking' ELSE COALESCE(`kind`, 'system') END,
  NULL,
  COALESCE(
    (SELECT `canonical_id` FROM `conversation_legacy_stream_map`
      WHERE `native_id` = `legacy`.`sdk_uuid`),
    `legacy`.`id`
  ),
  (SELECT `canonical_id` FROM `conversation_legacy_stream_map`
    WHERE `native_id` = `legacy`.`sdk_uuid`),
  NULL,
  CASE
    WHEN `kind` = 'thinking' THEN json_set(`event`, '$.kind', 'legacy-thinking')
    WHEN `kind` = 'turn-end' THEN json_set(
      `event`,
      '$.stopReason',
      CASE
        WHEN json_extract(`event`, '$.stopReason') IS NULL THEN NULL
        WHEN json_extract(`event`, '$.stopReason') = 'end_turn' THEN 'complete'
        WHEN json_extract(`event`, '$.stopReason') = 'max_tokens' THEN 'max-output'
        WHEN json_extract(`event`, '$.stopReason') = 'stop_sequence' THEN 'stop-sequence'
        WHEN json_extract(`event`, '$.stopReason') = 'tool_use' THEN 'tool-use'
        ELSE 'other'
      END
    )
    WHEN `kind` = 'retract' THEN json_set(
      json_remove(`event`, '$.uuids'),
      '$.streamIds',
      json((
        SELECT json_group_array(`canonical_id`)
        FROM (
          SELECT `mapping`.`canonical_id`
          FROM json_each(`legacy`.`event`, '$.uuids') AS `entry`
          JOIN `conversation_legacy_stream_map` AS `mapping`
            ON `mapping`.`native_id` = CAST(`entry`.`value` AS text)
          ORDER BY CAST(`entry`.`key` AS integer)
        )
      ))
    )
    ELSE `event`
  END,
  `client_message_id`, `created_at`,
  CASE WHEN `kind` = 'thinking' THEN 'legacy-hidden' ELSE 'visible' END
FROM `conversation_events` AS `legacy`;
--> statement-breakpoint
DROP TABLE `conversation_legacy_stream_map`;
--> statement-breakpoint
DROP TABLE `conversation_events`;
--> statement-breakpoint
ALTER TABLE `conversation_events_cf001` RENAME TO `conversation_events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_conversation_sequence_idx`
  ON `conversation_events` (`conversation_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `conversation_events_session_sequence_idx`
  ON `conversation_events` (`session_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `conversation_events_turn_sequence_idx`
  ON `conversation_events` (`turn_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `conversation_events_item_sequence_idx`
  ON `conversation_events` (`item_id`, `sequence`);
--> statement-breakpoint
CREATE TABLE `conversation_sequences` (
  `conversation_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `next_sequence` integer DEFAULT 1 NOT NULL CHECK (`next_sequence` > 0),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `conversation_sequences` (`conversation_id`, `project_id`, `next_sequence`, `updated_at`)
SELECT `conversation_id`, MIN(`project_id`), MAX(`sequence`) + 1, MAX(`occurred_at`)
FROM `conversation_events`
GROUP BY `conversation_id`;
--> statement-breakpoint
CREATE TABLE `conversation_outbox` (
  `outbox_sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` text NOT NULL REFERENCES `conversation_events` (`event_id`),
  `delivery_kind` text NOT NULL CHECK (`delivery_kind` IN ('chat', 'agent')),
  `created_at` integer NOT NULL,
  `relayed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_outbox_event_idx` ON `conversation_outbox` (`event_id`);
--> statement-breakpoint
CREATE INDEX `conversation_outbox_relay_idx`
  ON `conversation_outbox` (`relayed_at`, `outbox_sequence`);
--> statement-breakpoint
INSERT INTO `conversation_outbox` (`event_id`, `delivery_kind`, `created_at`, `relayed_at`)
SELECT
  e.`event_id`,
  CASE WHEN EXISTS (
    SELECT 1 FROM `orchestrator_sessions` s WHERE s.`id` = e.`session_id`
  ) THEN 'chat' ELSE 'agent' END,
  e.`occurred_at`,
  e.`occurred_at`
FROM `conversation_events` e;
