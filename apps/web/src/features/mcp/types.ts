// MCP manager DTO shapes — mirrors the server's `toDto` projection
// (apps/server/src/http/mcp.ts). Not re-exported from @pc/domain/@pc/contracts
// because it's an HTTP-surface shape (redacted transport, secret presence,
// flattened consumers), not a stored row.

import type {
  CredentialAuthState,
  McpConsumerKey,
  McpHealthState,
  McpServerTransport,
  PodScope,
} from '@pc/domain';

export interface McpServerHealth {
  state: McpHealthState;
  reason: string | null;
  lastProbeAt: number | null;
  lastOkProbeAt: number | null;
  toolCount: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface McpServerSecretInfo {
  present: boolean;
  authState: CredentialAuthState | null;
  expiresAt: number | null;
  expired: boolean;
}

export interface McpServerDto {
  id: string;
  scope: PodScope;
  projectId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  transport: McpServerTransport;
  health: McpServerHealth;
  tools: string[];
  secret: McpServerSecretInfo;
  consumers: McpConsumerKey[];
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** Form-facing transport shape — plain strings only (no SecretRef; those only
 *  ever exist server-side after a secret write). */
export interface McpTransportInput {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  enabled?: boolean;
  transport: McpTransportInput;
}

export type UpdateMcpServerInput = Partial<CreateMcpServerInput>;

export interface PutMcpSecretInput {
  value: string;
  kind?: 'oauth_tokens' | 'provider_tokens' | 'static';
  expiresAt?: number | null;
  headerName?: string;
  envName?: string;
}
