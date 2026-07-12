// Slice 016 — ONE canonical pc-rig tool registry.
//
// THE single ordered source of truth for every pc-rig tool view. ListTools
// (`TOOLS` in @pc/mcp), `PC_RIG_TOOL_NAMES`, the `TOOL_CATALOG` pc-rig partition,
// and `CAPABILITIES` ALL DERIVE from this array, in this order. Adding a tool is
// ONE edit here (+ one handler in @pc/mcp's PC_RIG_HANDLERS); the slice-016
// parity test fails the build if the two halves drift.
//
// WIRE-FROZEN: `name`, `inputSchema` (the MCP input schema, relocated VERBATIM
// from the per-tool `*_TOOL` consts), and `description` (agent-facing, fed to
// ListTools) are the agent wire — do not mutate. Order IS the ListTools order.
//
// Two descriptions are preserved per tool because they differ for every tool
// today (agent-facing vs UI/prompt — slice-016 verified 0/52 byte-identical):
//   - `description`        -> agent-facing, consumed by `TOOLS`/ListTools.
//   - `catalogDescription` -> UI/prompt copy, consumed by `descriptionOf` via the
//                             derived `TOOL_CATALOG` entry.
//
// @pc/domain MUST stay browser-safe — this file is plain data only (no node:/
// SDK/HTTP imports). inputSchema is a plain JSON-Schema object.

/** The contract family a tool's internals route through. `none` = no
 *  apps/server HTTP round-trip whose response a contract covers. */
export type CapabilityFamily =
  | 'project'
  | 'agent'
  | 'agent-run'
  | 'none';

/** A plain-data JSON-Schema object (the MCP tool input schema). */
export type JsonSchemaObject = Record<string, unknown>;

/** One pc-rig tool's full agent-facing definition + UI metadata. */
export interface PcRigToolDef {
  /** Bare tool name (e.g. `pc_create_work_item`). */
  name: string;
  /** Contract family for routing/lookup. */
  family: CapabilityFamily;
  /** Friendly UI label (TOOL_CATALOG label). */
  label: string;
  /** Agent-facing description — consumed by `TOOLS`/ListTools. */
  description: string;
  /** UI/prompt description — consumed by `descriptionOf` via TOOL_CATALOG. */
  catalogDescription: string;
  /** MCP input schema (relocated verbatim from the per-tool `*_TOOL` const). */
  inputSchema: JsonSchemaObject;
}

/** The ONE canonical registry, in canonical ListTools order. */
export const PC_RIG_TOOL_REGISTRY: readonly PcRigToolDef[] = [
  {
    "name": "pc_create_agent",
    "family": "agent",
    "label": "Create an agent pod",
    "description": "Create a NEW agent pod (DB-resident). Returns the new pod row with its ULID id. Defaults to scope='project' (pod is owned by the current project — set via PC_PROJECT_ID). Pass scope='global' only when the user explicitly says this agent should be reusable across every project. Use this for fresh agent design — the user said 'build me an agent that does X'. For structural design from scratch you should usually dispatch agent-designer first (pc_invoke_agent name='agent-designer') so the design conversation happens in its specialised pod; call pc_create_agent directly only for trivial extractors / utilities or when continuing a design conversation. Stock-pod names (orchestrator/researcher/writer/code-writer/reviewer/planner/extractor/agent-designer) are reserved — 400 if name collides with a global. Broadcasts pod-changed on success.",
    "catalogDescription": "Author a new agent pod row (use for fresh-design flows).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "lowercase kebab-case agent name (letters/numbers/dashes)"
        },
        "scope": {
          "type": "string",
          "enum": [
            "project",
            "global"
          ],
          "description": "scope. Default 'project' — pod is owned by the current project. Use 'global' only when the user explicitly wants the pod reusable across every project."
        },
        "prompt": {
          "type": "string",
          "description": "the agent's system prompt body (markdown)"
        },
        "description": {
          "type": "string",
          "description": "one-line description for the dispatch picker"
        },
        "model": {
          "type": "string",
          "description": "model slug (e.g. 'opus' / 'sonnet' / 'haiku')"
        },
        "effort": {
          "type": "string",
          "description": "reasoning effort: low / medium / high / xhigh / max"
        },
        "maxTurns": {
          "type": "integer",
          "description": "optional cap on the number of conversation turns"
        },
        "tools": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "allowlist of tool slugs (e.g. ['Read','Grep','mcp__pc-rig__pc_get_work_item']). Empty = inherit all."
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "pc_get_agent",
    "family": "agent",
    "label": "Read an agent's config",
    "description": "Fetch the full pod bundle for an agent: prompt + attached context docs + secret env-var names (NEVER values) + MCP servers + scalar settings. Use when you need to read an agent's current configuration before recommending a change, answering 'what does <agent> know about X?', or auditing a pod's setup. Accepts either { id } (ULID) or { name } (resolved to id via list lookup).",
    "catalogDescription": "Fetch a pod bundle: prompt + attached docs + secrets + MCP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with name)"
        },
        "name": {
          "type": "string",
          "description": "pod name (looked up if id absent)"
        }
      }
    }
  },
  {
    "name": "pc_update_agent",
    "family": "agent",
    "label": "Update an agent",
    "description": "Update an agent pod's prompt and/or scalar settings in one call. Pass only the fields you want to change — any of: `prompt` (system prompt body), `newName` (rename, kebab-case), `description`, `model`, `effort`, `maxTurns`, `tools` (full allowlist). At least one mutating field is required. Audits as actor='orchestrator'; multi-field updates audit under a shared change-set. Stock-pod prompts (orchestrator/researcher/...) are editable — be deliberate; danger-zone editing in the UI is gated for a reason. Triggers restart-on-edit for any live session. Accepts either { id } or { name }.",
    "catalogDescription": "Edit a pod's prompt, model, tools, effort, or name.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with name)"
        },
        "name": {
          "type": "string",
          "description": "pod name (looked up if id absent)"
        },
        "prompt": {
          "type": "string",
          "description": "new system prompt body (markdown)"
        },
        "newName": {
          "type": "string",
          "description": "rename (lowercase kebab-case)"
        },
        "description": {
          "type": "string",
          "description": "new one-line description"
        },
        "model": {
          "type": "string"
        },
        "effort": {
          "type": "string",
          "description": "low / medium / high / xhigh / max"
        },
        "maxTurns": {
          "type": "integer"
        },
        "tools": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      }
    }
  },
  {
    "name": "pc_delete_agent",
    "family": "agent",
    "label": "Delete an agent pod",
    "description": "Soft-delete an agent pod. Stock pods (orchestrator/researcher/writer/code-writer/reviewer/planner/extractor/agent-designer) are NOT deletable — returns 409. The pod can be restored via the History tab. Audits as actor='orchestrator'. Accepts either { id } or { name }.",
    "catalogDescription": "Soft-delete a non-stock pod.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with name)"
        },
        "name": {
          "type": "string",
          "description": "pod name (looked up if id absent)"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      }
    }
  },
  {
    "name": "pc_promote_agent_to_global",
    "family": "agent",
    "label": "Promote a project pod to global",
    "description": "Promote a project-scoped pod to global so every project can use it. Returns 400 if the pod is already global; 409 if a global pod with the same name exists. Audits as actor='orchestrator'. Accepts either { id } or { name }.",
    "catalogDescription": "Make a project pod available to all projects.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with name)"
        },
        "name": {
          "type": "string",
          "description": "pod name (looked up if id absent)"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      }
    }
  },
  {
    "name": "pc_reset_agent_to_default",
    "family": "agent",
    "label": "Reset a stock pod to its default",
    "description": "Reset a STOCK pod's scalar fields (prompt, description, model, tools, …) to the canonical seed content. Attached context docs, secrets, and MCP servers are untouched. Non-stock pods return 400. Audits as actor='orchestrator'. Accepts either { id } or { name }.",
    "catalogDescription": "Restore a stock pod's seeded content.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with name)"
        },
        "name": {
          "type": "string",
          "description": "pod name (looked up if id absent)"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      }
    }
  },
  {
    "name": "pc_create_agent_secret",
    "family": "agent",
    "label": "Add an agent secret",
    "description": "Attach a plaintext env-var secret to an agent. The value is stored in plain text in v1 (encryption lands in v2) — the user has been warned via the UI banner. Pod gets `envVarName=value` materialised into its environment at spawn. Use for things like API keys / tokens needed by per-pod MCP servers. Audits event-only (value never logged). Accepts either { agentId } or { agentName }.",
    "catalogDescription": "Attach an env-var secret to an agent (plaintext v1).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentId": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with agentName)"
        },
        "agentName": {
          "type": "string",
          "description": "pod name (looked up if agentId absent)"
        },
        "envVarName": {
          "type": "string",
          "description": "environment variable name (e.g. GMAIL_TOKEN)"
        },
        "valuePlaintext": {
          "type": "string",
          "description": "secret value (stored plaintext in v1)"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      },
      "required": [
        "envVarName",
        "valuePlaintext"
      ]
    }
  },
  {
    "name": "pc_delete_agent_secret",
    "family": "agent",
    "label": "Remove an agent secret",
    "description": "Detach a secret env-var from an agent. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { secretId }.",
    "catalogDescription": "Detach a secret env var from an agent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentId": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with agentName)"
        },
        "agentName": {
          "type": "string",
          "description": "pod name (looked up if agentId absent)"
        },
        "secretId": {
          "type": "string",
          "description": "secret ULID id"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      },
      "required": [
        "secretId"
      ]
    }
  },
  {
    "name": "pc_add_agent_mcp_server",
    "family": "agent",
    "label": "Configure an agent's MCP server",
    "description": "Attach an MCP server that is already registered in the MCP registry to a pod, choosing which of its tools the pod may call. Register the server first (App/Project settings → MCP Servers, or the /api/mcp-servers HTTP route); this grants the pod access by the server's id and takes effect on the pod's next session. Accepts either { agentId } or { agentName } plus { mcpServerId }.",
    "catalogDescription": "Attach a registered MCP server to a pod (per-tool grants).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentId": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with agentName)"
        },
        "agentName": {
          "type": "string",
          "description": "pod name (looked up if agentId absent)"
        },
        "mcpServerId": {
          "type": "string",
          "description": "ULID id of a server already registered in the MCP registry"
        },
        "enabledTools": {
          "description": "which of the server's tools to grant: \"*\" for all (default), or an array of tool names"
        }
      },
      "required": [
        "mcpServerId"
      ]
    }
  },
  {
    "name": "pc_delete_agent_mcp_server",
    "family": "agent",
    "label": "Remove an agent's MCP server",
    "description": "Detach a per-pod MCP server. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { mcpServerId }.",
    "catalogDescription": "Detach a per-pod MCP server config.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentId": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with agentName)"
        },
        "agentName": {
          "type": "string",
          "description": "pod name (looked up if agentId absent)"
        },
        "mcpServerId": {
          "type": "string",
          "description": "MCP server row ULID id"
        },
        "reason": {
          "type": "string",
          "description": "optional one-line audit reason"
        }
      },
      "required": [
        "mcpServerId"
      ]
    }
  },
  {
    "name": "pc_list_agent_audit",
    "family": "agent",
    "label": "Read an agent's change history",
    "description": "Read an agent's change history. Returns audit rows newest-first. Filter by actor ('orchestrator' / 'user'), field ('prompt' / 'model' / 'effort' / 'tools' / 'description' / 'name' / 'maxTurns' / 'context-doc' / 'knowledge' [legacy rows] / 'secret' / 'mcp-server'), limit (default 50), beforeCreatedAt (epoch ms — for paging). Use when reasoning about 'why does this agent behave this way?' or auditing recent changes. Accepts either { agentId } or { agentName }.",
    "catalogDescription": "Inspect a pod's audit log (who changed what, when).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentId": {
          "type": "string",
          "description": "pod ULID id (mutually exclusive with agentName)"
        },
        "agentName": {
          "type": "string",
          "description": "pod name (looked up if agentId absent)"
        },
        "actor": {
          "type": "string",
          "description": "filter by actor ('orchestrator' / 'user')"
        },
        "field": {
          "type": "string",
          "description": "filter by audit field key"
        },
        "limit": {
          "type": "integer",
          "description": "max rows returned (default 50)"
        },
        "beforeCreatedAt": {
          "type": "integer",
          "description": "page boundary (epoch ms); rows older than this"
        }
      }
    }
  },
  {
    "name": "pc_write_claude_md",
    "family": "project",
    "label": "Write project's CLAUDE.md",
    "description": "Write the project-level CLAUDE.md from the conversational setup wizard (5.6 / D82). Overwrites the existing file. Use this as the SINGLE tool call at the end of the wizard interview, once the user confirms the preview. `content` is the full markdown body (the server does not interpolate). 400 if content is missing or empty. Broadcasts project-claude-md-changed on success so the modal can close.",
    "catalogDescription": "Author or replace the project's CLAUDE.md.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "full CLAUDE.md markdown body (non-empty)"
        }
      },
      "required": [
        "content"
      ]
    }
  },
  {
    "name": "pc_list_stages",
    "family": "project",
    "label": "List project stages",
    "description": "List the project's stages live from the server. Use this BEFORE writing any stage id into a workflow step's `move` field or a work-item create/move. Returns { ok: true, stages: [{ id, name, order, isDone?, isCancelled?, isNew? }, ...] }. Always use the stage `id`, never the name. Use `isDone` / `isCancelled` / `isNew` for semantic stage roles instead of guessing from labels. No arguments; PC_PROJECT_ID env is the implicit scope.",
    "catalogDescription": "List the project's stages by id + label.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_list_projects",
    "family": "project",
    "label": "List all projects",
    "description": "List every project in this Caisson workspace (id, slug, name, stages). The cross-project read for the Command planner: call this first to discover project handles, then pass each id, slug, or name as targetProjectId to pc_list_work_items / pc_list_areas / pc_get_work_item / pc_search_work_items / pc_list_context / pc_get_context_doc / pc_search to see that project's work. Returns { projects: [{ id, slug, name, stages, ... }, ...] }. No arguments.",
    "catalogDescription": "List every project in the workspace (ids, slugs, stages).",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_list_waiting_on_you",
    "family": "project",
    "label": "List everything waiting on you",
    "description": "Cross-project read: returns everything across ALL projects that is blocked on the human's input right now — paused agents waiting for an answer (pending asks), workflow runs paused at a human-review gate, and actionable inbox items (verification-review, workflow-review, agent-ask-escalated). Grouped by project with counts. No arguments. Use this at the start of a Command session to surface the full picture of 'what needs you today' before diving into individual projects. Returns { ok, totalCount, byProject: [{ projectId, projectName, projectSlug, pendingAsks: [{ askId, agentRunId, kind, promptBody, context, options, createdAt }], workflowReviews: [{ runId, workflowName, nodeId, workItemId }], inboxItems: [{ recipientId, messageId, kind, subject, payload, createdAt }] }] }.",
    "catalogDescription": "Enumerate everything across ALL projects blocked on the human's input (paused agents, workflow review gates, inbox items).",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_board_health",
    "family": "project",
    "label": "Board health / stall report",
    "description": "Surface stalled work items — open items in a non-terminal stage with no agent-run, contract, or field activity for N days (default 7). Returns: `stalledItems` (id, callsign, title, stageId, ageInStageDays, lastActivityAt) sorted oldest-first, plus `rollup` counts (totalOpen, totalStalled). Use as a periodic PM check-in: call it before a planning session to spot forgotten work that needs attention or reassignment. `idle_days` is optional (default 7). Read-only; no writes.",
    "catalogDescription": "Find open cards with no activity for N days (default 7) — the board health / stall signal.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "idle_days": {
          "type": "number",
          "description": "how many days of inactivity before an item is considered stalled (default 7)"
        }
      }
    }
  },
  {
    "name": "pc_list_agents",
    "family": "agent",
    "label": "List available agents",
    "description": "List available agents for this project. Returns global pods plus project overrides/project-only pods. Use before pc_invoke_agent when deciding which specialist to delegate to.",
    "catalogDescription": "List every pod the project can dispatch.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_node_failed",
    "family": "none",
    "label": "Signal node failure",
    "description": "Signal a hard failure from a workflow agent node. Call this when you cannot produce the contracted output (bad input, missing files, unrecoverable error). The v2 subagent spawner detects this call from the JSONL transcript and closes the node as `agent-self-failed` carrying your reason. After calling, end your turn normally — do NOT call this from ad-hoc (non-workflow) dispatch. Schema: { workflowRunId, nodeId, reason }.",
    "catalogDescription": "Signal a hard failure from a workflow agent node so the spawner closes it as agent-self-failed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "workflowRunId": {
          "type": "string",
          "description": "the workflow run id from the dispatch tokens"
        },
        "nodeId": {
          "type": "string",
          "description": "the node id from the dispatch tokens"
        },
        "reason": {
          "type": "string",
          "description": "one-line human-readable reason surfaced in the UI"
        }
      },
      "required": [
        "workflowRunId",
        "nodeId",
        "reason"
      ]
    }
  },
  {
    "name": "pc_list_field_schemas",
    "family": "project",
    "label": "List field schemas",
    "description": "List the project's custom work-item field schemas. Use this BEFORE authoring a create-work-item / update-work-item step that sets `fields`, so the keys are real (not invented). Returns { ok: true, schemas: [{ key, label, type, options?, required, ... }, ...] }. The `key` is what goes into the step's `fields` object. No arguments; PC_PROJECT_ID env is the implicit scope.",
    "catalogDescription": "List the project's per-stage card field schemas.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_replace_stages",
    "family": "project",
    "label": "Replace project stages",
    "description": "Bulk-replace a project's stages. The server validates uniqueness, flag constraints, and in-use stage safety. When a removed stage still has work items, the server returns 409 STAGE_HAS_ITEMS with an `orphans` array — surface this to the caller instead of swallowing. Pass `force: true` + `fallbackStageId` (a retained stage id) to force-remove and reassign orphaned items. Always call `pc_request_approval` before removing, reordering, or re-flagging stages.",
    "catalogDescription": "Replace the project's stage definitions in bulk (destructive — use with caution).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stages": {
          "type": "array",
          "description": "full replacement stage list. Each stage needs id + name; order defaults to array index.",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "stage slug id (e.g. \"backlog\")"
              },
              "name": {
                "type": "string",
                "description": "display name"
              },
              "order": {
                "type": "number",
                "description": "sort order (defaults to array index)"
              },
              "isDone": {
                "type": "boolean",
                "description": "marks the terminal-success stage (at most one)"
              },
              "isCancelled": {
                "type": "boolean",
                "description": "marks the terminal-abandon stage (at most one)"
              },
              "isNew": {
                "type": "boolean",
                "description": "marks the intake/new stage (at most one)"
              }
            },
            "required": [
              "id",
              "name"
            ]
          }
        },
        "force": {
          "type": "boolean",
          "description": "force removal of stages that still have items. Requires fallbackStageId."
        },
        "fallbackStageId": {
          "type": "string",
          "description": "stage id to reassign orphaned items to when force=true."
        }
      },
      "required": [
        "stages"
      ]
    }
  },
  {
    "name": "pc_replace_field_schemas",
    "family": "project",
    "label": "Replace field schemas",
    "description": "Bulk-replace a project's custom work-item field schemas. PUT /api/projects/:projectId/field-schemas. Returns { ok: true, items: [...] }. Call pc_list_field_schemas first to read current state before replacing. Always call pc_request_approval before replacing schemas.",
    "catalogDescription": "Replace the project's custom work-item field schemas in bulk.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "description": "full replacement field schema list. Each item: { key, label, type, options?, required? }.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "name": "pc_invoke_agent",
    "family": "agent-run",
    "label": "Dispatch another agent",
    "description": "Dispatch a named specialist agent (kebab-case, e.g. \"researcher\") in this project. Every dispatch CREATES A CONTRACT — the machine-checkable assignment with a typed expected output and derived acceptance criteria the deliverable is verified against. Always async — returns `{ ok, runId, agentName, status }` immediately; the terminal `[agent-completed]` / `[agent-failed]` envelope (result + verification verdict) arrives as a message on a later turn. Author the dispatch's output via `expected_output` (defaults to the pod's stored/stock default). A pod with no default is REJECTED without an explicit `expected_output` (422) — an empty contract that checks nothing is never minted. `kind: 'repo'` dispatches run in an isolated git worktree; once verified they park merge-ready for YOUR review (pc_review_contract accept lands them) unless the spec sets `auto_land: true`. For high-risk / cross-cutting / security-sensitive work set `review: 'full'` instead: PC-SDK dispatches an independent review specialist against the sealed commit — approve lands automatically, reject opens a bounded Fix cycle (you only get pulled in when rounds are exhausted). Optional `pmRef` records the external PM item (AInativePM) this work belongs to.",
    "catalogDescription": "Dispatch a specialist — creates a verified contract; repo work runs isolated and lands after review (or auto_land).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "pod name (kebab-case)"
        },
        "input": {
          "type": "string",
          "description": "the agent's first user message — the task. State what you want done, the constraints, and any file paths or context it needs; the agent cannot see your conversation."
        },
        "pmRef": {
          "type": "string",
          "description": "optional external PM-item ref (AInativePM id/URL) recorded on the contract for traceability"
        },
        "expected_output": {
          "type": "object",
          "description": "contract-first output spec authored directly onto the dispatch's contract. `{ kind }` is one of answer | prose | payload | repo | external | binary | action. Optional ONLY for stock pods that carry a default (researcher, writer, code-writer, reviewer, planner, extractor, …); a pod with no stored/stock default is REJECTED without it. A bare `{ kind: 'answer' }` with no min_chars escalates to orchestrator review unless you set `trust_end_turn: true`. For `repo`, add `checks` (e.g. [\"typecheck\",\"test\"]) so verification runs them in the worktree; `auto_land: true` opts into auto-merge, `review: 'full'` requests the independent review phase (wins over auto_land).",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "answer",
                "prose",
                "payload",
                "repo",
                "external",
                "binary",
                "action"
              ],
              "description": "output family this contract verifies against; required when expected_output is supplied"
            }
          },
          "required": [
            "kind"
          ]
        }
      },
      "required": [
        "name",
        "input"
      ]
    }
  },
  {
    "name": "pc_continue_agent",
    "family": "agent-run",
    "label": "Continue an agent run",
    "description": "Resume a recent terminal agent run (`completed` or `failed`) with a follow-up input — the prior conversation is preserved (SDK session resume) so phrase your input as a continuation, not a fresh ask. The continuation carries the parent run's contract forward: the same expected output + acceptance criteria still apply, and the deliverable must still be submitted via pc_submit_deliverable. Cancelled runs cannot be continued; start a fresh dispatch. Single-active-continuation guard per parent (409 on concurrent). Returns the same shape as `pc_invoke_agent`.",
    "catalogDescription": "Resume a terminal AgentRun with a follow-up input (carries the contract forward).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "runId": {
          "type": "string",
          "description": "ULID of the prior AgentRun to continue"
        },
        "input": {
          "type": "string",
          "description": "free-form follow-up — becomes the next user message in the resumed conversation. Phrase as a continuation, not a fresh request."
        }
      },
      "required": [
        "runId",
        "input"
      ]
    }
  },
  {
    "name": "pc_list_my_runs",
    "family": "agent-run",
    "label": "List my agent runs",
    "description": "List recent agent runs YOU dispatched in this project (scoped to caller's `pc_session_id`). Use when you've lost track of a runId and need to pick one to continue via `pc_continue_agent`. Filters: `agentName`, `status`, `limit` (default 20, max 100). Newest-first. Row shape: `{ runId, agentName, status, dispatchedAt, completedAt, summary, continues }`.",
    "catalogDescription": "List recent agent runs YOU dispatched (scoped to caller's session).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "agentName": {
          "type": "string",
          "description": "optional — filter by pod name (kebab-case)"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "spawning",
            "running",
            "paused",
            "completed",
            "failed",
            "cancelled"
          ],
          "description": "optional — filter by persisted status (full state machine)."
        },
        "limit": {
          "type": "number",
          "description": "optional — cap on returned rows. Default 20, max 100."
        }
      },
      "required": []
    }
  },
  {
    "name": "pc_inspect_agent_run",
    "family": "agent-run",
    "label": "Inspect an agent run",
    "description": "Peek at a single agent run: current status, OS pid + whether that process is still alive, how long since its last activity (idleMs), and the last thing it did (last JSONL action). Use this to tell a working run from a wedged one before deciding to wait or kill. Returns `{ ok, inspection: { runId, status, pid, processAlive, lastActivityAt, idleMs, lastAction, ... } }`. Read-only.",
    "catalogDescription": "Peek a run: status, pid liveness, idle age, last action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "runId": {
          "type": "string",
          "description": "ULID of the agent run to inspect"
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "name": "pc_kill_agent_run",
    "family": "agent-run",
    "label": "Kill an agent run",
    "description": "Force-end an agent run NOW: kills the real OS process (its persisted pid + child tree) AND finalizes the run row to `cancelled` with full effects (rail + dispatcher notify). Unlike a graceful cancel this works on a PHANTOM — a run wedged or whose in-memory handle was lost. Idempotent: an already-terminal run returns ok without re-killing. Use when `pc_inspect_agent_run` shows a run stuck with no activity. Returns `{ ok, status, alreadyTerminal, processKilled }`.",
    "catalogDescription": "Force-end a run — kills the OS process + finalizes the row (works on phantoms).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "runId": {
          "type": "string",
          "description": "ULID of the agent run to force-kill"
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "name": "pc_ask_orchestrator",
    "family": "agent-run",
    "label": "Ask the orchestrator",
    "description": "THE ask door (FD-6): pause your run and ask the orchestrator a question. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the answer arrives as the next user message when your session resumes via --resume. After calling, do not call any other tools and end your turn naturally. The orchestrator answers from project context, or takes the question to the human and relays — if only the human can decide (taste, priority, factual call you can't verify), SAY SO in the question. Multi-choice `options` array supported. Requires `PC_AGENT_RUN_ID` + `PC_DISPATCHER_SESSION_ID` in env (set by the spawn path).",
    "catalogDescription": "Pause and ask the orchestrator a question (it answers or relays to the human).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "the question to ask. If only the human can decide, say so explicitly."
        },
        "context": {
          "type": "string",
          "description": "optional context — recent transcript snippet, files inspected, candidate options"
        },
        "options": {
          "type": "array",
          "description": "optional multi-choice options ([{value, label}, ...]). When supplied, the answerer sees them as a numbered list; the reply will be one of the option values.",
          "items": {
            "type": "object",
            "properties": {
              "value": {
                "type": "string",
                "description": "machine value returned as the answer"
              },
              "label": {
                "type": "string",
                "description": "user-facing label for this choice"
              }
            },
            "required": [
              "value",
              "label"
            ]
          }
        }
      },
      "required": [
        "question"
      ]
    }
  },
  {
    "name": "pc_request_approval",
    "family": "agent-run",
    "label": "Request approval",
    "description": "Pause your run and request explicit human approval for a decision. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the user's decision arrives as the next user message when your session resumes. Use this when proceeding requires explicit go/no-go (destructive operations, irreversible writes). `options` is required and must be non-empty.",
    "catalogDescription": "Pause and request explicit approval before proceeding.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "decision": {
          "type": "string",
          "description": "the decision the user is being asked to approve — what will happen, in plain English"
        },
        "options": {
          "type": "array",
          "description": "non-empty list of approval choices ([{value, label}, ...])",
          "items": {
            "type": "object",
            "properties": {
              "value": {
                "type": "string",
                "description": "machine value returned as the answer"
              },
              "label": {
                "type": "string",
                "description": "user-facing label for this choice"
              }
            },
            "required": [
              "value",
              "label"
            ]
          }
        },
        "context": {
          "type": "string",
          "description": "optional context — what produced this decision, alternatives, what the user should weigh"
        }
      },
      "required": [
        "decision",
        "options"
      ]
    }
  },
  {
    "name": "pc_answer_pending",
    "family": "agent-run",
    "label": "Answer a pending ask",
    "description": "Resume a paused agent with an answer. Atomic open→answered flip. Idempotent: a second call returns `cause: \"already-answered\"`. Resume uses the run's immutable specialist snapshot, runtime selection, and positively bound native continuation evidence; later roster edits cannot rewrite it. Orchestrator usage only — agents that need to forward an answer should use pc_ask_orchestrator instead.",
    "catalogDescription": "Reply to an earlier ask-orchestrator / ask-user / approval.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pendingAskId": {
          "type": "string",
          "description": "pending-ask ULID from the agent-asks-* event"
        },
        "answer": {
          "type": "string",
          "description": "the answer to thread back into the paused agent"
        },
        "answeredBy": {
          "type": "string",
          "enum": [
            "orchestrator",
            "user"
          ],
          "description": "\"orchestrator\" when answered from your own context, \"user\" when forwarding the user's reply"
        }
      },
      "required": [
        "pendingAskId",
        "answer",
        "answeredBy"
      ]
    }
  },
  {
    "name": "pc_submit_deliverable",
    "family": "agent-run",
    "label": "Submit your deliverable",
    "description": "Submit the typed deliverable for YOUR contract — the authoritative output your dispatch is verified against. Call this ONCE, as your final action, before you end your turn; it REPLACES the old \"end your turn and we scrape your transcript / work-item body\" model. The `kind` MUST match your contract's expected output: `answer` → { text } (a direct answer / report); `prose` → { text } or { attachmentId } or { ref } (a written document); `payload` → { data } (structured JSON matching your schema); `repo` → { branch?, commit?, diffStat?, prUrl? } (code you wrote; server overwrites branch/commit from git and stamps baseBranch/baseCommit from the dispatch receipt); `external` → { system, handle, idempotencyKey, url? } (an external side-effect you performed, e.g. an email sent); `binary` → { attachmentId, mime, bytes }; `action` → { tool, count } (a tool you were required to call). Optional `report` is free-text to the orchestrator that accompanies the deliverable. Requires PC_AGENT_RUN_ID (set on every dispatched agent). Returns { ok, contractId, status: 'submitted' }.",
    "catalogDescription": "Submit the typed deliverable for your contract (the verified output source).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "answer",
            "prose",
            "payload",
            "repo",
            "external",
            "binary",
            "action"
          ],
          "description": "deliverable kind — must match the contract's expected output kind"
        },
        "deliverable": {
          "type": "object",
          "description": "the typed deliverable payload (shape depends on kind). The server merges `kind` in, so you may omit it here. answer:{text}; prose:{text|attachmentId|ref}; payload:{data}; repo:{branch?,commit?,diffStat?,prUrl?} with branch/commit/baseBranch/baseCommit stamped by the server; external:{system,handle,idempotencyKey,url?}; binary:{attachmentId,mime,bytes}; action:{tool,count}.",
          "additionalProperties": true
        },
        "report": {
          "type": "string",
          "description": "optional free-text report to the orchestrator accompanying the deliverable"
        }
      },
      "required": [
        "kind"
      ]
    }
  },
  {
    "name": "pc_find_tool",
    "family": "none",
    "label": "Find a tool",
    "description": "Search the full Caisson tool catalog by keyword when none of your granted tools fits the job. Returns up to 5 matches with each tool's tier: a tool you already hold (call it directly), an on-demand tool (call it via pc_call_tool — the match includes its input schema), or a worker-side tool (flows INTO you from dispatched agents; not callable from your seat). Use this for rare diagnostic/config work — reading a workflow definition, checking an agent's audit trail, inspecting attached docs — instead of guessing tool names.",
    "catalogDescription": "Search the full tool catalog for a tool you don't carry day-to-day.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "keywords describing what you need, e.g. \"read workflow definition\" or \"agent audit history\""
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "pc_call_tool",
    "family": "none",
    "label": "Call an on-demand tool",
    "description": "Execute an on-demand catalog tool discovered via pc_find_tool. `name` is the bare tool name (e.g. pc_get_workflow); `args` is that tool's input object per the schema pc_find_tool returned. ONLY on-demand tier tools are callable — tools you already hold are called directly, and worker-side tools are refused. Calls route through the exact same server paths and audit logs as the specialist surfaces; nothing happens invisibly. DEFAULT TO SPECIALISTS for substantive authoring (agent-designer, workflow-builder) — reach through this door when the user asked you to inspect or fix something directly, or you are debugging. CAUTION: editing a workflow definition while one of its runs is in flight has undefined interaction — finish or kill the run first, or warn the user.",
    "catalogDescription": "Run a catalog tool found with Find a tool (on-demand tier only; audited).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "bare on-demand tool name from pc_find_tool, e.g. pc_get_workflow"
        },
        "args": {
          "type": "object",
          "description": "the input object for that tool, matching its schema",
          "additionalProperties": true
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "pc_get_contract",
    "family": "agent-run",
    "label": "Read your contract",
    "description": "Read YOUR OWN contract mid-run: the expected output spec, the ACCEPTANCE CRITERIA your deliverable will be verified against (so you can self-check BEFORE submitting), the verification tier, your contract status, and the linked work item id. Call this whenever you need to re-check what 'done' means — the dispatch prompt inlines the spec once, but this is the live source. Requires PC_AGENT_RUN_ID (set on every dispatched agent); takes no arguments. Returns { ok, contract: { id, status, workItemId, expectedOutput, acceptanceCriteria, verificationTier, attempt, deliverable, report } }.",
    "catalogDescription": "Worker-side: a dispatched agent reads its own contract + acceptance criteria.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "pc_get_deliverable",
    "family": "agent-run",
    "label": "Read a contract's deliverable",
    "description": "Read the authoritative deliverable for any contract — the typed output the agent submitted and the verifier reads. `id` is a contract id (ULID) OR the linked work item's ULID / callsign (e.g. pc-2.1). Returns { ok, deliverable, report, status, expectedOutput }; `deliverable` is null when the agent hasn't submitted yet. Project-guarded: only reads contracts in the caller's project. Requires PC_SESSION_ID (orchestrator session); does NOT need PC_AGENT_RUN_ID. Use this before calling pc_resolve_work_item to read what the agent actually produced. This is the symmetric read of the same Contract.deliverable the worker submits via pc_submit_deliverable.",
    "catalogDescription": "Read a contract's typed deliverable + report (orchestrator read door; symmetric to pc_submit_deliverable).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "contract id (ULID) or the linked work item's ULID / callsign (e.g. pc-2.1)"
        }
      },
      "required": ["id"]
    }
  },
  {
    "name": "pc_review_contract",
    "family": "agent-run",
    "label": "Review a contract",
    "description": "Record YOUR verdict on a contract parked for review (verification status 'pending' with tier 'orchestrator-review', or an escalated empty-criteria contract). Read the deliverable first (pc_get_deliverable), judge it against the expected output, then accept or reject. Accepting a passed repo contract triggers landing (merge into the base branch). Rejecting records your notes as the verification failure — re-dispatch (pc_invoke_agent) or continue the run (pc_continue_agent) to get it fixed. Returns { ok, contract: { id, status, verificationStatus, landingStatus } }.",
    "catalogDescription": "Accept or reject a contract parked for orchestrator review (accept ⇒ land for repo work).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "contractId": {
          "type": "string",
          "description": "contract id (ULID) — from the review envelope or pc_get_deliverable"
        },
        "verdict": {
          "type": "string",
          "enum": ["accept", "reject"],
          "description": "accept = deliverable meets the contract; reject = it does not (say why in notes)"
        },
        "notes": {
          "type": "string",
          "description": "optional reviewer notes — REQUIRED in practice for reject (what failed, what to fix)"
        }
      },
      "required": ["contractId", "verdict"]
    }
  },
];

/** FD-16 — every registry tool's tier. `first-order` = meant to be carried in
 *  a pod's everyday allowlist; `on-demand` = reachable only through
 *  pc_find_tool → pc_call_tool (diagnostic/config surface; audited);
 *  `worker` = dispatched-agent-side (flows INTO the orchestrator — never
 *  callable through the door). Kept as ONE map (not a per-entry field) so the
 *  wire-frozen entries above stay untouched; the registry guard test asserts
 *  this map and the registry cover exactly the same names. */
export type PcRigToolTier = 'first-order' | 'on-demand' | 'worker';

export const PC_RIG_TOOL_TIERS: Readonly<Record<string, PcRigToolTier>> = {
  // Work items / dispatch / comms / orientation — the everyday surface.
  pc_invoke_agent: 'first-order',
  pc_continue_agent: 'first-order',
  pc_list_my_runs: 'first-order',
  pc_inspect_agent_run: 'first-order',
  pc_kill_agent_run: 'first-order',
  pc_answer_pending: 'first-order',
  pc_list_agents: 'first-order',
  pc_list_stages: 'first-order',
  pc_list_projects: 'first-order',
  pc_list_waiting_on_you: 'first-order',
  pc_board_health: 'first-order',
  pc_list_field_schemas: 'first-order',
  // Slice 1 — context-doc tools. pc_list_context + pc_get_context_doc + pc_search
  // are first-order for both orchestrator and agents. pc_add/update_context_doc
  // are orchestrator-held (enforced at the pod allowlist level, not the tier).
  // Migration 0055 — delete door for any scope (replaced pc_delete_knowledge).
  pc_find_tool: 'first-order',
  pc_call_tool: 'first-order',
  // Agent config + secrets + audit — specialist/UI-owned defaults. (The old
  // knowledge tools merged into the context-doc family — migration 0055.)
  pc_create_agent: 'on-demand',
  pc_get_agent: 'on-demand',
  pc_update_agent: 'on-demand',
  pc_delete_agent: 'on-demand',
  // Agent-mgmt toolkit audit (2026-06-04) — the three UI-only pod lifecycle
  // doors gained tools (FD: complete agent-management toolkit).
  pc_promote_agent_to_global: 'on-demand',
  pc_reset_agent_to_default: 'on-demand',
  pc_create_agent_secret: 'on-demand',
  pc_delete_agent_secret: 'on-demand',
  pc_add_agent_mcp_server: 'on-demand',
  pc_delete_agent_mcp_server: 'on-demand',
  pc_list_agent_audit: 'on-demand',
  // Workflow authoring — workflow-builder-owned default.
  // M3a — the run-diary read (FD-11 debugging; reach it via pc_call_tool).
  // M6 slice C — FD-11 lifecycle: cancel-for-real + the repair-loop resume.
  // Project structure config.
  pc_replace_stages: 'on-demand',
  pc_replace_field_schemas: 'on-demand',
  pc_write_claude_md: 'on-demand',
  // Slice 4 — orchestrator read door for the contract deliverable.
  pc_get_deliverable: 'first-order',
  // Phase 3 — tier-2 sign-off door (accept ⇒ land / reject with notes).
  pc_review_contract: 'first-order',
  // Worker-side — these flow INTO the orchestrator from dispatched agents.
  pc_ask_orchestrator: 'worker',
  // ☠ M7 (FD-6, 2026-06-04) — `pc_ask_user` deleted: ONE ask door. Agents ask
  // the orchestrator; it answers from context or takes it to the human in chat.
  pc_request_approval: 'worker',
  pc_node_failed: 'worker',
  pc_submit_deliverable: 'worker',
  // M5 (FD-5 addendum + dispatch-payload audit) — the agent can READ ITS JOB:
  // its own contract (incl. acceptance criteria) + the attachments the
  // dispatch prompt points it at (previously directed to use what no tool
  // could fetch).
  pc_get_contract: 'worker',
  // A4 — deterministic next-action picker (Command planner / orchestrator surface).
  // pc-pty-chat-434 — agent dossier (Track B).
  // pc-pty-chat-438 — investigation type + synthesis fold-up.
};

/** Bare tool names in registry (= ListTools) order. */
export const PC_RIG_TOOL_REGISTRY_NAMES: readonly string[] = PC_RIG_TOOL_REGISTRY.map(
  (d) => d.name,
);
