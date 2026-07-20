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

/** File-based delivery door for tool-bridge-less runtimes. An adapter whose
 *  `appToolBridge` is 'unsupported' (e.g. Codex) mints with zero pc_* tools, so
 *  it can never call pc_submit_deliverable. Instead it writes this file at its
 *  worktree root as its final act; the dispatch service reads it, validates it
 *  through the SAME `DispatchService.submitDeliverable` path as the tool, and
 *  removes it before the sealed commit so the landed tree never contains it. */
export const DELIVERABLE_FILE_NAME = '.pc-deliverable.json';

/** Marshal a parsed deliverable file into the `{ deliverable, report }` submit
 *  payload — mirrors pc_submit_deliverable's own marshalling (packages/mcp
 *  tools/agent-runs.ts): a top-level string `kind` merged into the deliverable
 *  object, an optional string `report`. This only SHAPES the input; the schema
 *  validation itself is not forked — it stays the canonical
 *  `DispatchService.submitDeliverable` path the tool also posts through. */
export function shapeDeliverableFileContents(parsed: unknown):
  | { ok: true; deliverable: Record<string, unknown>; report: string | null }
  | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'deliverable file must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind.trim() : '';
  if (!kind) return { ok: false, reason: 'deliverable file is missing a string `kind`' };
  const inner =
    obj.deliverable && typeof obj.deliverable === 'object' && !Array.isArray(obj.deliverable)
      ? (obj.deliverable as Record<string, unknown>)
      : {};
  const report = typeof obj.report === 'string' ? obj.report : null;
  return { ok: true, deliverable: { ...inner, kind }, report };
}

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
