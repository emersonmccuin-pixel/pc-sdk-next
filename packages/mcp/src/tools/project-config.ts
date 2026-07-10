import type { ToolContext, ToolResult } from './context.ts';

// Slice 016 — the per-tool *_TOOL consts (name + description + inputSchema)
// were relocated VERBATIM into @pc/domain PC_RIG_TOOL_REGISTRY (the single
// canonical pc-rig tool metadata source). This file now owns only the
// executable handler (localhost-HTTP dispatch).

interface McpStage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

interface ProjectStagesResponse {
  stages?: McpStage[];
}

function stageForMcp(s: McpStage): {
  id: string;
  name: string;
  order: number;
  isDone?: true;
  isCancelled?: true;
  isNew?: true;
} {
  return {
    id: s.id,
    name: s.name,
    order: s.order,
    ...(s.isDone === true ? { isDone: true } : {}),
    ...(s.isCancelled === true ? { isCancelled: true } : {}),
    ...(s.isNew === true ? { isNew: true } : {}),
  };
}

async function listStages(
  toolName: 'pc_list_stages',
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (!ctx.projectId) throw new Error('PC_PROJECT_ID required');
    // Reads the project doc's `stages` array off the raw localhost GET, then
    // re-projects it into the custom MCP stage shape below.
    const res = await ctx.getServer(`/api/projects/${ctx.projectId}`);
    if (res.status >= 200 && res.status < 300) {
      try {
        const project = JSON.parse(res.body) as ProjectStagesResponse;
        const stages = (project.stages ?? []).map(stageForMcp);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stages }) }] };
      } catch {
        return {
          content: [
            { type: 'text', text: `${toolName} parse error: ${res.body.slice(0, 200)}` },
          ],
          isError: true,
        };
      }
    }
    return {
      content: [{ type: 'text', text: `${toolName} failed (${res.status}): ${res.body}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${toolName} failed: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

export async function handleProjectConfigTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_write_claude_md': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_write_claude_md: content required (non-empty)' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.putServer(ctx.projectPath('claude-md'), { content });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_stages':
      return listStages('pc_list_stages', ctx);

    case 'pc_list_projects': {
      // Cross-project read: every project in the workspace, so the planner can
      // then pull each one's work by id.
      try {
        const res = await ctx.getServer('/api/projects');
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_projects failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_projects failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_field_schemas': {
      try {
        const res = await ctx.getServer(ctx.projectPath('field-schemas'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
