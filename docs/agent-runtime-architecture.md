# Agent runtime architecture

Status: **locked boundary; Claude selection path implemented; unregistered
provider-free Codex adapter/conformance mapping implemented** (updated
2026-07-13).
`docs/current-state.md` records the as-built gaps.
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

The durable orchestrator stamp and every new specialist run include
`runtimeId`, `accountId`, `model`, explicit effort state, bind-once adapter-
native session identity, continuation provenance, and a non-empty attempt
identity. Specialist runs additionally freeze the execution-effective
specialist id/revision, charter, ordered context documents, and turn limit.
Attempt identity rotates immediately before every native create or resume.
Only an exact positive receipt may bind or confirm native identity, so an
abandoned provider stream cannot confirm or fail a successor after remint,
restart, or service replacement.

Internal native and attempt identities never cross orchestrator-session,
agent-run, pending-ask, browser, websocket, or MCP seams. Public agent-run DTOs
expose only the complete selection, opaque specialist revision, native-ID
presence, and typed clean/resume/legacy provenance. Pending asks correlate only
by the app-owned agent-run id.

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
  observeContext(): Promise<ContextObservation>;
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
- Credential rule: start the native child from the shared positive OS-
  essential environment allowlist, then add exactly the PC-SDK-selected
  `CLAUDE_CONFIG_DIR`. Ambient Anthropic/OpenAI keys, auth tokens, endpoints,
  peer credential homes, app variables, Git selectors, and unknown variables
  cannot shadow the selected subscription login or select API billing.
- Native session: Claude SDK session id and `resume`.
- Instructions/tools: SDK system prompt plus the app-owned MCP/tool bridge.
- Current state: `ClaudeRuntimeAdapter` is the only Claude SDK importer. It
  provides account-scoped capabilities/model discovery, revalidates exact
  model/effort selection before create/resume, emits correlated positive native
  session receipts, fails closed on missing or mismatched resume identity, and
  maps the pinned SDK's `getContextUsage()` control receipt into strict
  provider-neutral exact/derived context observations. Native category, path,
  tool, percentage, and error detail stays inside the adapter.
  It also owns Claude OAuth subscription-quota acquisition and strict native
  response/event mapping behind `observeSubscriptionQuota`; credential JSON,
  URL/header, token, percent scale, reset parsing, and native status never cross
  the adapter. OAuth utilization is a used percent in `0..100` with ISO reset
  time; passive SDK utilization is already a used fraction in `0..1` with epoch
  reset time. The only model bucket admitted from the additive OAuth `limits[]`
  array is positively verified bundled Fable evidence, canonicalized to
  `model:fable`; paid overage and credit/billing fields are excluded.
  Orchestrator app sessions and
  specialist runs persist the complete immutable selection and route every
  remint/resume through it.

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
- CX-001 admission evidence: exact `@openai/codex@0.144.1`, its direct native
  app-server, and its version-matched non-experimental generated schema are
  pinned. The no-turn gate used one exact canonical existing `CODEX_HOME`,
  forced and positively correlated the active file credential-store layer,
  rejected custom catalog/provider routing, observed cached ChatGPT auth with
  `requiresOpenaiAuth: true`, discovered one visible advertised default and
  supported default effort, and repeated the exact result through two distinct
  positively disposed native processes.
- CX-001 did not send a thread, turn, login, logout, tool, MCP, approval,
  context, quota, or inference request. It is not registered or composed as a
  production `CodexRuntimeAdapter`. Cached auth and catalog presence do not establish
  credential freshness, entitlement, subscription usability, billing route,
  model usability, or inference.
- CX-002 implements the provider-local `CodexRuntimeAdapter`, stable 0.144.1
  response/event mapping, exact create/resume and historical-identity fencing,
  and the shared public conformance contract behind injected provider-free
  discovery/execution peers plus an independent fake-only conformance authority.
  It is unregistered, has no native/default peer or production authority, and
  is statically unable to reach the CX-001 native client/process substrate.
- CX-002's fake authority supplies complete execution-policy evidence and
  atomically sealed terminal-boundary receipts for its contained fake only.
  Stable native 0.144.1 supplies no equivalent positive effective-tool/MCP/
  approval/containment evidence, so CX-002 authorizes no native thread or turn.
  Context and quota remain typed unavailable.

Additional runtimes are allowed only by implementing the same adapter and
conformance suite. Do not add provider conditionals to core services.

## Child environment boundary

`SEC-003` defines one provider-neutral inherited-environment boundary for
provider runtimes, app-owned Git, and delivery shell children. It starts from
an empty object and retains only explicit OS execution, home/config,
temporary, locale, and terminal names. Windows names are matched case-
insensitively and an ambiguous duplicate is omitted; POSIX names must match
exactly. Undefined, NUL-bearing, and exported-shell-function values are also
omitted. Caller input is never mutated and child failure never retries with
`process.env`.

An adapter may add only its internally selected credential-home selector after
that reduction. The Claude session sanitizes both its constructor input and
the final SDK query options; the pinned SDK fake-spawn guard proves the native
process receives only that result plus SDK-authored version/entrypoint markers.
CX-001 supplies a tested Codex environment/executable substrate for its
admission-only spike. CX-002 supplies the unregistered provider-free adapter
mapping and shared conformance target. A production peer must reuse the CX-001
boundary, satisfy the CX-002 closed port, and add positive effective tool/MCP/
approval policy plus escaped-descendant containment before registration.

MCP stdio remains a separate explicit-consumer boundary: the MCP SDK supplies
its small safe default environment and PC-SDK merges only the registered
server's configured attachment env. Those configured values are intentional
consumer policy, not ambient inheritance. The trusted same-engine restart must
retain app configuration and is not an untrusted child; launcher/browser
separation remains N7 operations work.

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

CX-001 queried neither context nor quota. It supplies no Codex evidence for
freshness/staleness, context/compaction, usage windows, normalization, or
billing semantics.

Session context is a separate observation family. `RuntimeSession` exposes one
required observation command and capabilities separately state supported
current-use confidences and compaction evidence. The Claude adapter validates
the complete control receipt; a correlated latest primary model iteration (or
strict direct usage fallback) supplies the exact input-plus-cache numerator,
while an absent correlation uses the validated control total as derived.
Malformed non-null evidence or malformed assistant ownership fails closed. A
native compaction boundary clears pre-boundary exact evidence before any
out-of-turn routing return; a later valid primary assistant may establish exact
evidence again. Per-turn result usage is never summed to manufacture cumulative
context fullness.

The orchestrator persists one observation after each normally settled eligible
turn on the canonical conversation sequence/outbox. Terminal and idle state are
authoritative first; the same session's FIFO successor waits only for the
bounded observation and commit. Timeout is explicit, and disposal, remint,
quarantine, or session replacement fences late writes. Browser replay derives
fresh/stale/compacted presentation and computes percentages only from accepted
used/usable counts. Any positively attributed frame from a different turn, or
compaction/context-projection evidence still buffered above a sequence gap,
stales the prior observation through bounded immutable indexes. Once later-turn
evidence supersedes a turn identity, a late frame cannot roll the context epoch
back or re-authorize that turn. Subscription quota remains a separate resource
family.

`RS-004` implements that separate family. A generic bounded scheduler resolves
each runtime/account through `RuntimeRegistry`; it never reads a credential home
or provider payload. Adapters return strict partial/complete source-observation
batches. The quota service derives used fraction and reset-capped freshness,
merges by stable window identity, and atomically commits one revisioned current-
state snapshot plus its global resource event. Equal account IDs under peer
runtimes remain distinct. Pull failure records typed availability while retaining
last-good windows without refreshing them; stale is derived from `staleAt`.
Passive events from orchestrator or specialist turns must match the exact
positively attached selection and remain outside transcripts.

## Migration and gates

The inherited Phase 3 began with a behavior-preserving boundary extraction.
PC-SDK Next continues the remaining migration under master-plan phases N3/N5.
RS-001 completed the canonical selection/capability types, Claude discovery,
and immutable orchestrator create/remint/resume path. RS-002 added honest
Claude-backed orchestrator context observation and projection. RS-003 completed
specialist revision/run selection, native attempt receipts, and safe public
provenance. RS-004 completed provider-neutral subscription quota on the Claude
  path. CX-001 completed the bounded pinned Codex admission dependency:
  exact-home/file-store cached-auth-kind and advertised-catalog observation across
  two directly disposed native processes, without a turn or adapter registration.
  CX-002 then completed the unregistered provider-free Codex adapter/session
  mapping, exact resume/history identity fences, and shared public conformance,
  without constructing or reaching a native execution peer.
  The remaining runtime-boundary N3/N5 backlog below does not reorder or authorize
  skipping the master plan's global N1/N4 gates:

1. implement a contained native Codex peer with positive tool/MCP/approval and
   escaped-descendant receipts, then run native conformance and the real-fix
   gate before production registration;
2. expose deliberate runtime/account/model/effort selection controls;
3. compile attributed cross-runtime handoffs and their UI provenance.

Neither CX-001 nor CX-002 authorizes a live thread or turn; any later live step
requires a separate contract and positive safety gates.

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

## External facts to re-verify on Codex upgrade or adapter implementation

These official OpenAI surfaces support the decision as of 2026-07-13. They are
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

CX-001 generated and reverified the stable app-server schema from pinned
0.144.1. Re-run the bounded spike and regenerate/re-review that schema before an
upgrade or production adapter change. Public docs and the generated version-
matched schema win over remembered event shapes.
CX-002's mapping and static conformance guards must also be re-run against the
regenerated schema as part of that upgrade gate.
