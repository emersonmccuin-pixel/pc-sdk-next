# Provider-free Codex runtime-adapter mapping

Date: 2026-07-13

Status: CX-002 code guarded-landed, post-merge verified, pushed, and feature
worktree removed; documentation closeout is pending.

## Result

CX-002 implements an unregistered `CodexRuntimeAdapter` against the pinned
stable app-server 0.144.1 schema. The adapter and its runtime session satisfy
the existing provider-neutral public contract when an explicit provider-free
discovery peer, execution peer, and independent conformance authority are
injected. Production composition cannot construct this path: there is no
default/native peer, no production conformance authority, and no importer from
outside `runner/codex/**`.

This is executable mapping and conformance evidence, not native-execution
evidence. It starts no Codex process, thread, turn, login, tool, MCP server,
approval, context observation, quota observation, or inference request.

## Closed provider-local seam

The runtime peer exposes only the stable methods needed by the canonical
session contract:

- `thread/start` and exact `thread/resume`;
- `turn/start` and `turn/interrupt`;
- the admitted notification epoch; and
- exact peer disposal.

It has no generic request escape. Construction also requires an independent
provider-free conformance authority. That authority, not the execution peer,
attests the complete fake execution policy before a thread request and
atomically seals one fake notification epoch before attesting a terminal
boundary. The fake-only receipts are deliberately ineligible as production
tool, MCP, approval, process, containment, or billing evidence.

Static dependency-graph guards prove both directions of the boundary: no
production source reaches the adapter surface, and no adapter-surface module
reaches the native app-server client, executable resolver, environment owner,
JSONL protocol, admission spike, or spike script, including through a
transitive helper.

## Exact discovery and thread admission

Discovery is account-scoped, exact-version/runtime attributed, defensively
captured, and normalized to provider-neutral model and effort capability
records. Missing or malformed discovery becomes typed unavailability. Selection
is copied before the first await and revalidated immediately before thread
creation; there is no account, model, effort, runtime, billing, or create-on-
resume fallback.

Create and resume admit only the selected model, built-in OpenAI provider,
selected effort, exact cwd, `never` approval policy, user reviewer, read-only/
network-disabled sandbox, durable non-ephemeral root thread, and idle response.
Resume requires an exact UUIDv7 requested native thread before discovery or peer
creation. Fork, parent, nickname, and agent-role provenance is refused.

Persisted resume history must be a complete stable `itemsView: full` response.
Every supplied terminal turn and all 18 pinned stable item discriminants receive
closed-key, data-only, primitive/enum, and nested-shape validation. Only turn and
item identities survive capture; historical prose, reasoning, commands, paths,
arguments, tool results, diffs, citations, and agent metadata are discarded.
Those identities seed the live session's replay fence, so a resumed peer cannot
reuse a historical turn or item identity. Full persisted history is still lossy
with respect to native command interactions; absence of a historical item is
never treated as proof that execution was tool-free.

## Canonical turn and lifecycle behavior

One session owns at most one turn reservation. A turn admits one fresh UUIDv7
native turn and one fresh agent-message item. Only the exact correlated
`turn/started`, agent-message start/delta/completion, and `turn/completed`
sequence can affect canonical output. The exact completed item snapshot must
match the observed item identity, text, and phase. Native identities and
provider payloads never appear in canonical events.

Completed, interrupted, and failed native terminals map respectively to one
success, aborted, or fixed redacted error result. Unknown frames, warnings,
server requests, non-agent live items, malformed order, stale identities,
conflicting terminals, and uncertain boundaries poison and dispose the session,
close any canonical message/running lifecycle, and produce one fixed safe error.

Interrupt response proves command acceptance only. Interruptability is fenced
as soon as the exact terminal frame is observed, before independent boundary
attestation settles; both new and already pending interrupts then fail promptly.
Successful terminal delivery releases the turn reservation before yielding the
result, so a successor does not depend on an extra iterator pull.

All peer waits race local cancellation. Disposal and consumer abandonment wake
hung turn start, notification, boundary, and interrupt waits without depending
on provider activity. Notification iterators receive exactly-once best-effort
close without delaying an authoritative terminal, even if iterator cleanup or
peer disposal hangs. No notification read begins after settled disposal.
Consumer `return()` and `throw()` finalize reservations and initiate exact-peer
cleanup; injected iterator errors are never converted into partially exposed
cleanup events.

## Honest capabilities and nonclaims

For an explicitly injected provider-free conformance peer, the adapter reports
model discovery, effort where advertised, and native continuation within that
fake path. Context and subscription quota are typed unavailable. This capability
result is not reachable from production composition and says nothing about a
real Codex process.

CX-002 does not establish credential freshness, entitlement, subscription
usability, API-versus-subscription billing, model usability, native create or
resume, effective tool/MCP denial, approval enforcement, escaped-descendant
containment, context precision, quota acquisition, dispatch, selectors,
cross-runtime handoff, or a real repository fix. No requirement status is
promoted.

## Verification surface

- Shared public adapter/session conformance runs against Claude, Codex, and a
  generic fake.
- Focused mapping, mutation, correlation, redaction, terminal, resume-history,
  interruption, cancellation, disposal, iterator, and static ownership tests
  pass 99/99 with server typecheck.
- Three independent hostile-review lanes covered protocol/admission, public
  conformance/static ownership, and lifecycle/race behavior; all actionable
  findings were converted to focused regressions before the closing gate.
- Sealed implementation `bf1f3a5ec8a12c17defa954c1bd5ccf3c59f4e87`,
  tree `9de0007e4420849af4cf4b7f999856167f29c46f`.
- Final feature-tree `pnpm ci:check` passes with 660/660 server tests and the
  dead-import guard; the production build is green.
- Feature record `98ce745db5e440a2f5c45fe2e620c00fda427dbf` guarded-landed as
  `611c304eaa8932900b4f9d339edbb2058d99fa0f`; both resolve to exact
  tree `ce1c31e8ba38095a6e7571f2fe2705939436e645`.
- Post-merge `pnpm ci:check` passes with 660/660 server tests; the production
  build, exact push/re-fetch, and guarded feature-worktree/residue teardown pass.

## Next boundary

A production native peer must reuse the pinned CX-001 executable/environment
substrate and satisfy this closed port without weakening it. Before any live
turn, a separate contract must provide positive effective tool/MCP/approval
policy and escaped-descendant containment receipts. Stable 0.144.1 currently
does not provide the complete positive evidence needed to mint those receipts;
read-only sandboxing and approval prompting are not substitutes.
