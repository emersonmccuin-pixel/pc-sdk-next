CREATE TABLE `conversation_queue_heads` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `orchestrator_sessions` (`id`),
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `next_position` integer DEFAULT 1 NOT NULL CHECK (`next_position` > 0),
  `queue_revision` integer DEFAULT 0 NOT NULL CHECK (`queue_revision` >= 0),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_queue_items` (
  `id` text PRIMARY KEY NOT NULL,
  `turn_id` text NOT NULL UNIQUE,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `orchestrator_sessions` (`id`),
  `client_message_id` text NOT NULL,
  `origin` text NOT NULL CHECK (`origin` IN ('user', 'agent-envelope')),
  `status` text NOT NULL CHECK (`status` IN ('queued', 'delivering', 'accepted', 'failed', 'cancelled')),
  `enqueue_position` integer NOT NULL CHECK (`enqueue_position` > 0),
  `current_revision` integer NOT NULL CHECK (`current_revision` > 0),
  `delivery_revision` integer CHECK (`delivery_revision` IS NULL OR `delivery_revision` > 0),
  `interrupt_request_id` text,
  `failure_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_queue_items_session_client_idx`
  ON `conversation_queue_items` (`session_id`, `client_message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_queue_items_session_position_idx`
  ON `conversation_queue_items` (`session_id`, `enqueue_position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_queue_items_session_delivering_idx`
  ON `conversation_queue_items` (`session_id`) WHERE `status` = 'delivering';
--> statement-breakpoint
CREATE INDEX `conversation_queue_items_fifo_idx`
  ON `conversation_queue_items` (`session_id`, `status`, `enqueue_position`);
--> statement-breakpoint
CREATE INDEX `conversation_queue_items_interrupt_idx`
  ON `conversation_queue_items` (`interrupt_request_id`);
--> statement-breakpoint
CREATE TABLE `conversation_queue_revisions` (
  `queue_item_id` text NOT NULL REFERENCES `conversation_queue_items` (`id`),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `text` text NOT NULL,
  `agent_envelope` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`queue_item_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `conversation_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `orchestrator_sessions` (`id`),
  `queue_item_id` text NOT NULL REFERENCES `conversation_queue_items` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('active', 'ended')),
  `terminal_event_id` text,
  `terminal_outcome` text CHECK (`terminal_outcome` IS NULL OR `terminal_outcome` IN ('completed', 'turn-failed', 'aborted', 'recovered')),
  `started_at` integer NOT NULL,
  `ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turns_active_session_idx`
  ON `conversation_turns` (`session_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `conversation_turns_queue_item_idx`
  ON `conversation_turns` (`queue_item_id`);
--> statement-breakpoint
CREATE TABLE `turn_interrupt_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `conversation_id` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `orchestrator_sessions` (`id`),
  `target_turn_id` text NOT NULL,
  `replacement_queue_item_id` text,
  `status` text NOT NULL CHECK (`status` IN ('requested', 'confirmed', 'failed')),
  `terminal_event_id` text,
  `result` text CHECK (`result` IS NULL OR `result` IN ('aborted', 'completed', 'turn-failed', 'recovered')),
  `failure_code` text,
  `failure_reason` text,
  `requested_at` integer NOT NULL,
  `settled_at` integer,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_interrupt_requests_target_idx`
  ON `turn_interrupt_requests` (`session_id`, `target_turn_id`, `status`);
--> statement-breakpoint
CREATE INDEX `turn_interrupt_requests_replacement_idx`
  ON `turn_interrupt_requests` (`replacement_queue_item_id`);
--> statement-breakpoint
CREATE TABLE `conversation_commands` (
  `command_id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `session_id` text,
  `command_kind` text NOT NULL CHECK (`command_kind` IN ('send', 'edit-queued-message', 'remove-queued-message', 'interrupt', 'interrupt-and-send')),
  `fingerprint` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('applied', 'rejected')),
  `queue_item_id` text,
  `revision` integer,
  `interrupt_request_id` text,
  `error_code` text,
  `error_message` text,
  `current_revision` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_commands_session_idx`
  ON `conversation_commands` (`session_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_turn_terminal_idx`
  ON `conversation_events` (`turn_id`)
  WHERE `turn_id` IS NOT NULL AND `event_type` IN ('turn-end', 'turn-failed');
