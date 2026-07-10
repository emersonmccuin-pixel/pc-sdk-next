CREATE TABLE `agent_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`change_set_id` text,
	`actor` text NOT NULL,
	`field` text NOT NULL,
	`field_ref` text,
	`prior_value` text,
	`new_value` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_audit_agent_idx` ON `agent_audit` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_audit_change_set_idx` ON `agent_audit` (`change_set_id`);--> statement-breakpoint
CREATE TABLE `agent_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`pm_ref` text,
	`agent_run_id` text,
	`pod_name` text,
	`expected_output` text,
	`acceptance_criteria` text,
	`verification_tier` text,
	`verification_status` text,
	`verification_notes` text,
	`report` text,
	`deliverable` text,
	`worktree_path` text,
	`worktree_base_branch` text,
	`worktree_base_sha` text,
	`landing_status` text,
	`landed_branch` text,
	`landed_sha` text,
	`landing_error` text,
	`landed_at` integer,
	`status` text DEFAULT 'issued' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_contracts_project_idx` ON `agent_contracts` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_contracts_run_idx` ON `agent_contracts` (`agent_run_id`);--> statement-breakpoint
CREATE TABLE `agent_mcp_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`enabled_tools` text DEFAULT '*' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_mcp_attachments_agent_idx` ON `agent_mcp_attachments` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mcp_attachments_unique_idx` ON `agent_mcp_attachments` (`agent_id`,`mcp_server_id`);--> statement-breakpoint
CREATE TABLE `agent_projects` (
	`agent_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `project_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_projects_project_idx` ON `agent_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`dispatcher_session_id` text NOT NULL,
	`cc_session_id` text NOT NULL,
	`pod_name` text NOT NULL,
	`pod_revision_at_dispatch` text,
	`pod_revision_at_resume` text,
	`status` text NOT NULL,
	`continues` text,
	`parent_invoke_depth` integer DEFAULT 0 NOT NULL,
	`pm_ref` text,
	`contract_id` text,
	`input` text,
	`result` text,
	`failure_cause` text,
	`failure_reason` text,
	`queued_at` integer NOT NULL,
	`spawned_at` integer,
	`ready_at` integer,
	`pid` integer,
	`last_activity_at` integer,
	`delivered_at` integer,
	`completed_at` integer,
	`rev` integer DEFAULT 0 NOT NULL,
	`worktree_dir` text,
	`worktree_base_branch` text,
	`worktree_base_sha` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_session_queued_idx` ON `agent_runs` (`dispatcher_session_id`,`queued_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_continues_idx` ON `agent_runs` (`continues`);--> statement-breakpoint
CREATE INDEX `agent_runs_project_status_idx` ON `agent_runs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_runs_cc_session_idx` ON `agent_runs` (`cc_session_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_contract_idx` ON `agent_runs` (`contract_id`);--> statement-breakpoint
CREATE TABLE `agent_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`env_var_name` text NOT NULL,
	`value_plaintext` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_secrets_agent_idx` ON `agent_secrets` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_secrets_scope_project_idx` ON `agent_secrets` (`scope`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_secrets_env_idx` ON `agent_secrets` (`agent_id`,`env_var_name`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`prompt` text DEFAULT '' NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`model` text,
	`effort` text,
	`max_turns` integer,
	`description` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'user-created' NOT NULL,
	`shareable` integer DEFAULT false NOT NULL,
	`dispatch_guidance` text,
	`expected_output` text,
	`rev` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_global_name_idx` ON `agents` (`name`) WHERE scope = 'global' AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_project_name_idx` ON `agents` (`project_id`,`name`) WHERE scope = 'project' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `agents_scope_project_idx` ON `agents` (`scope`,`project_id`);--> statement-breakpoint
CREATE TABLE `context_doc_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_id` text NOT NULL,
	`agent_run_id` text,
	`session_kind` text NOT NULL,
	`read_via` text NOT NULL,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_doc_reads_doc_idx` ON `context_doc_reads` (`doc_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `context_doc_reads_run_idx` ON `context_doc_reads` (`agent_run_id`);--> statement-breakpoint
CREATE TABLE `context_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`agent_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `context_docs_project_idx` ON `context_docs` (`project_id`);--> statement-breakpoint
CREATE INDEX `context_docs_agent_idx` ON `context_docs` (`agent_id`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text,
	`event` text NOT NULL,
	`sdk_uuid` text,
	`client_message_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_events_session_seq_idx` ON `conversation_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`owner_server_id` text,
	`kind` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`auth_state` text DEFAULT 'none' NOT NULL,
	`last_error` text,
	`expires_at` integer,
	`rev` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credentials_owner_server_idx` ON `credentials` (`owner_server_id`);--> statement-breakpoint
CREATE INDEX `credentials_owner_scope_idx` ON `credentials` (`owner_scope`);--> statement-breakpoint
CREATE TABLE `live_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`version` integer,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_outbox_id_idx` ON `live_outbox` (`id`);--> statement-breakpoint
CREATE INDEX `live_outbox_created_idx` ON `live_outbox` (`created_at`);--> statement-breakpoint
CREATE INDEX `live_outbox_project_seq_idx` ON `live_outbox` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `live_outbox_scope_seq_idx` ON `live_outbox` (`scope`,`seq`);--> statement-breakpoint
CREATE INDEX `live_outbox_type_seq_idx` ON `live_outbox` (`type`,`seq`);--> statement-breakpoint
CREATE INDEX `live_outbox_entity_idx` ON `live_outbox` (`entity`,`entity_id`,`seq`);--> statement-breakpoint
CREATE TABLE `mailbox_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`recipient_id` text,
	`delivery_id` text,
	`action` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_audit_message_idx` ON `mailbox_audit` (`message_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mailbox_audit_delivery_idx` ON `mailbox_audit` (`delivery_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mailbox_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`recipient_id` text,
	`delivery_id` text,
	`reason` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_dead_letters_message_idx` ON `mailbox_dead_letters` (`message_id`);--> statement-breakpoint
CREATE TABLE `mailbox_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`target_ref_kind` text,
	`target_ref_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer,
	`failed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_status_idx` ON `mailbox_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_recipient_idx` ON `mailbox_deliveries` (`recipient_id`,`status`);--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_target_idx` ON `mailbox_deliveries` (`target_ref_kind`,`target_ref_id`);--> statement-breakpoint
CREATE TABLE `mailbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_messages_idempotency_idx` ON `mailbox_messages` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `mailbox_messages_project_idx` ON `mailbox_messages` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mailbox_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`address_kind` text NOT NULL,
	`address_json` text NOT NULL,
	`read_at` integer,
	`actioned_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_recipients_message_idx` ON `mailbox_recipients` (`address_kind`,`message_id`);--> statement-breakpoint
CREATE INDEX `mailbox_recipients_unread_idx` ON `mailbox_recipients` (`address_kind`,`read_at`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`transport` text NOT NULL,
	`discovered_tools` text,
	`discovery_status` text DEFAULT 'stale' NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_servers_scope_project_idx` ON `mcp_servers` (`scope`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_global_name_idx` ON `mcp_servers` (`name`) WHERE scope = 'global' AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_project_name_idx` ON `mcp_servers` (`project_id`,`name`) WHERE scope = 'project' AND deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `orchestrator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`model` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`ended_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orch_sessions_active_per_project_idx` ON `orchestrator_sessions` (`project_id`) WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `pending_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`cc_session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`pm_ref` text,
	`kind` text NOT NULL,
	`prompt_body` text NOT NULL,
	`context` text,
	`options` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_body` text,
	`answered_by` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_asks_project_status_idx` ON `pending_asks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `pending_asks_agent_run_idx` ON `pending_asks` (`agent_run_id`);--> statement-breakpoint
CREATE INDEX `pending_asks_cc_session_idx` ON `pending_asks` (`cc_session_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`folder_path` text DEFAULT '' NOT NULL,
	`git_remote` text,
	`position` integer DEFAULT 0 NOT NULL,
	`callsign_seq` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`focused_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_idx` ON `projects` (`slug`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `projects_position_idx` ON `projects` (`position`);--> statement-breakpoint
CREATE TABLE `settings_global` (
	`id` text PRIMARY KEY NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_name_active_idx` ON `worktrees` (`name`) WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_active_idx` ON `worktrees` (`path`) WHERE status = 'active';