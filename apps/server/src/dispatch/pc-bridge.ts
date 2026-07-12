// PC-rig tool bridge — binds a subset of PC_RIG_TOOL_REGISTRY to a caller
// identity (orchestrator session or dispatched agent run) as plain
// BridgeToolDefs the runtime adapters compile into their native tool surface.
//
// One door: every handler round-trips over localhost HTTP to this server's
// routes (`@pc/mcp/tools` handlers), exactly like an out-of-process MCP client
// would — identity comes from the bound ToolContext, not ambient state.

import { PC_RIG_TOOL_REGISTRY } from '@pc/domain/tool-registry';
import { createToolContext, dispatchPcRigTool } from '@pc/mcp/tools';
import { jsonSchemaToZodShape, type BridgeBuild, type BridgeToolDef } from '../mcp/bridge.ts';

/** Orchestrator-side dispatch surface (tier `first-order`, dispatch family). */
export const ORCHESTRATOR_PC_TOOLS = [
  'pc_invoke_agent',
  'pc_continue_agent',
  'pc_list_my_runs',
  'pc_inspect_agent_run',
  'pc_kill_agent_run',
  'pc_answer_pending',
  'pc_get_deliverable',
  'pc_review_contract',
  'pc_list_agents',
] as const;

/** Worker-side surface (tier `worker`) — flows INTO the orchestrator. */
export const AGENT_PC_TOOLS = [
  'pc_get_contract',
  'pc_submit_deliverable',
  'pc_ask_orchestrator',
  'pc_request_approval',
] as const;

export interface PcToolIdentity {
  projectId: string;
  /** Orchestrator app-session id (or the dispatcher's for a child agent). */
  dispatcherSessionId: string;
  /** Set only for dispatched agents. */
  agentRunId?: string;
  invokeDepth?: number;
  /** This server's live HTTP port (handlers loop back over localhost). */
  serverPort: number;
}

export function buildPcToolDefs(
  names: readonly string[],
  identity: PcToolIdentity,
): BridgeToolDef[] {
  const ctx = createToolContext({
    projectId: identity.projectId,
    sessionId: identity.dispatcherSessionId,
    dispatcherSessionId: identity.dispatcherSessionId,
    agentRunId: identity.agentRunId ?? '',
    agentParentWorkItemId: '',
    agentInvokeDepth: identity.invokeDepth ?? 0,
    serverPort: identity.serverPort,
  });
  const defs: BridgeToolDef[] = [];
  for (const name of names) {
    const def = PC_RIG_TOOL_REGISTRY.find((d) => d.name === name);
    if (!def) throw new Error(`pc-bridge: unknown registry tool ${name}`);
    defs.push({
      name: def.name,
      description: def.description,
      inputSchema: jsonSchemaToZodShape(def.inputSchema),
      handler: async (args) => {
        const result = await dispatchPcRigTool(def.name, args ?? {}, ctx);
        return {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    });
  }
  return defs;
}

/** Union extra tool defs into a bridge build (same server key ⇒ one native
 *  MCP server). PC names (`pc_*`) can't collide with `<slug>__<tool>` names. */
export function mergePcTools(base: BridgeBuild | undefined, extra: BridgeToolDef[]): BridgeBuild {
  const serverKey = base?.serverKey ?? 'pc';
  const toolDefs = [...(base?.toolDefs ?? []), ...extra];
  return {
    serverKey,
    toolDefs,
    allowedToolNames: toolDefs.map((d) => `mcp__${serverKey}__${d.name}`),
  };
}
