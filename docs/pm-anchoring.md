# PM anchoring — scope

Goal: a PC-SDK project knows which AInativePM project it belongs to, so every PM action in chat lands in the right place without saying "in project X" each time.

## What AInativePM already gives us (no PM-side work needed)

1. **Folder binding** — `get_started(cwd)` auto-resolves a registered folder to its PM project; `register_folder` creates the binding. Server-side, survives everything.
2. **Token-per-project PATs** — a token can carry a default PM project; every tool call on that token defaults there. Strongest isolation, but per-project tokens = per-project MCP attachments (Phase 4 manager territory).
3. **`project_id` on every tool** — explicit override always works.

## Design: anchor = a project setting + two enforcement layers

**Store:** `projects.settings.pmAnchor = { pmProjectId, pmProjectName, anchoredAt }` (null = unanchored). Rides the existing `project` resource event (signal-only refetch) — no new wire types.

**Layer 1 — prompt injection (primary):** when a session starts for an anchored project, the orchestrator system prompt gains one line: `PM project: <name> (<id>). Default every AInativePM tool call to this project_id.` Cheap, visible, works today.

**Layer 2 — folder binding (backstop):** at anchor time the server calls AInativePM `register_folder(project.folderPath → pmProjectId)` through the MCP client. Then *anything* running in that folder (specialists in worktrees excepted — their cwd differs; layer 1 covers them) resolves the same project even without the prompt line.

**UX:** Project Settings panel gets an "Anchor to PM project" row: a picker listing PM projects (server fetches via the existing MCP client → AInativePM list-projects tool), pick one → saved + folder registered → row shows the anchored name with a re-anchor/unanchor control. PM down ⇒ picker shows the degraded state, existing anchor keeps working (prompt injection needs no live PM).

## Phasing

- **v1 (small, next build slot):** settings field + HTTP route + picker UI + prompt injection + `register_folder` call. ~1 agent-day.
- **v2 (Phase 3 dispatch):** dispatched specialists inherit the anchor — `contract.pmRef` defaults to the anchored project; verification/landing receipts can reference PM items under it.
- **v3 (Phase 4 manager):** optional per-project PAT (token-per-project) as an MCP attachment policy — real isolation instead of convention, managed in the MCP manager UI.

## Rules

- Anchor is a default, never a cage — explicit `project_id` in chat always wins.
- Degrade, never block: PM unreachable ⇒ anchoring UI shows it; chat unaffected.
- One source of truth: the setting. The folder binding is derived; re-anchor re-registers.
