-- pc-sdk-15: optional per-attachment MCP tool allowlist. Null (every
-- existing row) preserves current behavior — every discovered tool of an
-- attached server is bridged. A non-null JSON array of bare tool names
-- restricts the bridge to their intersection with what the server actually
-- discovers.

ALTER TABLE `mcp_consumer_attachments` ADD `tool_filter` text;
