# Agent runtime architecture

Status: **locked boundary; Claude orchestrator selection path implemented**
(updated 2026-07-11). `docs/current-state.md` records the as-built gaps.
`docs/master-plan.md` wins on product scope; `AGENTS.md` holds the short-form
non-negotiable rules.

## Decision

PC-SDK is the application. Claude, Codex, and any future agent system are
pluggable **agent runtimes** that drive PC-SDK components through one canonical
adapter contract.

The boundary is an agent-runtime boundary, not merely an LLM-provider boundary.
Claude Agent SDK and Codex both include a model, agent loop, native session
store, tools, permissions, compaction, and streaming protocol. PC-SDK does not
pretend those internals are identical. It owns the product semantics around
them and requires every adapter to translate its native behavior into the same
observable PC-SDK contract.

## Ownership

PC-SDK core owns:

- projects, specialists, the orchestrator, contracts, dispatch, verification,
  landing, worktrees, and boot recovery;
- the canonical conversation and runtime-event contracts;
- account, runtime, model, effort, and permission-selection policy;
- the MCP registry, consumer attachments, tool policy, and health state;
- the transcript shown to the user and portable cross-runtime handoff context;
- normalized health and usage state, including explicit `unknown` or
  `unavailable` values when a runtime cannot supply telemetry.
- repository isolation and the complete provision/readiness/review/merge/
  teardown lifecycle defined in `docs/worktree-lifecycle.md`.

An agent-runtime adapter owns:

- runtime authentication and credential-directory selection;
- native thread/session creation, resume, interruption, and disposal;
- native model discovery and capability reporting;
- translation between native streaming events and canonical PC-SDK events;
- translation of PC-SDK tool and approval policy into the runtime's supported
  mechanism;
- native MCP delivery and runtime-specific quota/rate-limit observations.

Only the composition root and runtime registry may select a concrete adapter.
Core chat, dispatch, contracts, DB services, HTTP/WS handlers, and UI code must
not branch on Claude/Codex event shapes.

## Canonical model

Use these terms consistently:

- **runtime**: an agent harness such as `claude-agent-sdk` or `openai-codex`;
- **provider**: the model service behind a runtime, such as Anthropic or OpenAI;
- **account**: one subscription login isolated in its runtime credential home;
- **model**: a runtime-discovered model identifier;
- **app session**: the PC-SDK row and transcript visible in the product;
- **runtime session**: the adapter-owned Claude session or Codex thread;
- **turn**: one app request and its canonical terminal outcome.

Agent and orchestrator execution selection is explicit:

```ts
interface RuntimeSelection {
  runtimeId: string;
  accountId: string;
  model: string;
  effort:
    | { kind: 'selected'; value: string }
    | { kind: 'none' }
    | { kind: 'unavailable' };
}
```

Every app session snapshots its runtime selection. Defaults may live on a
project or specialist, and a dispatch may override them, but a running session
never silently changes runtime, account, or native session identity.

The durable orchestrator stamp includes `runtimeId`, `accountId`, `model`,
explicit effort state, bind-once adapter-native session identity, continuation
provenance, and a non-empty continuation-attempt identity. The attempt identity
rotates immediately before every native create or resume mint. A receipt or
failure callback can advance only the exact persisted attempt, so an abandoned
provider stream cannot confirm or fail a successor after remint, restart, or
service replacement. These internal identities never cross the orchestrator
session-frame or session-HTTP browser seam. Existing specialist agent-run and
pending-ask DTOs still carry native session-shaped fields and are explicitly
later N3 cleanup, not evidence of this invariant outside the orchestrator path.

A display-only provider label is not a substitute for the stamp. Model
identifiers and allowed effort values come from the selected adapter/account's
capability result and are validated again immediately before a session is
created or resumed.

For repo-mutating work, runtime selection never chooses the working directory:
the worktree lifecycle supplies the recorded worktree cwd. Write-capable
sessions cannot point at the main project checkout.

## Adapter contract

The Phase 2 `RunnerBackend` seam is the migration starting point, not the final
vocabulary. Phase 3 generalizes it into a provider-neutral contract resembling:

```ts
interface AgentRuntimeAdapter {
  readonly id: string;
  capabilities(accountId: string): Promise<RuntimeCapabilities>;
  listModels(accountId: string): Promise<RuntimeModelDiscovery>;
  createSession(input: CreateRuntimeSession): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSession): Promise<RuntimeSession>;
}

interface RuntimeSession {
  sendTurn(text: string): AsyncIterable<RuntimeEvent>;
  interrupt(): Promise<void>; // command acceptance, not abort confirmation
  dispose(): Promise<void>;
}
```

Canonical runtime events use product concepts such as session started, message
delta/completed, tool requested/completed, approval requested, context
compacted, usage observed, warning, and turn completed/failed. Names such as
`sdkUuid`, `parent_tool_use_id`, Claude `permissionMode`, Codex item kinds, and
native rate-limit envelopes stay inside their adapters.

The contract is capability-based, not a lowest-common-denominator fiction.
Capabilities include native resume, model discovery, native MCP, approval
round-trips, structured output, reasoning/effort controls, usage telemetry, and
stream granularity. They also describe whether the runtime provides context
window size, exact/approximate current context use, and compaction observations.
Missing capabilities produce typed, visible degradation; they never cause
silent fallback or invented context/usage precision.

## First adapters

### Claude Agent SDK

- Subscription path: Claude Code login under `CLAUDE_CONFIG_DIR`.
- Credential rule: scrub `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` so they
  cannot shadow the selected subscription login.
- Native session: Claude SDK session id and `resume`.
- Instructions/tools: SDK system prompt plus the app-owned MCP/tool bridge.
- Current state: `ClaudeRuntimeAdapter` is the only Claude SDK importer. It
  provides account-scoped capabilities/model discovery, revalidates exact
  model/effort selection before create/resume, emits correlated positive native
  session receipts, and fails closed on missing or mismatched resume identity.
  Orchestrator app sessions persist the complete immutable selection and route
  every remint/resume through it. Specialist-wide immutable effort/attempt
  persistence remains a later N3 slice. Specialist dispatch also still imports
  and selects `CLAUDE_RUNTIME_ID` directly rather than receiving its choice only
  through the composition/registry boundary.

### OpenAI Codex

- Subscription path: ChatGPT login cached under an isolated `CODEX_HOME`.
- Native integration: Codex app-server for rich orchestrator/client behavior;
  the Codex SDK may be used where it preserves the same adapter contract.
  `codex exec` is a CLI/non-interactive fallback, not the product abstraction.
- Native session: Codex thread id and thread resume.
- Instructions/tools: developer instructions, optional replacement model
  instructions, runtime settings, and native MCP configuration.
- Boundary: ChatGPT subscription access is through Codex. Raw OpenAI Responses
  API or Agents SDK use API billing and are not the subscription adapter.

Additional runtimes are allowed only by implementing the same adapter and
conformance suite. Do not add provider conditionals to core services.

## Sessions and switching

Runtime/account/model changes are session boundaries:

1. positively interrupt or finish the active turn;
2. end or suspend the current PC-SDK app session;
3. retain its bind-once native runtime session id for eligible same-runtime,
   same-account resume;
4. create a new app session stamped with the new runtime selection;
5. start a new native runtime session.

An adapter may declare that a same-runtime, same-account native thread can
change model or effort safely. PC-SDK may use that optimization only after a
positive capability result and receipt; it still creates a new PC-SDK app
session so the new immutable selection and provenance are explicit. Otherwise
the new app session starts a new native session with a handoff.

A Claude session is never resumed as a Codex thread or vice versa. Returning to
an older app session resumes it through its original adapter and account.

Cross-runtime continuity is an app-owned handoff, not fake native resume. A
future handoff compiler may seed the new session with selected transcript,
project facts, open contracts, tool state, and an explicit provenance link to
the source session. The initial provider-switch implementation may start clean;
it must say so visibly.

## Prompts and specialist definitions

The specialist builder stores a provider-neutral charter and execution policy:

- name and plain-English charter;
- runtime/account/model/effort defaults;
- tool policy and MCP attachments;
- permissions, maximum turns/time, and output contract.

Adapters compile that definition into native instruction surfaces. PC-SDK does
not promise byte-identical prompts across runtimes because subscription-backed
agent harnesses retain their own service and runtime semantics. It does promise
that the user-authored charter, selected tools, permissions, and output contract
are represented explicitly and tested for each adapter.

If exact raw system-message control and a fully app-owned model/tool loop ever
become a requirement, that is a separately approved API-billed runtime. It must
not be smuggled in as a subscription implementation detail.

## MCP and tools

The MCP registry remains app-owned. Register once, attach explicitly per
consumer, health-probe centrally, and expose only the attached policy to a
runtime. Each adapter chooses its native delivery mechanism:

- Claude may receive in-process SDK MCP tools;
- Codex may receive generated native MCP configuration or a PC-SDK MCP
  endpoint appropriate to its process boundary.

Tool names, approval policy, audit records, and typed results belong to PC-SDK.
Provider-native built-in tools are capabilities and must be explicitly allowed;
they are not silently added because a runtime happens to ship them.

## Usage and accounts

The account registry is runtime-aware. Account ids are stable app identifiers;
each record identifies a runtime and its credential home. Runtime-specific
secrets and tokens never enter project settings or transcripts.

Usage is normalized without inventing parity. Claude and Codex may expose
different quota windows or incomplete subscription telemetry. Persist the
provider-native source semantics (`used` or `remaining`), normalized used
fraction when derivable, window, observation time, confidence, and
runtime/account attribution. The UI always presents consumed/used; unavailable
or stale data stays explicit. Billing remains subscription-first; any API-billed
adapter requires an explicit product decision and visibly separate semantics.

Session context is a separate observation family. An adapter reports exact,
approximate, compacted, or unavailable context state. Per-turn token usage is
not sufficient evidence to manufacture cumulative context fullness.

## Migration and gates

The inherited Phase 3 began with a behavior-preserving boundary extraction.
PC-SDK Next continues the remaining migration under master-plan phases N3/N5.
RS-001 completed the canonical selection/capability types, Claude discovery,
and immutable orchestrator create/remint/resume path. Remaining gates are:

1. finish specialist revision/run selection and durable attempt stamps;
2. add provider-neutral context and quota observations;
3. implement a Codex subscription spike against the same contract;
4. add `CodexRuntimeAdapter` and run the same conformance suite;
5. expose deliberate runtime/account/model/effort selection controls;
6. compile attributed cross-runtime handoffs and their UI provenance.

No compatibility shim or parallel wire is permitted. When canonical event
names change, contracts, persistence mapping, server, tests, and web consumers
move in one pass.

## Guard rules

1. Only adapter modules import provider runtime packages or parse native events.
2. Every orchestrator app session is stamped with runtime, account, model,
   explicit effort, bind-once native identity, and a rotating attempt identity.
3. Resume always routes through the stamped adapter and account.
4. Every turn has exactly one canonical terminal outcome.
5. Interrupt, approval, tool, and resume operations require positive receipts.
6. Unsupported capabilities return typed degradation; no silent fallback.
7. The same adapter conformance suite runs against Claude, Codex, and fakes.
8. MCP failure degrades but never blocks unrelated chat or dispatch.
9. UI and durable event consumers never interpret provider-native envelopes.
10. Cross-runtime handoff is explicit, attributed, and never called native
    resume.
11. A write-capable runtime session starts only in the ready worktree recorded
    for its run; task size and provider do not weaken isolation.
12. Native create/resume and their failure callbacks must carry the exact
    current attempt identity; stale attempt evidence writes nothing.

## Anti-patterns

- `if (provider === 'codex')` in chat, dispatch, HTTP, WS, DB service, or UI
  code instead of adapter selection at the composition root;
- adding Codex fields to Claude-shaped `RunnerMessage` variants;
- treating model ids as a hardcoded global enum instead of runtime discovery;
- reusing one native session id across runtime or account changes;
- exposing every runtime's built-in tools by default;
- claiming quota parity when a runtime has not supplied equivalent telemetry;
- using raw API keys because the subscription adapter is inconvenient without
  an explicit architecture and billing decision.

## External facts to re-verify when implementing Codex

These official OpenAI surfaces support the decision as of 2026-07-10. They are
implementation inputs, not permission to leak Codex protocol into core:

- [Codex authentication](https://developers.openai.com/codex/auth): ChatGPT
  sign-in supplies subscription access; API-key sign-in is separately billed;
  credentials are cached per Codex home/store.
- [Codex app-server](https://developers.openai.com/codex/app-server): the rich
  custom-client surface for auth, threads, turns, streaming events, approvals,
  interruption, model discovery, history, and MCP.
- [Codex SDK](https://developers.openai.com/codex/sdk): programmatic thread/run
  control; app-server remains the preferred deep-client protocol.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference):
  `developer_instructions`, replacement `model_instructions_file`, model,
  sandbox/approval, MCP, and credential-store controls.

Re-run a small local spike and generate/read the app-server schema from the
pinned Codex version before implementing the adapter. Public docs and the
generated version-matched schema win over remembered event shapes.
