-- N6 MCP manager reliability: enabled flag + explicit health bookkeeping on the
-- server registry, and an explicit per-server consumer attachment table.

ALTER TABLE `mcp_servers` ADD COLUMN `enabled` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `health_state` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `health_reason` text;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `last_probe_at` integer;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `last_ok_probe_at` integer;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `tool_count` integer;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `last_error` text;
--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD COLUMN `consecutive_failures` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `mcp_consumer_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `mcp_server_id` text NOT NULL,
  `consumer` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_consumer_attachments_server_idx` ON `mcp_consumer_attachments` (`mcp_server_id`);
--> statement-breakpoint
CREATE INDEX `mcp_consumer_attachments_consumer_idx` ON `mcp_consumer_attachments` (`consumer`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_consumer_attachments_unique_idx` ON `mcp_consumer_attachments` (`mcp_server_id`,`consumer`);
