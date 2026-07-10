# Phase 3 — runtime adapters + agent dispatch

Status: CORE LANDED (2026-07-10) — steps 1–2 done and steps 3–4 built at v1
depth, CI-green (canonical runtime contract + ClaudeRuntimeAdapter extracted;
dispatch→contract→verify→review/land + boot recovery + guard tests; landing
defaults to orchestrator review, `auto_land` is the opt-in per
docs/worktree-lifecycle.md). Remaining: the live end-to-end gate; the full
lifecycle state machine / preparation+readiness receipts / landing queue from
the worktree doc (current v1: provision receipt, sealed submit, clean-tree +
base-branch guards, ancestry receipt, per-repo landing lock); Codex adapter
(step 5); selection UI (step 6). The noun layer (contract model, DB tables,
DTOs, tool metadata, run-view UI) was ported in Phase 1. The binding provider
rules live in `docs/agent-runtime-architecture.md`; repository mutation and
landing rules live in `docs/worktree-lifecycle.md`.

## Phase order

Phase 3 has one path, in this order:

1. Generalize Phase 2 `RunnerBackend` vocabulary into the canonical
   `AgentRuntimeAdapter`/`RuntimeSession`/`RuntimeEvent` contract.
2. Extract the current behavior into `ClaudeRuntimeAdapter`; make the existing
   orchestrator pass conformance, streaming, resume, interrupt, ask, smoke, and
   kill-recovery tests unchanged.
3. Build the durable worktree lifecycle and guard tests. No write-capable
   dispatch starts until contract + Git/preparation/readiness receipts exist.
4. Build dispatch → contract → verify → orchestrator-review/auto-land → merge →
   teardown against the canonical runtime/lifecycle contracts, not Claude SDK
   messages or model-generated Git commands.
5. Spike ChatGPT-subscription Codex app-server/SDK and implement
   `CodexRuntimeAdapter` against the same conformance suite.
6. Add runtime-aware account/model/effort selection to specialists, followed by
   project-scoped orchestrator switching with explicit new-session semantics.

Do not add Codex branches to `SessionService`, `DispatchService`, HTTP/WS, DB
services, or the web app. Adapter selection occurs in the runtime registry and
composition root.

## Shape

One new product area: `apps/server/src/dispatch/`. No new PC-SDK host or
supervisor. Provider packages and native event mappings live only in concrete
runtime adapters under `apps/server/src/runner/` (directory naming may be
cleaned up during the one-pass refactor). Specialists and the orchestrator use
the same canonical runtime-session seam. Provider runtime child processes are
adapter-owned implementation details.

PC-SDK owns tool/MCP attachment policy. Claude can receive bound `pc_*` tools
through its in-process SDK MCP server. Codex receives the same policy through
native MCP configuration or a PC-SDK MCP endpoint appropriate to its process
boundary. The core never assumes either delivery mechanism.

PC-SDK also owns worktree preparation, readiness, verification, landing queue,
merge, and teardown. Agents receive a worktree cwd and cannot write the main
project. The orchestrator reviews receipts/diffs and requests lifecycle actions;
it does not execute Git mutations itself.

```
pc_invoke_agent (orchestrator runtime session, app-owned tool policy)
  → POST /api/projects/:id/agents/:name/invoke
  → DispatchService.dispatchFresh
      resolve pod (unknown-agent ⇒ 422)
      resolve spec: inline → pod-row default → stock default (none ⇒ contract-required, NO row)
      create/resolve contract + delivery policy
      repo kind ⇒ provision + prepare + readiness FIRST
                   (row pre-inserted queued; any missing receipt ⇒ no agent starts)
      derive AC + explicit verification/review/landing policy + setRun link
      AgentRunner.start (selected adapter: recorded worktree cwd for repo work;
                         project cwd only for explicitly non-mutating/non-repo work;
                         specialist charter + contract block, model/effort/tools,
                         selected account, agent-side PC tools)
  → run streams: RuntimeEvent → turn-runner mapping → conversation_events(sessionId=runId)
                 + AgentEventFrame broadcast (one render pipeline with chat)
  → agent MUST call pc_submit_deliverable (sole done-signal; repo submits require clean tree)
  → terminal settlement:
      no deliverable on completed ⇒ failed 'no-deliverable'
      verification (tier auto: evaluateAcceptance w/ real executors; fail-closed empty AC;
                    trust_end_turn honored; inconclusive ⇒ pending, never false-fail)
      repo + passed ⇒ orchestrator-review by default OR auto-merge eligibility gate
      approved/eligible ⇒ per-repo landing queue
      land (guarded merge --no-ff into base branch in project copy, receipts
            recorded BEFORE teardown; stale base ⇒ revalidate; conflict/unknown
            ⇒ preserve worktree + durable gate)
      proven merge ⇒ teardown; anything else preserves branch/worktree
      envelope → orchestrator send-queue ("[agent-completed] …" — wakes the next turn)
```

## Decisions

- **Ask/pause**: `pc_ask_orchestrator`/`pc_request_approval` create a `pending_asks`
  row + flip the run `paused` + envelope the orchestrator. The tool result tells the
  agent to end its turn. Resume = `answerAndResume` + a new `sendTurn` on the same
  runtime session (or adapter re-mint with the stamped native session id after a
  restart). Resume must route through the original runtime and account.
- **Landing v1**: merge the agent branch into the base branch **in the project working
  copy** — guarded: clean tree + HEAD still on the base branch, else typed
  `failed`/`conflict` (no push; personal tool, user pushes). All landing enters a
  per-repository mutex/queue. Base advancement since verification forces
  integration/revalidation. Positive receipt: `merge-base --is-ancestor`.
  Record-then-teardown; branch/worktree preserved on every non-proven outcome.
- **Review policy**: orchestrator review is the default and consumes the sealed
  commit diff + contract/verification receipts. Independent reviewer/Fix loops
  are escalation for risk, not a mandatory token cost. Auto-merge is opt-in and
  allowed only when contract policy plus app-derived evidence satisfies every
  predicate in `docs/worktree-lifecycle.md`; missing/inconclusive means review,
  never pass.
- **Provisioning/readiness**: a project worktree profile owns explicit setup,
  readiness checks, allowlisted local inputs/secrets, and cleanup. Git checkout
  alone is not ready. Preparation failure or missing required review tooling is
  typed; auto-merge is disabled when required evidence cannot be produced.
- **Parallelism**: builders may run concurrently in isolated worktrees. Declared
  path overlap is surfaced early; landing is serialized. A queued run validated
  against an older base cannot land until reconciled/revalidated.
- **Tier-2/3**: parked at `verifying`/`pending` + envelope. New tool
  `pc_review_contract` (accept/reject + notes) closes the loop; accept on a repo
  contract triggers landing.
- **Runtime selection**: dispatch resolves runtime/account/model/effort from an
  explicit override, then specialist defaults, then project/runtime defaults.
  The resolved selection is stamped on the run before execution. V1 may ship
  without per-dispatch UI override, but the service contract cannot assume
  Claude or a global model enum.
- **Runtime switching**: changing orchestrator runtime/account/model positively
  ends or interrupts the active turn and creates a new app session. Prior
  sessions retain and resume through their original adapter. Cross-runtime
  context handoff is separate, explicit behavior.
- **Boot recovery**: reconcile DB intent with Git/filesystem evidence per
  `docs/worktree-lifecycle.md`. A vanished mid-phase agent fails loudly and
  preserves work; sealed deliverables may recover to verification/review;
  ambiguous merge inspects ancestry before action; proven merge resumes
  teardown; pending landing is revalidated/requeued; orphan worktrees surface
  as stranded. Never blindly replay a non-idempotent Git mutation.
- **Registry re-prune (dispatch family only)**: work-item args deleted from
  `pc_invoke_agent`/`pc_continue_agent` (pmRef replaces), `pc_review_contract` added.

## Files

- `dispatch/pc-bridge.ts` — PC_RIG_TOOL_REGISTRY subset → BridgeToolDefs bound to a
  ToolContext (orchestrator set / agent set); app-owned tool policy compiled by
  each adapter into its native delivery mechanism.
- `dispatch/worktrees.ts` — provision / teardown / land / stranded scan (git via execFile).
- `dispatch/worktree-lifecycle.ts` — durable state transitions, project setup +
  readiness receipts, sealed checkpoints, per-repo landing queue/mutex,
  current-base revalidation, merge receipts, retention/teardown, boot reconcile.
- `dispatch/prompt.ts` — provider-neutral specialist instruction package (charter
  + `## Your contract` block w/ expected_output + AC verbatim) + orchestrator
  roster appendix; adapters compile it to native instruction surfaces.
- `dispatch/runner.ts` — one run over `RuntimeSession`; transcript persistence +
  agent-event broadcast; tool-call evidence; wall-clock ceiling. It contains no
  Claude/Codex event parsing.
- `dispatch/verification.ts` — tier gate + executors (path-guarded fileSize, runBash
  w/ output tails, hasGitDiff anchored to sealed commit) + settlement rules.
- `dispatch/service.ts` — DispatchService (fresh/continue/kill/ask/answer/submit/settle).
- `http/agent-runs.ts` — invoke, continue, list, by-dispatcher, inspect, kill, events,
  contract, deliverable, pending-asks, contracts/:id/deliverable, contracts/:id/review.
- `runner/` — canonical adapter/session/event/capability types, runtime registry,
  fake adapter, Claude adapter, Codex adapter, and shared conformance suite.
- Guard tests: adapter-only provider imports; stamped runtime/account/model/native
  id; same-runtime resume routing; one terminal event; unsupported capability is
  typed; spec-less dispatch refused; no write-capable agent outside its ready
  worktree; empty-AC answer escalates; actual paths within contract scope;
  sealed-commit review; auto-merge fails closed; per-repo landing serialization;
  stale-base revalidation; positive ancestry before teardown; no-deliverable
  gate; kill-test preserves work + reconciles pending landing/teardown.
