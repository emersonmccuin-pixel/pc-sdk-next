# Codex native-execution safety decision evidence

Date: 2026-07-13

Status: complete — ADR-0002 and the separate final receipt guarded-landed,
post-merge verified, pushed/re-fetched exactly, and both transient worktrees removed
under positive guards. No native Codex process, thread, turn, credential access, or
provider call was made

Historical addendum, 2026-07-13: this evidence remains unchanged, but its prospective
pinned-VM/image-provenance, fake protected-install, VM-teardown, and virtual power-reset
recommendations for CX-004—and every downstream clause that depended on equality with
that image or disposable physical-power-loss injection—are superseded by ADR-0002's
product-owner-approved Windows Sandbox qualification amendment. The active CX-004
contract is authoritative; all core containment, provider-policy, and other production-
gate findings here remain binding.

## Decision closeout

Proposal checkpoint `4fbbdf0f77b447e78f4218816e90d553ed93145a` and accepted
decision `6061ad5b817af13077cf4f9358b3f351c83699dd` preserve direct
base→proposal→decision ancestry. The decision guarded-landed as
`e8a1c6d0aa13520b1ab0037af02006cb9a283b91`; decision and merge resolve to
exact tree `5b926bbf73ecfc1819386c16a287125d74669c69`. The exact parent vector,
six-document scope, full post-merge gate, push/re-fetch, preserved feature branch,
and guarded feature-worktree cleanup are positive. Final receipt
`23841e3c5ddb2fdb961a6aad2f0a1f1364a1146f` guarded-landed as
`cb78b23dd49f1fdb751d86cb18838a6cdd2ac1cc` with exact ordered parents
`[e8a1c6d0aa13520b1ab0037af02006cb9a283b91,
23841e3c5ddb2fdb961a6aad2f0a1f1364a1146f]` and exact receipt/merge tree
`ec9af29551d91e41571d13add210f6025e011ec8`. Its pre/post full gates each passed
660/660 server tests plus the dead-import guard; exact push/re-fetch and guarded
final-worktree/residual teardown passed. Both branches are preserved. CX-003 is
complete and fake-only CX-004 is authorized subject to its own pre-code gates.

## Result

Two conclusions are independent and both are binding:

1. PC-SDK can contain the owner and ordinary in-tree `CreateProcess` descendants
   with two narrow repository-owned native owner-TCB artifacts: an exact transient
   cold-start/controlled-restart bootstrap and a C++ Node-API full-spawn addon. External
   same-PE `entry-scrub` has no SF-001/product authority; it creates hard-gated
   `cold-bootstrap` through exact challenge-read/watchdog-ready/parent-lifecycle
   handles, then positively closes its child handles and exits with one exact success
   code before admission. Scrub and old owner combine least lifecycle handles with the
   already-held kill-on-close outer job to cover cold/restart pre-arm failure; each
   transient mode has a noncancelable independently progressing hard self-deadline.
   After its independent watcher is armed, entry-scrub's main path creates/configures/
   publishes the permanent outer job, atomically assigns cold-bootstrap, then
   duplicates the job into it only after ready. Cold-
   bootstrap validates that handle/lineage, requires exact parent success, and kills/
   waits a timed-out secret-free scrub.
   Direct/replay/already-jobbed/death/hang/inherited-handle cases fail; the CX-004
   internal lane requires a positively unjobbed scrub and adds only the new owner job.
   Admitted cold-bootstrap wins SF-001's canonical-data-directory kernel witness and
   creates the exact sealed `node.exe` against a protected precompiled JavaScript boot
   entry suspended with implicit inheritance of the already-held permanent outer job and atomic
   restrictive process/thread descriptors, and exits after challenge-bound addon,
   handle protection/query, watcher retirement, protection-clear query, and source close
   under the mode-specific SQLite ordering
   below. The boot path has
   no shell/package-manager/tsx/esbuild/source-loader/ambient-preload edge; the addon
   is first optional non-host/non-system native code, the exact pinned
   `better_sqlite3.node` is second, and
   the owner native-load/process-spawn inventories remain closed for its lifetime. The addon
   atomically creates every provider/action/transition/Git root in its qualified
   PC-SDK-owned nested job set with explicit restrictive process/thread descriptors before first
   instruction. On cold start bootstrap exits before admission SQLite; during
   controlled restart only, the new owner acquires the dedicated admission-SQLite
   lease/ack before bootstrap exits, then opens product DB afterward. A live future N7
   launcher must retain scrub through exact success or terminate/wait, but that process
   handle does not cover launcher death or hard kill before scrub's watchdog arms. The
   separate N7 decision must add a crash-race-safe kernel anchor and exact create/
   publication/arm/handoff/death receipt; CX-004 neither qualifies nor freezes that
   outermost topology. Malicious pre-existing same-user handle racing is outside the
   descendant-origin threat. CX-004 may fake-provision and qualify the internal boundary only on one
   pinned disposable Windows 11 25H2 x64 full-revision/UBR/admission-identity tuple
   within base build `10.0.26200`; it does not provide production admission. Every
   identity delta remains unsupported until full CX-004 requalification, and
   production remains unavailable pending a separate protected-install/OS-policy/
   postmortem/N7-launcher-lifecycle provisioning decision and fresh host/build
   admission receipt.
2. Stable Codex app-server 0.144.1 cannot positively attest the closed-world
   effective external-action policy at a quiescent admission boundary. Its
   sandbox and approval echoes are useful but incomplete, and a one-phase
   thread response would not leave PC-SDK time to verify before activation.
   Native execution must therefore remain unavailable on this version.

The native boundary can be implemented and verified independently against fake
process trees. That work does not authorize a Codex process or substitute for
production provisioning. A later stable-version admission slice must first obtain
the fresh production bootstrap/SF-001/outer-job receipt, qualify the provider-root
security boundary before credential access, and close the policy receipt before the
first returned native thread is admitted or any turn/model work starts.

## Evidence boundaries

The protocol audit used the exact checked-in TypeScript schema generated from
the pinned `@openai/codex@0.144.1` executable, the existing CX-001/CX-002 client
and adapter evidence, and the matching OpenAI `rust-v0.144.1` source tag at
commit `44918ea10c0f99151c6710411b4322c2f5c96bea`. The checked-in manifest/schema
is the exact binary-facing authority. The corresponding public source tag is
explanatory behavioral evidence, not cryptographic provenance for the npm
   binary. The containment audit used primary Microsoft process/job/handle/token/
   security-descriptor/named-pipe/loader/diagnostic/content-inspection/filesystem/
   durability/toolchain documentation; official Node and pinned Node/libuv source;
   LLVM sanitizer/fuzzer documentation; and official Git repository/object/ref format
   documentation. Repository and installed-package source inspection covered the
   launcher/server boot path, `better-sqlite3@11.10.0`, and pinned dependency spawn
   surfaces. Bounded local no-file named-pipe probes are recorded only as observations
   that shape CX-004; they do not substitute for the pinned-VM normative proof matrix.

No schema field is treated as implemented behavior merely because it exists.
The matrix separates four evidence classes:

- **request:** a client input asking the server for a policy;
- **observation:** a passive read of config or capability metadata;
- **thread echo:** a response bound to a created/resumed thread but still not a
  claim about every model-visible tool; and
- **enforcement receipt:** positive evidence that the exact effective policy
  was installed, can be independently verified at a quiescent barrier before
  activation, and remains immutable for its admitted policy epoch.

Only the last class can admit a production native turn.

Exact local schema anchors:

- stable pin/digest: `apps/server/src/runner/codex/schema-manifest.json`;
- generated root: `apps/server/src/runner/codex/generated`;
- thread inputs/echoes beneath that root: `v2/ThreadStartParams.ts`,
  `v2/ThreadStartResponse.ts`, `v2/ThreadResumeParams.ts`, and
  `v2/ThreadResumeResponse.ts`;
- turn override/non-attesting response: `v2/TurnStartParams.ts` and
  `v2/TurnStartResponse.ts`;
- native capability limits: `v2/ToolsV2.ts` and
  `v2/ModelProviderCapabilitiesReadResponse.ts`;
- post-action vocabulary: `v2/ThreadItem.ts`;
- config snapshot/origin vocabulary: `v2/Config.ts`,
  `v2/ConfigReadParams.ts`, `v2/ConfigReadResponse.ts`, and
  `v2/ConfigLayerMetadata.ts`;
- MCP status vocabulary: `v2/ListMcpServerStatusParams.ts`,
  `v2/ListMcpServerStatusResponse.ts`, `v2/McpServerStatus.ts`, and
  `v2/McpServerStatusUpdatedNotification.ts`;
- stable method/notification vocabulary: `ClientRequest.ts`,
  `ServerRequest.ts`, and `ServerNotification.ts`;
- catalog and hook vocabulary: experimental `v2/AppsListParams.ts` and
  `v2/AppsListResponse.ts`,
  `v2/PluginListResponse.ts`, `v2/SkillsListResponse.ts`,
  `v2/HooksListResponse.ts`, `v2/AppListUpdatedNotification.ts`,
  `v2/SkillsChangedNotification.ts`, `v2/HookStartedNotification.ts`, and
  `v2/HookCompletedNotification.ts`;
- collaboration and remote-control vocabulary: `CollaborationMode.ts`,
  `SubAgentSource.ts`, `v2/CollabAgentTool.ts`, `v2/CollabAgentState.ts`, and
  `v2/RemoteControlStatusChangedNotification.ts`; and
- policy-mutation vocabulary: `ReviewDecision.ts`, `ExecPolicyAmendment.ts`,
  `NetworkPolicyAmendment.ts`, `v2/ThreadSettingsUpdatedNotification.ts`,
  `v2/ModelReroutedNotification.ts`, and `v2/TurnStartParams.ts`; and
- auth/billing mutation vocabulary: `AuthMode.ts`, `PlanType.ts`,
  `v2/Account.ts`, `v2/AccountUpdatedNotification.ts`, and the service-tier
  fields in `v2/Config.ts` and `v2/TurnStartParams.ts`.

## Stable 0.144.1 effective-policy matrix

| Dimension | Stable request/observation | Positive evidence available | Missing production fact | Verdict |
| --- | --- | --- | --- | --- |
| Approval policy | `ThreadStartParams.approvalPolicy`, `approvalsReviewer`; `config/read` | `thread/start` and `thread/resume` echo the effective approval policy and reviewer for that thread | `never` means no prompt, not deny all actions; it does not attest the tool set or prevent every native/MCP action | Partial, insufficient |
| Sandbox | `ThreadStartParams.sandbox`; turn override; layered config | Thread response echoes the resolved sandbox policy before the first turn | Read-only constrains some effects but does not remove read-capable native tools, attest Windows enforcement, or enumerate model-visible capabilities | Partial, insufficient |
| Built-in tools | `Config.tools`/`ToolsV2` exposes web-search configuration; provider capabilities expose three booleans | Version/schema identity and a few feature/capability values | Closed-world enabled model-visible shell, patch, file, collaboration, image, web, app, skill, or other tool inventory plus deny-unlisted semantics | Unavailable |
| Dynamic tools | Stable thread/turn start has no dynamic-tool definition | None on the stable initialized surface | Exact injected definitions and effective registry | Unavailable; experimental surface is excluded |
| MCP | Layered `mcp_servers` config; `mcpServerStatus/list` | Status can list discovered servers, tools, resources, and templates; a nonempty set constructs/connects a manager | Replace-all/disable-all semantics, config provenance/epoch, exact model-visible subset, and proof before initialization | Unavailable |
| Apps/connectors | Generated `app/list` parameter and response types are explicitly experimental | Experimental discovery vocabulary only; the surface is excluded from stable admission | Stable exact effective absence or a closed model-visible app action catalog for this exact future thread | Unavailable |
| Plugins/skills/hooks | Stable list methods plus skill and hook lifecycle notifications | Discovery/lifecycle vocabulary only | Whether resolved plugin, skill, or hook contents contribute model-visible actions for this exact future thread | Unavailable |
| External notifier | Pinned effective config accepts a `notify` argv and documents spawning it after each completed turn | Configuration and construction behavior only | Complete stable typed effective-notifier inventory, exact absence, and binding to this attempt/thread before activation | Unavailable |
| Collaboration/subagents | Stable collaboration/session-source/tool-state vocabulary | Type and lifecycle vocabulary only | Exact enabled agent tools, delegation paths, provenance, and deny behavior for this exact future thread | Unavailable |
| Remote control | Stable status notification vocabulary | Connection-status vocabulary only | Whether remote control can affect this thread and its exact enabled action set | Unavailable |
| PC-SDK/future composition origins | PC-SDK bridge is local; code-mode, companion-host, and external-broker are precautionary closed-world categories, not asserted 0.144.1 schema surfaces under those names | No provider claim | Explicit local absence plus provider denial of unlisted/future origins | Must be included in composite admission; not stable-surface evidence |
| Approval closure | Stable requests can be refused; settings changes can poison a session | Client handling after a request/change | `approvalRequests: disabled`, no auto-review/guardian/escalation, and deny on unknown/unapproved action | Unavailable |
| Admission binding | Config values can be supplied to `thread/start` | Thread response binds sandbox/approval/model/provider/cwd to the created thread | Full immutable selection/attempt/create-or-resume identity, challenge binding, provenance digest, and a quiescent verify/commit barrier before activation | Unavailable |
| Policy and selection lifetime | Settings/catalog/MCP/turn-policy mutation and model-reroute vocabulary exists | Post-change notifications and responses | Immutable admitted epoch plus quiescent re-admission for policy change; model reroute instead fences the attempt and requires a new app session | Unavailable |
| Auth/account/billing lifetime | Account update exposes auth-mode/plan change; config/turn vocabulary exposes service tier | Initial account/config observations and post-change notifications | Preventive immutability for effective auth identity, native account/workspace, plan, service tier, subscription/API billing route, runtime/model/effort, plus unchanged-identity token-refresh proof | Unavailable |

### Why the apparent substitutes fail

- `approvalPolicy: never` instructs Codex not to ask; it is not an auto-deny
  policy and can permit sandbox-allowed work without a callback. Pinned MCP
  permission code can also resolve some full-write/external/disabled-profile
  cases as approved under `never`.
- `sandbox: read-only` is not a native-tool deny list. Read-only filesystem and
  other non-mutating actions remain possible.
- Refusing every server-to-client approval or tool request proves only PC-SDK's
  callback behavior. Native tools can execute without such a callback.
- `config/read` returns layered effective configuration for a cwd, but it is
  not bound to the future thread and does not enumerate the final tool
  registry.
- Supplying `mcp_servers: {}` through the thread config does not prove lower
  user/project/plugin layers were replaced; recursive config merge can retain
  registrations.
- `mcpServerStatus/list` is not passive admission for a nonempty effective set:
  pinned source constructs an MCP connection manager to obtain status and can
  start/connect servers. An empty global result returns earlier, but is still
  unbound to cwd, request overrides, attempt, selection, future thread, config
  epoch, provenance, or model visibility.
- A negative experimental-feature list or post-start tool/item notification is
  detection after the admission boundary, not enforcement before it.
- A complete one-phase `thread/start` response is still insufficient if the
  runtime can activate policy-relevant sources while PC-SDK verifies it.
- `thread/settings/updated`, catalog/MCP/hook notifications, model reroute, and
  rejected turn overrides are post-change evidence. They do not prove an
  admitted policy remained immutable before the notification.

### Required future protocol receipt

A future stable app-server is admissible only if its provider-originated policy
facts can be independently verified and atomically joined by PC-SDK into an
admission receipt with these semantics:

- exact runtime/protocol/schema plus immutable runtime/account/model/effort
  selection;
- exact effective provider auth identity, native account/workspace, auth mode,
  plan, service tier, and subscription-versus-API billing route;
- continuation attempt, create/resume mode, requested native thread id or
  explicit absence for create, canonical cwd, and closed request/notification
  vocabulary;
- closed-world effective enabled inventory and provenance for native,
  dynamic/app-defined, PC-SDK bridge, exact effective MCP server identity/
  config/provenance/connection state plus tools/resources/resource templates/
  prompts/instructions, app/plugin/skill/deferred, hook/notifier,
  collaboration/subagent/remote, and every explicitly absent precautionary/
  future composition origin;
- exact sandbox/filesystem/network and approval/reviewer policy, with approval
  requests disabled, no automatic reviewer/guardian/escalation fallback, and
  unknown/unapproved actions always denied;
- an effective configuration provenance digest and immutable policy epoch;
- atomic binding of the complete policy digest to the exact selection,
  attempt, and returned thread; and
- a quiescent two-step admission barrier in one of two forms: passive preflight
  binds PC-SDK's fresh challenge to the receipt and a single-use token that
  start/resume consumes only after verification; or start/resume returns a
  challenge-bound receipt for a quarantined thread that cannot initialize any
  policy source, turn, or model work until PC-SDK verifies it and sends a
  positive commit bound to thread, attempt, epoch, and digest.

Rejection, timeout, or connection loss disposes a quarantine without
activation. A one-phase response is not enough. After admission, no turn-policy
override, settings/catalog/skill/app/MCP/hook/sandbox/approval mutation, or
other policy change may take effect inside the admitted epoch. Those policy
changes require another quiescent barrier and independently admitted complete
receipt. Model reroute is selection drift and requires a new app session under
the rule below. Unknown/unlisted actions always deny; session-wide approval and
exec/network policy amendments remain forbidden absent a later explicit
contract and new receipt. The gate does not require an invented field name or
an exhaustive list of disabled capabilities if the enabled inventory is
provably closed-world and all unlisted/unknown actions are denied.

Effective provider auth identity, native account/workspace, auth mode, plan,
service tier, billing route, runtime, model, and effort are app-session
immutable. Any drift or uncertainty fences the attempt and requires a new
selection/session plus full admission; it is not an ordinary policy-epoch
refresh. Credential/token refresh is allowed only with positive proof that
identity, subscription billing route, and every bound field remain unchanged.

The initial live gate should require an exact empty effective action inventory
from every origin named above, including the PC-SDK bridge. MCP has zero
effective servers or connections and empty tool/resource/resource-template/
prompt/instruction catalogs. That proves contained text/session behavior
without prematurely granting repository authority. Any unexpected request
hard-fails the session. A later explicit parity slice can admit named least-
privilege capabilities.

## Windows containment threat model

The contained peer must survive these cases without inferring success:

- the app-server spawns a grandchild before PC-SDK can observe the root;
- the root exits while a grandchild remains;
- a descendant requests `CREATE_BREAKAWAY_FROM_JOB`;
- a descendant creates its own nested job;
- the external scrub starts in any host/CI job, which the CX-004 topology must reject;
- an incompatible outer job prevents nesting or assignment;
- a PID exits and is reused while cleanup is being observed;
- process creation, attribute installation, limit query, membership query,
  resume, termination, or handle setup fails;
- a same-user descendant opens the server owner with `PROCESS_DUP_HANDLE` and
  tries to discover, acquire, duplicate, retain, transfer, or close its job
  handle;
- a descendant opens an out-of-boundary process with `PROCESS_CREATE_PROCESS`
  and uses `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` so a new child inherits that
  external process's job state;
- a descendant acquires out-of-boundary process/thread memory, create-thread,
  APC, context, suspend/resume, or mutation rights and makes that process create
  outside work; or
- a failed WMI/task/service/COM canary leaves a persistent artifact or escaped
  process on its test host;
- server graceful shutdown hangs or loses stdio; and
- the server process is hard-killed and therefore cannot report cleanup.

The hostile same-user scope begins with PC-SDK-created provider/lower/transition/
Git descendants. Arbitrary pre-existing same-user malware racing bootstrap or owner
startup is not claimed. Selecting that broader threat later requires a separately
approved OS-trusted pre-first-instruction launch anchor; protected install/code
integrity and runtime self-DACL changes do not provide it.

A Job Object is lifecycle containment, not a security sandbox. Ordinary
`CreateProcess` descendants inherit membership when breakaway is disabled, but
Microsoft documents exceptions such as WMI `Win32_Process.Create`. The policy
and OS sandbox boundaries remain separate requirements.

An inventory/approval receipt cannot close that exception. Before any model/
runtime external action, untrusted or project-defined PC-SDK command, repository
script, or real mutation, CX-008 must choose and prove an OS-enforced closed-
world two-tier process/security boundary. The provider root is restricted
relative to the PC-SDK owner/vault and external targets with only exact runtime-
home, provider-network, and IPC allowances. Lower action principals are further
isolated from the credential-bearing root and unrelated siblings with exact per-
action filesystem/network/IPC/handle allowances. The root retains only sealed
credential refresh/auth, inference-protocol transport to attested provider
endpoints, and PC-SDK lifecycle/turn/policy IPC. PC-SDK owner and provider root
have different authority: PC-SDK authorizes/routes and independently attests OS
state; the provider root may submit only provider-originated policy/control-plane
evidence and admitted request descriptors. It cannot authorize, mint, modify, or
attest OS/lower-principal facts. Neither performs a routed/model/runtime/project
action effect with its own authority.

The credential-bearing root creates an earlier information-flow decision. Before
the first CX-005 login-home access/provider invocation, choose and seal either (a)
the exact independently attested provider binary/control plane as a TCB for
credential non-declassification and provider endpoint/method/path/message
semantics, accepting that intentional bearer/socket export is outside the OS
guarantee, or (b) an independently approved opaque auth/inference broker that the
root cannot read/replay and that is not a generic signing/network oracle. CX-003
does not prove option (b) compatible with Codex subscription login. The decision,
accepted residual, root executable/config/auth-separation digest or broker policy,
and owner acceptance are first-class CX-005 through CX-010 receipt facts.

That same pre-CX-005 gate must qualify every provider-root-applicable invariant and
canary in the complete boundary before login, without deferring one to CX-008. Its
receipt includes in-process attester identity/provenance and independent queries;
exact raw/effective token inventory, removal-not-disable privilege policy, and self-
token adjust/duplicate/impersonate/assign denial; owner/group/DACL/MIL/other
applicable security attributes and exact access; independent non-DACL prevention
of pseudo-handle/`SetSecurityInfo` self-relaxation across root process/thread/token/
default-DACL/group/restriction/capability/privilege/integrity/AppContainer/session/
child/UI and protected PC-SDK job/handle/IPC state, excluding only the accepted self-
created inner-job residual; and atomic root enforcement. It also binds owner/DB/
vault/outside denial, mode-specific provider network/IPC/capability-export outcome,
root executable/native-load/config closure, one-app-session/one-root/one-PC-SDK-session-
job topology, the PC-SDK owner as sole process holding the exact session-job lifecycle-
plus-assign-only handle pair, exact retained-job membership/limits, durable grant
recovery, and preventive bounds for every independently enforceable root resource
class. An unbounded root resource remains unavailable unless a separate future
product/security decision accepts that exact residual before credential access.
The full CX-004 matrix reruns under this root composition. Because the working PC-
SDK and Next share the provider login home,
prove an auth-only shared seam, immutable Next policy/config, cross-app drift
fencing, and a lease honored by every writer or remain unavailable while another
app can use/refresh it. A Next-local DB lease is insufficient.

Every externally effectful model/runtime origin and every untrusted/project-
defined PC-SDK seam—including built-in filesystem/network/provider-native
actions, hooks, notifiers, tool bridges, setup/readiness/verification, and
repository scripts—crosses into a positively enforced lower principal. Fixed PC-
SDK provision/seal/guarded-landing/teardown remain typed owner state machines. All
general Git parsing/build work runs through the restricted exact Git-transition
principal below; the owner TCB performs only the separately qualified bounded
streaming verification, verified-byte promotion, and files-backend ref CAS. These
are not raw IPC commands/brokers. Unknown owner/root-authority effects block.
Self-selected thread impersonation is not a boundary; any equivalent is OS-
enforced and non-revertible by provider-controlled code. Phase placement is strict:
the active contract's complete provider-root subset is implemented and receipted
in CX-005 before credential access; CX-008 revalidates it and adds lower/sibling/
cross-tier composition rather than introducing a root guarantee. Unknown or
unclassified vectors block rather than passing through a finite canary list.

The steady-state launcher/attester is a PC-SDK-owned authority inside the local
server/native binding. One exact transient cold-start/controlled-restart bootstrap is
the sole separate-process exception. After the independent scrub watchdog arms, the
main path creates/configures/queries and publishes the process-sole permanent outer job
to that watcher with positive ack, atomically starts cold-bootstrap inside it, and transfers the job
only after watchdog-ready/handle validation. Cold-bootstrap then acquires and holds
SF-001's canonical-data-directory kernel witness and full-spawns the exact
sealed `node.exe` against an exact protected precompiled JavaScript boot entry with
closed nonsecret argv/env/cwd/handles/debugger state and explicit qualification-
sealed restrictive process/primary-thread security descriptors supplied atomically
with implicit inheritance of that outer owner job. It queries those descriptors and exact dangerous-
access denials before resume, holds bootstrap/Node/addon/load identities, and waits for a challenge-
  bound addon-ready/owner-posture receipt before any product DB/vault/provider/project
state. Controlled restart alone permits new owner to hold the bounded dedicated SF-001
admission-SQLite transaction while bootstrap lives; it is not product state.
The admitted path contains no `cmd.exe`, PowerShell, `pnpm`, `tsx`, esbuild process/
service, runtime source loader, loader hook, `NODE_OPTIONS`, `--require`, or `--import`.
Its deterministic boot JavaScript/source-map/loader/package/native-load manifest is a
protected artifact; the current source-run launcher fallback is development-only and
typed non-admitted.
The addon owner-initiates exact witness duplication first, immediately sets/queries
noninherit plus `HANDLE_FLAG_PROTECT_FROM_CLOSE` and identity, then duplicates the
owner-job handle. Target-job return is the OS handle-ownership linearization and
creates a known candidate; setting/querying the same flags and exact job identity/
limits/membership completes validated handoff/admission. Any between-state
uncertainty after target return terminates the known job. A pre-target witness/setup
failure asks bootstrap to terminate; if hung, owner terminates the exact bootstrap
process so its sole source-job handle closes and kills owner. Process-lifetime ownership sits outside addon
finalizers and no live path clears it; protect-from-close prevents accidental, not
hostile owner-TCB, closure. After target validation/ack, transient bootstrap monotonically
publishes retirement of every watcher-visible cleanup handle, including source witness/
job and owner lifecycle handles, and requires watcher quiescence/ack before closing any
of them;
it explicitly clears `HANDLE_FLAG_PROTECT_FROM_CLOSE` on each source,
queries it clear, and positively closes witness then job before exact success exit. Any
retire/clear/query/close uncertainty terminates the known outer job. Only steady-owner
targets retain protection with no live clear path. Ack/source-close/exact-exit is bounded coordination.
Before target return bootstrap death kills Node. Between target return and validated
admission, bootstrap death is uncertainty detected through the retained process
handle and owner terminates its known job. After admission each live side can
terminate the other/job on timeout, and an
occupied uncertain witness makes another launch refuse. After bootstrap success,
the owner acquires SF-001 SQLite admission with no kernel-lease gap before product
state. Kill injection covers every duplicate/query/ack/close/exit edge; no unknown
target handle or stale generation survives.
The Windows witness is one local-only `CreateNamedPipeW` server instance with
`FILE_FLAG_FIRST_PIPE_INSTANCE`, an exact one-instance maximum, and an explicit
protected security descriptor whose DACL, `OWNER RIGHTS`, and mandatory policy deny
all provider/lower/transition/Git client-open, `FILE_CREATE_PIPE_INSTANCE`,
`READ_CONTROL`, `WRITE_DAC`, and `WRITE_OWNER` access. Bootstrap creates it, immediately
sets/queries source noninherit plus `HANDLE_FLAG_PROTECT_FROM_CLOSE`, verifies identity,
publishes it to its watcher with ack before later fallible work, and owner receives only
the existing duplicated server handle; no legitimate client or reopen
path exists. Qualification attempts ACL relaxation, client/instance connection,
server-handle duplication/inheritance, and every retention variant, hard-kills owner,
then proves exact successor acquisition. Client-only orphan namespace behavior is not
inferred from documentation or one probe: any unknown or surviving handle/state is
unavailable.
The bootstrap has no steady-state provider/action/repository/autonomous-restart/relay
authority; controlled restart is only the bounded owner-invoked generation handoff.
Thereafter owner is the sole user-mode process holding owner/session/action job handles;
receipts bind the owner job's limits, membership, sole-holder sequence, and nesting as
the sole outer job above distinct provider-session, action, standalone
transition-action, and Git-transition jobs; every root is accounted in both its
inner job and the owner job. The live owner never explicitly closes its last owner-
job handle or SF-001 witness; both have queried protect-from-close/noninherit flags
outside addon-finalizer ownership. Graceful shutdown settles inner jobs/leases/I/O, flushes durable `owner-
exit-pending` and closes DB/listener/log state, then normal process teardown closes
both protected lifetime handles; addon unload/early-close cannot. A dead owner cannot
attest this, so an
external fixture proves it immediately or the next two-layer-SF-001-admitted owner
reconciles the prior PID/creation/image record from DB. Occupied/unknown state refuses
or quarantines, never kills a possibly healthy owner. The isolated hard-
kill witness retains process handles only. No additional privileged helper/service/
supervisor/lifecycle authority or persistent router is admitted. A future router
needs a separate decision and atomic restricted receipt/lifecycle/zero-authority proof.
The root-applicable attester identity/implementation/provenance are sealed in
CX-005 before credential access; CX-008 revalidates the same authority and extends
its scope to lower actions/siblings. Every provider/action/transition/Git root uses
its already-sealed restricted primary token and the qualified full-spawn entry point,
with explicit qualification-sealed process and primary-thread security descriptors
in the atomic creation call; no default-DACL window or post-create seal is
admitted while another protected principal is live. It mints receipts
from positive kernel/OS queries over retained non-inheritable exact process/job
lifecycle handles and temporary manifest-owned query handles, with fresh challenge/
attempt binding and PID-reuse-safe identity. Every temporary thread/token query handle
positively retires before receipt publication. Provider/action principals
cannot write, close, replace, or self-report it. An independently unqueryable
  fact is unavailable. It queries owner/group/DACL, mandatory-integrity label,
  applicable enforcement-relevant trust/resource/security attributes, and exact
  subject-versus-target granted access for owner/root/lower/sibling/job/IPC/
  protected-target objects; weakening or uncertainty fences. Audit-only SACL
  contents are not DACL-enforcement facts, and neither root qualification nor CX-008
  elevates merely to query them for that proof. Diagnostic qualification nevertheless
  binds effective audit policy and protected-target SACL or positive no-record
  behavior because kernel audit events and attempted names can disclose metadata;
  otherwise an explicit accepted residual is required. Before resume, distinct broad
  `PROCESS_INFORMATION` process/thread sources are used for required descriptor/identity
  queries and exact non-inheritable query/synchronize/terminate lifecycle plus temporary
  `THREAD_SUSPEND_RESUME` derivation; all required job/process/thread handles derive
  before any broad source closes. Require positive ordered broad-source retirement and
  `ResumeThread == 1`,
  then clear/query and positively close that temporary handle immediately; a
  nonpositive/uncertain close enters global quarantine, poisons launch, and mandates
  non-restart shutdown. Retained handles exclude resume/injection/control rights; exact
  `PROCESS_TERMINATE` is sealed for PC-SDK-only fail-closed lifecycle use. In
  admitted operation only PC-SDK retains them. Masks are exact per object:
  retained process handles have minimum query/synchronize plus sealed PC-SDK-only
  terminate. Any attester token/thread query handle is temporary, manifest-owned,
  least-rights, and positively retired before receipt publication; the temporary resume
  handle is cleared, queried, and closed immediately after exact resume. The sole duplicate-
  right exception is the coordinator-held, noninheritable, secret-free restart-
  bootstrap target handle with only `PROCESS_DUP_HANDLE`; it closes positively before
  durable `prepared`. All other retained masks exclude VM, DAC/owner, duplicate,
  create-process/thread, resume/context, and every undeclared right and are sealed in
  qualification and fresh receipts.

For the provider root, CX-005 qualification and each fresh root receipt bind raw
and effective token proof before credential access; CX-008 revalidates it and
binds every applicable lower per-call fact. The proof includes authentication/
logon id and source/origin; user/owner/
primary group; type/impersonation and elevation/linked-token state; every group,
restricted SID, capability SID, privilege, claim/security attribute, integrity/
mandatory policy, AppContainer/less-privileged-AppContainer, session, UIAccess,
virtualization, restriction, and SandboxInert fact. Every non-allowlisted dangerous
privilege is removed rather than disabled, and self access denies all
`TOKEN_ADJUST_*` plus undeclared duplicate/impersonate/assign rights.

The initial templates are headless: exact pre-first-instruction Win32k system-call
disable, `UIAccess=0`, no interactive window-station/desktop handle, and no UI/
session broker. Qualification/fresh/per-call receipts bind raw/effective mitigation,
station/desktop absence or identity/DACL/access, and UI-policy digest. Window
messaging/DDE/clipboard/global-atoms/hooks/input/capture/UIAutomation/accessibility/
shell/browser activation canaries require positive denial/no-effect. A GUI runtime
needs a separate isolated station/desktop decision; interactive fallback blocks.

Before first instruction, independently seal effective WER/error flags; every
applicable HKCU/HKLM/WOW64 WER/LocalDumps, AeDebug/JIT, IFEO GlobalFlag/
SilentProcessExit/MonitorProcess policy; runtime crash handlers; and Application
Recovery/Restart state. OS reporting/queue/upload/dumps/debugger/UI/monitor/restart
and direct WER/recovery registration calls must be preventively disabled or
unreachable; process-revertible flags alone do not prove it. Crash/fast-fail/abort,
long-hang, direct-report, recovery/restart, normal-exit, and job-kill canaries prove
no outside dump/store/payload/process/UI/egress/handle/late effect. CX-005 proves the
root case before credentials; CX-008 revalidates it for every lower, transition, and
Git executable. For the owner, the admitted transient bootstrap supplies the pre-
Node trust anchor, closed nonsecret launch, protected load closure, and postmortem
baseline. Before exposing spawn exports or opening protected state, the addon must
set/query/hold or fence the owner's posture and complete the exact handoff above.
Disposable qualification injects bootstrap, addon-load, and post-initialization
failures; production boot records a non-destructive receipt. If the protected
bootstrap/install/postmortem mechanism cannot cover either load window, CX-004/
production is unavailable. No long-lived helper or fallback is authorized.

Diagnostic output is closed. Each provider-root/lower/transition/Git template may
use only exact bounded PC-SDK stdio/control/log receipt channels. ETW/TraceLogging,
classic or modern Event Log, `OutputDebugString`/debugger/DBWIN, and unknown
diagnostic sinks must be preventively denied/unreachable or separately owner-
accepted and qualified as a data-policy residual. External real-time/file/event-
log/debug receivers plus nonce payloads prove clean delivery and candidate no-
delivery/no-record/no-late-effect. CX-005 proves the root before credentials; CX-008
revalidates and extends. Scanning or deleting output is not evidence.

AMSI, Defender/EDR, SmartScreen/reputation, cloud protection, automatic sample
submission, and other content inspection are ambient platform TCB/data-policy
routes, not process-network routes. Exact identities/configuration/routes are sealed
before protected input. Do not silently disable endpoint protection: either record
an explicit owner-accepted declassification residual with hostile-content/no-
surprise-upload canaries, or prove protected bytes cannot reach scanner/cloud/sample
sinks; otherwise that provider/script/file/action template is unavailable. An
immutable staged script does not prove this, and PowerShell protected content is
explicitly covered. The root decision gates CX-005; CX-008 revalidates and extends.

Principal enforcement is atomic at creation. The provider root starts in a
qualified sandbox/AppContainer under its restricted token/DACL/job/handle set
and positively queried non-revertible child-process prohibition before its first
instruction or IPC. For Windows child policy, require exact raw effective flags:
`NoChildProcessCreation=1`, `AllowSecureProcessCreation=0`, and no undeclared
audit/reserved flag. The root cannot use `PROCESS_CREATION_CHILD_PROCESS_OVERRIDE`.
The sandbox separately denies standalone `PROCESS_CREATE_PROCESS` and
`PROCESS_VM_WRITE` to every outside process/handle/IPC path, because Microsoft
documents either as a bypass. Direct/native root `CreateProcess*` and override
canaries deny; action launch goes through PC-SDK. If built-ins cannot delegate,
they are unavailable. The same executable/native-load/config closure below first
applies to the credential-bearing provider root in CX-005 and every fresh boundary
deployment; mutable auth is separately typed and cannot double as policy/code.

Each lower action starts suspended and atomically receives the qualified token/
AppContainer/DACL/job/handle/filesystem/network/IPC/UI policy. Its pre-call receipt
cross-binds the composite admission; app/provider session, exact root/session job/
action queue; raw/effective lower security state; CX-007-to-CX-008 template;
durable lease/recovery and resource reservation; executable/content/parser/IPC/
lifecycle facts; and exact action job. The initial template is strictly leaf with
the same non-revertible child prohibition. Job inheritance cannot prove token/
capability/mitigation/desktop/handle/env/cwd equivalence. Process-spawning parity
requires a later explicit CX-008 mediated-child or stronger-isolation decision;
every process needs an independent atomic receipt and no ordinary inherited child
is admitted.

Canonical authority, not provider presence, selects the lane. Model/runtime actions
always use the provider/composite receipt above. Contract-defined PC-SDK prepare/
readiness/verify/cleanup commands always use a provider-auth-credential-free transition-action
lane, even while a provider exists, and cannot overlap the same run/target. Its
challenge receipt joins run/contract/phase and CX-007 template, SF-002 repo lease,
worktree/target/recovery/resource facts, and a fresh qualification-equal OS receipt.
Each command uses the same lower isolation but its own PC-SDK-held kill-on-close job,
atomic per-process receipt, finite/global budgets, durable transition generation,
zero/EOF/revoke/post-walk/close-last proof, hard-kill, and boot recovery. It has no
provider/home/network/DB/vault/outside/model authority and cannot be inherited by a
later provider generation. CX-009 proves it in a disposable synthetic run.

A path/hash or path re-open is not identity. PC-SDK holds the executable and every
mutable namespace ancestor against write/delete/rename/reparse, binds final path/
volume/file/content/ancestor identities, and requires a documented mapped-section/
file-object proof or a documented complete namespace/ACL immutability proof through
mapping. If neither exists, the template is unavailable. Provider/action native
imports, delay-load modules, plugins, scripts, profiles, configs, response files,
and dependencies come only from an immutable staged closure/exact content channel
plus a sealed system/KnownDLL set. A preventive lifetime code-load/namespace rule
or pre-execution load barrier blocks mutable application-dir/cwd/PATH/runtime/
project lookup; endpoint module snapshots are diagnostic only. Swap-then-restore
and load-execute-unload canaries are mandatory.

Windows has one raw command line, so each template pins the actual child parser/
encoding and raw UTF-16/logical-argument fixtures. CRT quoting cannot substitute
for `cmd`, PowerShell, custom parsers, response files, or expansions; those use an
immutable script/response/content channel or are unavailable.

There is one provider-action launch topology: PC-SDK's in-process launcher/attester
creates every action root, with no persistent router. The PC-SDK-owned topology is 1:1
app session to provider root/session job;
all turns share one durable queue and at most one action tree in that job. Parallel
sessions use distinct jobs/disjoint run worktrees and global target/resource
exclusion. Reuse across app sessions or concurrent roots in one job needs a new
decision/proof.

`1:1` means one active deployment generation, not one lifetime root. Every
replacement gets a monotonic generation and fresh root/deployment/provider/
composite receipts; it starts only after positive old action/session-job zero,
I/O/handle close, lease/resource recovery, and no-overlap proof. Native-thread resume
also needs positive adapter capability and a fresh policy epoch for the generation.
Uncertainty quarantines; no stale receipt or concurrent/live cross-session root is
reused.

Before credential access, CX-005 binds the root-side 1:1 cardinality, exact root-
only session-job membership/limits/budgets, the PC-SDK owner as sole process holding
the exact `JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE` lifecycle handle
plus separate `JOB_OBJECT_ASSIGN_PROCESS`-only handle, and root target/access/
executable/UI/capability-export trust outcome. CX-008 revalidates
those facts and adds the action queue/lower/action-job/sibling composition.

At terminal/cancel/drift, PC-SDK stops new launches/ordinary controls, retains the
action-job handle, and selects one terminal path. Only natural/graceful policy may
deliver one already-bound EOF/shutdown control; cancel/drift/uncertainty calls
`TerminateJobObject`. After I/O/effect settlement, prove zero action-job processes,
empty complete list, exact root signaled/exit, EOF/exactly-once settlement, no late
effect, and the outer session job back at its exact provider-root-only baseline.
`terminationMode: natural | graceful | job` is orthogonal to
`cleanupProof: tree-exited | uncertain`; cleanup permits
outcome evaluation but does not turn cancellation, termination, or a bad exit into
success. Restore/revoke grants and verify target post-state only after positive
zero-holder/no-effect proof, then close process/I/O and the job handle last. On
uncertainty, close the job last as best-effort kill, quarantine, and claim no
success/reusable lease.

Every session/action grant that can outlive its token/handle/process is DB-backed
state. Globally exclude canonical overlapping targets and write-ahead journal each
target's pre/intended/applied/restore digests and state. Every apply/observe/commit
and revoke/observe/commit step is independently recoverable after partial multi-
target crash. Boot recovery blocks admission, restores only by per-target CAS when
current equals applied, never overwrites outside drift, and seals recovery epoch,
all old/applied/current/restored digests, and zero unresolved leases. Shared-home
writers require cross-app authority; a Next-local lease cannot exclude them.
Prefer expiring capabilities and inject death across every durable/OS transition.
Late restriction, unknown/unreceipted dynamic processes, and in-root/in-process
actions fence/terminate as unavailable.

Each action root receives a preconfigured PC-SDK-owned unnamed non-inheritable
nested action Job Object. The suspended root is atomically created with ordered
`PROC_THREAD_ATTRIBUTE_JOB_LIST=[sessionJob, actionJob]`, root/parent job first
and immediate child job second. Post-spawn assignment, reversed/partial ordering,
or either assignment/query failure is unavailable. The per-instance receipt binds
  exact hierarchy/identity/limits/sole-holder facts, membership, call, and lease.
  The initial action is leaf-only. Closing the action job cannot weaken
the session job; server death closes every owner-held job handle and kills all
trees. PID genealogy cannot substitute. The composed matrix covers reversed/
partial job-list failure, per-action cancellation, stranded descendants, and
server hard-kill with active action jobs.

The coordinated pre-resume multi-job receipt differs from initial CX-004 session
creation. The new action job must query `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` with
`BasicLimitInformation.ActiveProcessLimit == 1`, `ActiveProcesses == 1`, and only
the exact action root. It also binds finite process/job memory, CPU/time, wall-
clock, stdio, quota-backed storage, and every admitted hard resource cap. Missing
preventive disk/thread/handle/kernel-object bounds make that action unavailable.
Before credential access, the qualified provider-session template similarly seals
preventive bounds for every independently enforceable root resource class; an
unbounded class is unavailable absent a separate future owner-accepted residual.
Its exact job expectation is the sealed kill-on-close/resource-flag superset, not
CX-004's base kill-only equality; CX-008 revalidates it.
The global durable budget reservation proves concurrent cap sums do not exceed the
app budget and recovers after crash. Under the one-active-tree invariant, the
complete outer session-job list must equal the retained-handle-backed provider root
and new action root. Both job memberships/limits are exact; an unexpected
member or spawn race fails. CX-004's initial provider-root creation keeps its
original `ActiveProcesses == 1`/root-only check.

The IPC policy pins closed endpoints, peers, direction, handle set, and message
vocabulary. Routed requests bind origin, canonical nonsecret action/input facts, selection,
policy epoch/digest, attempt, thread, and single-use nonce. Substitution, replay,
cross-attempt reuse, and reordering fail closed. The lifecycle/control vocabulary
is also closed: initial stdin is closed unless an exact bounded payload/content
digest is in the pre-resume receipt; interactive or unreceipted control is
disabled. Every later permitted stdin write/EOF, resize, signal, cancel, or long-
lived-server request
is independently authorized before delivery and binds exact process/session/
call, origin/action/nonsecret input facts or payload digest, policy/boundary epochs, attempt,
thread, sequence, and nonce. Late/cross-instance/replayed/broader input denies; an
unreceiptable interactive protocol is unavailable. Privileged endpoints deny raw/
unknown passthrough, caller-selected/arbitrary or IPC-transferred handle
delegation, and privileged filesystem/network/process deputy services; only
attester-created child-side handles sealed in the launch receipt are permitted.
They may route only to the mapped lower principal.
Receipts, logs, telemetry, command lines, environments, and Git never contain raw
vault/local-input secrets. They retain only an opaque handle/reference plus version,
keyed digest, length, and sink-policy facts; secret values use a separately bounded
non-exportable channel or the template is unavailable. Initial transition templates
are secret-free; any later contract-declared local secret needs a separate explicit
sink/declassification decision and grants no provider auth/home/DB/vault authority.
Positive confused-deputy,
origin/argument/input substitution, replay, late/cross-
instance lifecycle, and cross-attempt canaries are mandatory. IPC- and action-
instance-lifecycle-policy digests are sealed into CX-008 qualification and every
deployment/per-call receipt.

Capability non-exportability is an OS-boundary invariant, not IPC content
filtering. Except for exact attester-created per-process launch stdio/control
handles named in that process's independent pre-first-instruction receipt under
the separately qualified process-spawn topology, no provider-untrusted lower/
action, transition-action, or Git-transition principal may export/import a boundary-issued credential or live OS/broker
capability across tiers/siblings/jobs/attempts/outside. Job membership or
inheritance alone never authorizes a descendant or capability transfer.
Cover inheritance/`DuplicateHandle`, Winsock protocol-info duplication, non-NT
shared graphics handles, marshaled COM/RPC references, and named/reopenable
sections, mappings, pipes, synchronization objects, devices, and broker endpoints.
Provider-root credential/socket export follows the selected trust mode: option 1
records it only as an accepted TCB residual; option 2 must make auth/socket state
unreadable/unreplayable and deny export/import. Authorized project data is a
separate explicit contract/data-policy decision; secret-bearing inputs need exact
sinks. Arbitrary bytes and scanning are not a capability firewall.

Microsoft documents no Winsock protocol-duplication access control. The accepted
initial lower template therefore has no raw Winsock socket/network capability. A
future mediator/multiprocess-tree topology needs a new product/security decision,
closed endpoint/DNS/proxy/protocol/method/byte/response bounds, atomic membership,
non-export and deputy proof. Until then any nonzero lower network is unavailable.

CX-008 consumes the sealed CX-007 compiled-policy/provenance digest, inventories,
and canonical origin/action/argument schemas. Qualification proves and seals a
total exact mapping from each canonical action shape to one principal/allowance/
IPC/launch/action-job/lease/lifetime/cleanup template, with no extra, missing, broader, or
ambiguous template. Any
CX-007 change requalifies the affected mapping or full boundary. Per-call receipts
select the exact mapped template, and composite admission verifies the cross-
digest relation.

Adversarial coverage for every restricted principal includes WMI `Win32_Process.Create`, Task
Scheduler, SCM/services, COM/RPC and other out-of-job brokers; opening the PC-SDK
owner, provider root, sibling, or external target with `PROCESS_DUP_HANDLE`;
every job-handle discovery/duplication/retention/transfer/close path; and
`PROCESS_CREATE_PROCESS` plus `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` against an
external parent. Cross-process execution/control uses the exact
`CreateRemoteThread` set `PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ` plus separate APC/
context/thread-hijack/suspend-resume canaries.

The same closed surface denies persistent same-user launch authorities outside
exact registry/filesystem allowlists: Run/RunOnce, Startup, COM/shell-extension/
protocol/App Paths/file-association triggers, plus any named or unclassified
persistence surface. Protected directions include restricted root, lower action,
transition action, and Git transition against owner/DB-vault/outside and every
other/same-class root/lower/transition/Git principal. The same complete pairs govern
jobs/parent spoof, UI/session, persistence, filesystem/network, named capability
export, self-tamper, and standalone receipts. Root-to-lower VM-write/create-thread/APC/context/
suspend/token/DAC/handle control is denied after attestation; provider/root talks
to lower action only through sealed IPC/stdio. Standalone effective
`PROCESS_CREATE_PROCESS` and `PROCESS_VM_WRITE` deny independently in every
protected direction. Only PC-SDK retains exact lifecycle/attestation handles.

Confidentiality and credential isolation independently deny effective
`PROCESS_VM_READ`/`ReadProcessMemory`; query rights leading to process/thread
token access; `TOKEN_QUERY`, `TOKEN_DUPLICATE`, `TOKEN_IMPERSONATE`, or
`TOKEN_ASSIGN_PRIMARY`; thread impersonation/context/control rights; and
`WRITE_DAC`/`WRITE_OWNER` across every protected process/thread/token pair.
Query/read is not called process mutation, but disclosure still blocks.
Qualified coordinated/composed spawn paths preserve the exact lower principal/
job/handle policy for an action tree; ordinary in-job creation alone proves no
security boundary.

Self-tamper for root/lower/transition/Git principals covers process/thread/token owner/default-DACL, groups/restricted SIDs/
capabilities/privileges/integrity/AppContainer/session, every `TOKEN_ADJUST_*`,
child/UI/job/IPC state, and root-to-lower injection. Prevention/non-revertibility
is required. Restricted token/AppContainer/DACL alone is insufficient: Windows'
current-process pseudo handle has all-access semantics and `SetSecurityInfo` can
replace the caller's process DACL, including NULL. CX-005 needs an independent non-
DACL kernel rule and exact pre/post access checks for the provider root before
credential access. CX-008 revalidates that root proof and extends it to lower/
sibling/cross-tier directions. Any scope without proof is unavailable; monitor-
and-kill cannot substitute.

Created objects need their own proof. Seal creator default owner/group/DACL,
`CREATOR OWNER`/`OWNER RIGHTS`, MIL/trust state, namespace/volume boundary, and
post-create access for every filesystem/registry/named IPC/kernel class. A creator
may supply a protected DACL and gain owner-implied `WRITE_DAC`, so inheritance alone
cannot prove prevention. Admit either a qualified filter/broker/precreated-handle
boundary that prevents self-grant/export, or—for ordinary files/directories only—a
private dedicated volume/device namespace that no concurrently active or unadmitted
provider root, lower, transition, Git, sibling, or outside principal can address
even after the exact currently leased designated creator/consumer uses NULL/grant
DACL; only that principal sees its sealed grant. PC-SDK owner retains only sealed
volume-control/recovery handles, performs no semantic read
or parse while a creator may run, and after positive job zero alone invokes the
bounded no-follow/rematerialization verifier. That case records contained self-
change, then raw-rematerializes/deletes every noncanonical object before parse/seal
and re-walks. Registry/named objects are initially precreated-handle-only. Create-
with-protected-DACL, self-relax, cross-open-by-path/name/file-id/handle canaries must
prove preventive denial or exact private-volume containment; cleanup after a bridge
never passes. The root case gates CX-005 and option 1 does not absorb it.

Provider/action DLL/delay-load/plugin/profile/config, swap/rename/reparse/swap-
back, and load-execute-unload substitution must fail before unverified execution.
A non-vacuous socket-
export control opens a synthetic isolated echo socket, calls
`WSADuplicateSocketW` for the exact handle-backed target PID, sends the protocol-
info blob through the same arbitrary-byte result path, reconstructs it with
`WSASocketW`, and proves nonce I/O/lifetime. Candidate lower/action-source
directions must deny before import; option 2 must also deny a root with no raw/
replayable auth/socket. Option 1 records the root-source result only as its accepted
TCB residual, never OS evidence. Lower/action post-state binds action-job zero/EOF;
root post-state binds session-job/control-plane state plus the mode-specific
residual or denial. Lower/action and option-2 cases prove no protected surviving
descriptor/connection/marker and restored policy; option 1 records the exact
surviving residual without calling it protection. Every case ends in VM teardown. Equivalent shared-
resource, marshaled-reference, and named-object families receive a differential
or positive ambient-inaccessibility proof.

Synthetic filesystem/network canaries prove the allowance policies. The root is
denied synthetic PC-SDK-vault/owner/outside paths and non-attested egress. Lower
actions are denied the synthetic runtime-home/credential canary, sibling/outside
paths, and every raw Winsock/direct/DNS/proxy route. Exact intended root control-
plane and lower filesystem access succeed; lower network allowance is empty. Only
attester-created exact child-side stdio/control handles enter the sealed launch
list; parent sides remain non-inheritable. Matched controls/post-state prove no
unauthorized file/directory/admitted-registry-or-credential-store read/write/
delete-child/rename/link/reparse/`WRITE_DAC`/`WRITE_OWNER`, disclosure, connect,
DNS, or proxy effect. Named-pipe/RPC client-impersonation canaries deny or prove
ambient unavailability from token privilege/SQOS facts. A synthetic secret-env
canary proves root `CODEX_HOME`/auth/proxy/vault values absent below while exact
intended env succeeds; it does not prove post-start trusted-root non-declassification.
No real credential, endpoint, user data, or project is used.

Before any restricted writable grant, PC-SDK creates an isolated run-owned content
root on a dedicated per-run volume/private device namespace or an equivalently
qualified filesystem boundary. Its receipted identity makes cross-boundary hard
links impossible and prevents every concurrently active or unadmitted provider/
root/lower/transition/Git/sibling/outside principal from addressing the volume
through a mount, DOS/volume/device/name/file-id path, or inherited handle; the exact
currently leased designated creator/consumer sees only its sealed grant, and PC-SDK
owner retains sealed control/recovery handles. A directory
DACL alone is insufficient; absent this boundary direct writes are unavailable.
Owner performs no semantic read/parse while a creator can run. After positive job
zero, a bounded handle-based no-follow verifier rejects or raw-rematerializes every
reparse/junction/mount/symlink, noncanonical owner/DACL/MIL object, and file without
positive volume/file/link/alias identity, then re-walks. Writable content shares no
hard-linked object with a cache/outside path; dependencies are an immutable read-
only closure off-volume. In-volume hardlinks remain untrusted until a bounded raw-
handle copy after positive no-outside proof makes them single-link. Symbolic-link
privilege and Developer-Mode/unprivileged symlink, junction, mount, and other
reparse creation must be preventively denied or direct writes are unavailable.
Crash recovery quarantines until alias/lease post-state is positive and never
follows an unresolved name.

Qualification binds separate exact local filesystem/volume tuples for content,
Git common/admin storage, quarantine, and immutable dependencies: volume GUID/
serial, filesystem, DACL/MIL/`OWNER RIGHTS`, stable file-id, hardlink/stream/reparse,
case, quota, lock, atomic-rename, and ref-CAS semantics. Remote/SMB/UNC, unknown,
unqueryable, mixed, or changed semantics are unavailable. One handle-relative path
grammar governs grant, post-state, scope/secret checking, restricted Git, seal,
landing, and teardown. It rejects absolute/drive/UNC/NT/device/`\\?\`/`GLOBALROOT`,
dot/dot-dot, separator/NUL, trailing-dot/space, DOS-device, colon/ADS, 8.3 alias,
and other collapsing forms; enumerates streams and admits only unnamed data; seals
case-sensitivity disabled initially; and rejects Windows-ordinal/Git/Unicode-
normalization collisions or any non-one-to-one Git-byte/UTF-8/UTF-16 round trip.
Every `.git` equivalent is rejected. `core.protectNTFS` is defense in depth only.

Writable templates pin preventive and observed limits for depth, entries,
component/path units, per-file and total logical/allocated bytes, streams, extended
attributes, links, sparse/compressed/encrypted/offline state, scan time/work/memory,
and receipt cardinality. The dedicated volume's worst-case namespace must fit the
bounded iterative recovery walk unless a qualified preventive filter enforces it.
Counters and deadlines are checked and streaming; over-bound state quarantines
before semantic parse or seal. New quarantine Git objects are loose-only with
auto-packing/maintenance off, and object count, compressed/expanded size, tree/
delta depth, graph work, and base pack/index/graph bounds are qualification facts.

Repository allowance stops at run-owned working-tree content. Resolve and seal the
`.git` file; gitdir/commondir; index; `HEAD`; loose/packed/reftable refs; reflogs and
locks; linked-worktree metadata; loose objects/packs/object-info/commit-graph/multi-
pack indexes; replace/graft/shallow state; config; hooks; alternates; submodule
gitdirs; and every linked administrative identity. Replace/graft indirection is
disabled and canonical objects are independently parsed. Lower principals cannot
mutate Git administration or invoke write-capable Git; fixed provision/seal/
landing/teardown use the restricted-parser and bounded owner-promotion stages below.
Needed reads are immutable snapshots/closed DTOs. Hostile gitfile/commondir,
packed/ref-backend/reflog/lock/worktree/object-index, config/include/hooks/filter/
helper/alternate/submodule, `GIT_*`, and reparse cases are qualification fixtures.

Deployment binds exact Git version, `core.repositoryFormatVersion` and extensions,
object hash algorithm/length, compatibility format, ref storage, worktree-config,
raw `HEAD`/target-ref/reflog/lock identities, and shallow/partial/promisor/missing-
object state. The initial tuple permits one sealed object format, files ref backend,
an already-loose exact target ref and reflog/lock protocol, no compatibility format
or worktree config, and no shallow/partial/promisor/missing state. Reftable, packed-
only target refs, unknown extensions/backend, or another tuple are unavailable
until a bounded backend-specific implementation qualifies. OID format is never
inferred from string length.

Every general-purpose Git executable/parser/build step runs as a transient fixed
restricted Git-transition principal, never inside the full owner process. It gets
only leased transition-specific run content/precreated admin/quarantine/index
handles and bounded IPC, with no common-object-parent create, target-ref, DB/vault,
provider-home, outside, network, or provider/model authority. Its mutable run-local
quarantine is explicitly untrusted until process zero. Existing common objects are
read-only through an attested base view. Its leaf launch pins immutable nonproject
cwd/search, sealed `git.exe`/closed writer plus full native/subcommand load closure,
exact arguments, sanitized home/config/environment, no shell, and no executable
hooks/filters/fsmonitor/diff/textconv/credential/alternate/submodule/project edge.
One protected config source may set `safe.directory` to the exact canonical admitted
worktree/common-repository path because the restricted principal is not the owner;
wildcard, broad-ancestor, interpolated, relative, aliased, duplicate, or extra values
fail, and value/source provenance is receipted.

After process zero, CX-008 must separately accept and qualify a minimal repository-
owned memory-safe streaming verifier in the owner TCB or sealing is unavailable.
It normally opens only frozen bounded quarantine handles. For an already-existing
final OID, it may additionally receive one owner-resolved read-only exact-object
handle with bound volume/file identity and expected OID, never common-parent/path
authority, and revalidates it across the equality verdict. It executes no Git/
project code, applies the sealed object/path/scope/secret grammar, and independently
parses and hashes the graph. A separate owner-TCB promotion/CAS primitive never invokes or
parses Git: it copies verifier-approved bytes to a private same-volume precreated
temp, size-checks, flushes/closes/reopens/rehashes, then atomically publishes without
replacement. An existing OID is reused only after bounded decode through that exact
handle proves identical canonical uncompressed `type size\0payload`; compressed-
byte equality alone is not proof, and the owner reopens/revalidates final identity
before ref CAS. Recovery receipts temp/final/directory durability. The owner alone performs
the sealed files-backend expected-old/new ref CAS through a flushed lock/temp and
atomic publish, then proves raw ref/reflog/lock/`HEAD`/worktree post-state. Partial
promotion/CAS strands and preserves evidence.

Each Git process has an independent lifecycle because provision may predate a
provider session. PC-SDK revalidates the SF-002 repository lease and exact run/
worktree/base/ref/transition state, journals intent/admin rights, and atomically
full-spawns the leaf process into its own kill-on-close job. The pre-instruction
receipt binds token/template, process-limit-one/root-only membership, sole PC-SDK
job holder, finite resources/I/O, repo lease, intent, global reservation/recovery
epoch, and no-oversubscription proof. Terminal proof requires signaled exact exit,
settled I/O, job zero, exact Git/filesystem/CAS post-state, rights/reservation release,
and close-job-last. Hard-kill proves death. Recovery reacquires the lease, completes
only independently proven idempotent steps, and otherwise strands without replay.

The scope is PC-SDK runtime's local Provision-through-Merge-through-Teardown
lifecycle. It authorizes no product remote push/re-fetch. CX-003's engineering
push/re-fetch is operator closeout outside this runtime contract. Future product
publication needs a separate security decision and exact network/auth/remote-CAS
receipts; it cannot add ambient network/credentials to this principal.

The deterministic seal begins only after positive action-job zero, handle/access/
lease revocation, and alias/target revalidation. Restricted Git/plumbing constructs
candidate objects in quarantine over a bounded frozen snapshot with fixed run branch,
parent, tree, author/committer, and run/contract identity. The qualified verifier and
owner promotion/ref-CAS stages above then independently re-read commit/tree/parent,
clean index/worktree, ancestry, scope, sizes, modes, identities, bytes, and secret
policy. Only their cross-bound positive receipt mints a deliverable; ambiguity
preserves the worktree. Qualification attacks `.gitattributes`, config/includes,
hooks/filters/helpers/fsmonitor/alternates/submodules, alias/encoding/reparse, object
bombs, format/backend mismatch, promotion/ref races, hard-kill, and recovery.

Run destructive canaries only in disposable network-isolated VMs. Before CX-008
implementation/canaries, its contract pins native OS/product/build/full-revision/
architecture and immutable base-image provenance/digest equal to positive CX-004
evidence; a different image first passes CX-004.
With the exact candidate two-tier composition enabled, rerun the full CX-004
fake-process/stdio/failure/hard-kill matrix. Do not elevate a principal or enable
  an ambiently disabled broker merely to manufacture risk. For every required
  pair—root/leaf/process-spawning policy, process/handle/parent/cross-process,
  confidentiality/token/self-tamper/descriptor, provider/action executable closure,
  capability export, UI/session, resource/global reservation, persistence, Git/
  filesystem/network/IPC, teardown, durable recovery, or autonomous after-call/
  revocation—require one of two sealed outcomes. The only exception is the exact
  owner-accepted option-1 root credential/socket pair, recorded solely as a TCB
  residual and never positive OS evidence:

1. if reachable, a clean clone holds the base account/logon and token source,
   canary/configuration, deterministic target, and inputs constant and positively
   creates the intended effect without the candidate boundary. After clean reset,
   record both effective token/DACL/AppContainer/capability receipts, prove the
   only differences are the sealed boundary transformation, and require boundary-
   specific denial; or
2. if ambiently unreachable, positive API/target/precondition evidence identifies
   the exact ambient OS/token rule. Credit only that sealed ambient boundary, not
   an unexercised candidate mechanism.

Plain failure, ordinary in-job creation, or any unlisted differential delta is
inconclusive. Record origin/principal mapping; current tier and protected-target
owner/group/DACL/mandatory-integrity-label/applicable trust-resource-security-
attribute and exact subject-access state; raw/effective token/child/UI facts;
attester identity/provenance; selected trust/broker/shared-home state; complete
allowance/action-job/executable-content/capability-export/resource/global-
reservation/durable-lease/recovery/IPC/action-lifecycle-policy digests; exact
queried lifecycle-handle masks; and boundary implementation/policy/configuration/
provenance digest/epoch. Post-state proves no process, unauthorized filesystem/
network/IPC effect, transferred/reconstituted capability outside the exact
owner-accepted option-1 residual, disclosure,
impersonation, descriptor change, injection marker, or
persistent broker/registry/autostart/shell-integration artifact. Boundary/
principal facts remain immutable/tamper-resistant; drift fences before activation
and terminates/quarantines during execution. A positive suite ends with positive
VM teardown; any possible effect quarantines the VM/evidence and blocks progress.

Each lower/action-source export canary binds source principal/process/action-job/
lease, target role/handle-backed identity, capability/API, exact export/import,
and lower-job zero/post-state. Socket facts add provider/protocol/synthetic tuple,
target PID, protocol-info digest/nonce, WSA errors, and nonce-I/O marker. Root-
source receipts instead bind root/session-job/control-plane and trust mode: option
1 records the accepted TCB residual without action lease or OS-denial claim; option
2 proves raw auth/socket absence and denial. All bind target no-capability post-
state as applicable. An opaque aggregate cannot substitute.

## Selected containment mechanism

The current verified in-app restart path in `apps/server/src/index.ts` launches a
detached replacement before the old server exits and relies on the replacement to
wait for SF-001 release. Under the selected permanent no-breakaway outer owner job,
that replacement would inherit the old job and die when its last handle closes.
Treating restart as manual shutdown would regress the one-click/no-babysitting
product boundary, so the same transient bootstrap must perform an exact controlled
generation handoff instead; a detached spawn cannot remain a hidden fallback.

The current Windows witness in `apps/server/src/operations/kernel-witness.ts` is a
Node `net.createServer().listen(pipeName)` boundary. Pinned Node 22.13/libuv 1.49.2
creates a duplex pipe with null `SECURITY_ATTRIBUTES`, unlimited instances, and
replacement accepted instances. Microsoft documents that a default pipe descriptor
permits read access to Everyone/anonymous users. Local qualification probes confirmed
the default path accepted `GENERIC_READ` and desired-access-zero clients; a native
first-instance/max-one/local-only pipe with a protected deny-client descriptor
rejected zero and generic-write opens with `ERROR_ACCESS_DENIED`. A retained client-
only handle did not keep the tested name occupied, so that behavior remains
qualification-dependent rather than inferred. A local same-process probe duplicated
the server-instance handle, closed the original, observed a second first/max-one
creation fail with `ERROR_PIPE_BUSY` while the duplicate remained, then succeed after
the duplicate closed. That does not prove cross-process inheritance or owner-hard-
kill behavior. These facts require the protected no-client native
witness and its hard-kill successor matrix; they do not retroactively claim the
current libuv witness has that security boundary.

The current one-click launcher prefers `apps/server/dist/index.js`, but that artifact
is absent in this checkout and the fallback is `cmd.exe /c pnpm --filter
@pc-sdk/server start`; `apps/server/package.json` defines that start as `tsx
src/index.ts`. Lock-resolved `tsx@4.23.0` imports lock-resolved `esbuild@0.28.1`, whose transform service can start its
platform executable before application-body code. That path cannot satisfy addon-
first native loading or the process-creation coordinator. The future admitted path
must therefore build and seal a deterministic precompiled server boot artifact and
launch it directly with exact protected `node.exe`; the source-run path remains
explicitly non-admitted.

The current process/native closure is not yet admitted. Source inspection produced the
following upgrade-guard input; CX-004 must regenerate it from the exact compiled bundle
and pinned dependency graph rather than relying on the current direct-import-only
`apps/server/test/child-process-boundary.test.ts` guard:

| Current edge | Evidence anchor | Required admitted disposition |
| --- | --- | --- |
| Current source-run owner bootstrap | `launcher/pc-sdk-launcher.ps1:18,47-64`; `apps/server/package.json:12`; lock-resolved `tsx@4.23.0` CLI/ESM loaders; `esbuild@0.28.1/lib/main.js:2077,2265-2272,2372-2375` | Eliminate from admitted cold/restart; sealed bootstrap launches protected plain Node/precompiled boot only |
| External one-click UI launcher/browser activation | `launcher/pc-sdk-launcher.vbs:1-3`; `launcher/pc-sdk-launcher.ps1:23-31,93-109`; governing separation at `docs/agent-runtime-architecture.md:237-239` | Outside admitted owner-runtime containment and remains N7 operations work. Current VBS→PowerShell, diagnostic `msg.exe`, and server/browser `Start-Process` paths are not production boot. A future N7 launcher must retain its least scrub lifecycle handle for the routine path and separately provide a crash-safe kernel anchor across create→watchdog arm; CX-004 does not qualify/freeze that topology. Browser is never placed in the owner job |
| Detached server restart | `apps/server/src/index.ts:351-357` | Eliminate; use only the controlled-restart bootstrap protocol |
| Worktree Git subprocesses | `apps/server/src/dispatch/worktrees.ts:89-98,126-137,191-202` | Route through the restricted Git full-spawn template |
| Arbitrary verification/action command | `apps/server/src/dispatch/worktrees.ts:953-975` | Route through the restricted action full-spawn template; no owner authority |
| Worktree `taskkill` fallback | `apps/server/src/dispatch/worktrees.ts:1022-1030` | Eliminate |
| Repository-lease Git subprocesses | `apps/server/src/dispatch/repository-lease.ts:820-831,857-868,974-985` | Route through the restricted Git full-spawn template |
| Codex app-server direct spawn | `apps/server/src/runner/codex/app-server-client.ts:155-166`; `@openai/codex@0.144.1` is an `apps/server` devDependency with zero entries in the current server production graph | Eliminate/direct injection; a separately supplied future stable production binary uses and requalifies the provider-root port only |
| Claude live default spawn and dormant managed-settings registry helper | `apps/server/src/runner/claude-adapter.ts:653-673,1114-1120`; pinned SDK 0.3.206 `sdk.mjs:88` spawn seam and `sdk.mjs:117` dormant `resolveSettings`/`reg.exe` export | Inject full-spawn for session and model discovery; keep dormant registry export excluded, or eliminate/qualify it before enablement |
| Live stdio MCP boot and exported wrapper | `apps/server/src/mcp/client.ts:8,33-42,74-77`; boot reachability `apps/server/src/mcp/manager.ts:43-60,88-107` and `apps/server/src/index.ts:268-270,322`; `packages/mcp/src/transport.ts:6,34-50`; MCP SDK 1.29.0 `dist/esm/client/stdio.js:1,60-74`; `cross-spawn@7.0.6/index.js:3,7-12` and `lib/parse.js:12-24,27-60` | Replace with PC-SDK-owned SDK-compatible restricted full-spawn/stdio transport or type stdio MCP unavailable; forbid PATH/shebang/`cmd.exe` fallback |
| MCP workspace build-only executable | `packages/mcp/package.json:38` `prepare`; `packages/mcp/scripts/build.mjs:15,33-38`; lock-resolved `esbuild@0.21.5` platform executable | Exclude the prepare/build toolchain and executable from the admitted runtime artifact |
| Install-only native toolchain | `better-sqlite3@11.10.0/package.json:33` install script; resolved `prebuild-install@7.1.3`, `detect-libc@2.1.2` `lib/detect-libc.js:6,15,21,33`, and `node-abi@3.94.0`; ambient unversioned `node-gyp` fallback command is absent from the local install | Exclude install scripts/toolchain packages from the admitted runtime artifact; ship the verified prebuilt output |
| Dormant dependency process exports | Claude `sdk.mjs:93` session `where.exe`/Git and `bridge.mjs:99`; installed/pinned `@anthropic-ai/sdk@0.110.0` agent-toolset `node.mjs:36,145,599`, optional worker trigger `lib/environments/worker.mjs:160-171`, and `skills.mjs:10,17,140` | Exclude by named-import/bundle/source allowlist; any future enablement requalifies |
| Conditional `ws` native addons | pinned `ws@8.21.0` `lib/buffer-util.js:115-117` and `lib/validation.js:142-144`; optional packages absent now | Exclude packages and seal both `WS_NO_*` disables |
| SQLite native binding and extension load | pinned `better-sqlite3@11.10.0` `lib/database.js:36,43,47-55,83`, `lib/methods/wrappers.js:18-20`; pinned `bindings@1.5.0` `bindings.js:22-58,67-83,85-116`; current omitted-binding constructors at `packages/db/src/connection.ts:20`, `apps/server/src/operations/data-dir-admission.ts:230`, and `apps/server/src/dispatch/repository-lease.ts:817` | One verified addon object through every owner factory call; ban ambient binding and every extension route |

The native owner/runtime inventory starts at the `entry-scrub` executable mode and
covers bootstrap modes, the Node owner, and every process edge reachable from that
owner or its runtime dependencies. It does not absorb the external one-click UI
launcher/browser boundary left to N7. CX-004 qualifies only the internal behavior from
positive scrub-watchdog arm on a provably unjobbed fixture; exact entry-scrub invocation
shape and responsive lifecycle wait/terminate/close are future N7 integration inputs,
not proof of its crash-safe create→arm anchor. It never qualifies or jobs the browser.

The current manifests use semver ranges for `better-sqlite3` and `ws` while the lock/
install resolves the versions above. CX-004 must pin exact manifest, lock, store, and
integrity identities; a range-compatible upgrade is still a new admission input.

A reproducible current-owner production-closure audit ran
`pnpm --filter @pc-sdk/server list --prod --depth Infinity --json`, recursively deduped
canonical package `path` values including the server root, and scanned each present
package root for `.exe`/`.node`/`.dll` while excluding nested `node_modules`. It found
160 unique production roots: 153 present and seven absent platform optionals (two
Darwin, four Linux, and Windows arm64 Claude packages). The present production graph
contains exactly two native files:

- `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.206/claude.exe`, 248,682,144 bytes,
  SHA-256 `d5072b25b9a20bffb24625d36129a05ed2be4d2eb7e35625aad6aa35596892c2`; and
- `better-sqlite3@11.10.0/build/Release/better_sqlite3.node`, 1,721,344 bytes,
  SHA-256 `c6770a96c516d2b3e78308ecfcc146c38c0eb0875e180c8028d77f1e93914c6d`.

A separate recursive installed-tree scan found 16 native files; the other 14 are
dev/build artifacts and are not production-graph evidence. In particular, the five
installed Codex 0.144.1 executables are devDependency artifacts. A future production
Codex binary and its complete process/native closure must be separately supplied and
qualified rather than inferred from this checkout.

PC-SDK owns two privileged owner-TCB artifacts: an exact transient cold-start/
controlled-restart bootstrap
and the Node-API addon. From a qualification-sealed OS/image code-integrity and owner-
nonwritable install/postmortem baseline, externally invoked bootstrap `entry-scrub`
mode has no SF-001/product authority and reexecs the exact same PE in `cold-bootstrap`
mode with exactly a challenge-read handle, child `EVENT_MODIFY_STATE` access to an
initially nonsignaled exact two-phase auto-reset watchdog-ready/handoff-ack event, and
`PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE` parent handle in
the three-handle list, explicit object descriptors, qualified null/unusable std/console/
pseudoconsole and protected noninteractive desktop posture, and closed argv/env/cwd/
debugger. As the first fallible action in each transient mode, an independently
progressing restrictive noninheritable watchdog arms a sealed deadline with no external
input or cancel/reset/extend path; it observes only sealed monotonic cleanup-state
publication that cannot move the deadline, and process exit is the only disarm. A live N7 may retain entry-
scrub for routine timeout/terminate/wait, but a process handle does not cover N7 death
or hard kill before watchdog arm. That outermost edge remains a separate production
blocker requiring a crash-safe kernel anchor and may change this topology. Entry-
scrub's armed independent watcher covers the main path while that path creates/
configures/queries the process-sole permanent unnamed kill-on-close outer job with
exact zero `JobObjectBasicUIRestrictions`, immediately sets/queries source noninherit
plus `HANDLE_FLAG_PROTECT_FROM_CLOSE`, positively publishes it to the watcher with ack, requires
`IsProcessInJob(scrub, NULL) == FALSE`, and
atomically creates cold-bootstrap in `JOB_LIST=[ownerJob]` as its only job without
inheriting the job handle. This edge is deliberately unsuspended: atomic job assignment
contains it and its first instruction path only arms/validates the gate or terminates.
Before job publication, timeout terminates scrub and process
teardown closes any new handle; after publication, the watcher can terminate the exact
job. From the broad create result scrub derives separate DUP-only target and QLI/
TERMINATE/SYNCHRONIZE lifecycle handles, publishes child-lifecycle cleanup to its
watcher with ack, and positively closes both broad process/thread sources. Return/
publication/close failure terminates the
published job and known child; process teardown closes any unpublished handle.

Cold-bootstrap arms/queries its watchdog, clears/queries inheritance on all three
received handles, sets/queries `HANDLE_FLAG_PROTECT_FROM_CLOSE` on the parent lifecycle
handle, validates parent identity, and signals the first event phase. Scrub uses
an exact multi-object wait over event and child-lifecycle handles, consumes that phase,
then duplicates `JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE` access into
cold, sends the target value plus identity-bound challenge, and waits the second event
phase. Cold cannot signal phase two before receiving and validating the post-phase-one
target, so the two `SetEvent` calls cannot collapse into one pending signal. It sets/
queries noninherit plus `HANDLE_FLAG_PROTECT_FROM_CLOSE`, then queries/publishes the
exact job handle, sole membership/limits, and still-unjobbed
parent state before ack. Target return is the ownership linearization; uncertainty
before ack terminates the source job. After ack scrub monotonically retires every
watcher-visible cleanup handle, including job source and child lifecycle, requires
watcher quiescence/ack before closing any of them, then closes every child/control/
event/channel handle, clears/queries protection on the source job, closes it last, and
emits the sole success code.
Cold's watcher enters expect-
parent-success before ack, independently requires that exact exit, treats it as planned
release, and continues its sealed post-parent deadline; non-success/timeout terminates
the outer job. After exact success, cold monotonically retires every watcher-visible
parent/challenge handle and requires quiescence/ack before positively closing either;
it clears/queries parent protection before close. Only then may SF-001 open. Direct/
missing/replay/wrong-job/inheritance and current PowerShell/VBS
redirection are non-admitted. From positive scrub-watchdog arm forward, phase-complete
hangs leave no helper; N7 create-to-arm makes no such claim and CX-004 does not qualify
or freeze it. Ambient malware
racing scrub's brief child-handle window is outside the declared descendant-origin
threat. Admitted cold-bootstrap binds both PEs, Node and complete load closures, then
acquires SF-001, immediately sets/queries source-witness noninherit plus
`HANDLE_FLAG_PROTECT_FROM_CLOSE`, verifies identity, and publishes it to the watcher
with ack. It full-spawns exact sealed `node.exe` with the protected precompiled
boot entry suspended through implicit inheritance of the already-held outer job and
explicit restrictive process/primary-thread object descriptors. After exact descriptor/
access and pre-start query, it derives before closing either distinct broad
`PROCESS_INFORMATION` source an exact noninheritable `PROCESS_QUERY_LIMITED_INFORMATION |
PROCESS_TERMINATE | SYNCHRONIZE` owner-lifecycle handle and an exact noninheritable
`THREAD_SUSPEND_RESUME` owner-resume handle, both with zero duplicate options. It
publishes lifecycle cleanup to the watcher with ack and positively closes broad process
and thread sources. Using only the least owner-lifecycle and owner-job handles, it then
proves transitional membership `[coldBootstrap,owner]`, requires
`ResumeThread(ownerResumeThread) == 1`, and positively closes that derived thread handle
before owner-ready publication. Derivation or membership/resume uncertainty prevents
readiness without quarantining unrelated handles. Only an ambiguous acquisition output
or source/derived-close outcome quarantines that affected resource slot; every listed
failure terminates the outer job. It
then holds load fences and waits for
addon/posture readiness. The owner duplicates the witness, sets/queries noninherit/
protect-from-close and identity, then initiates job-handle duplication from bounded
bootstrap process/control handles. Every duplicate uses an explicit sealed least
target-access mask, `bInheritHandle=FALSE`, and `dwOptions == 0`; neither
`DUPLICATE_SAME_ACCESS` nor `DUPLICATE_CLOSE_SOURCE` is admitted. Target-job return is the OS handle-ownership
linearization/known candidate; exact flag and job identity/limit/membership queries
complete validated admission before protected state.
Bounded ack/source-close/exact-exit is coordination. Before target return bootstrap
death kills Node; timeouts let
each live side terminate the other or known job. After exact bootstrap exit on cold
start, owner acquires SF-001 SQLite admission with no witness gap before product state; an occupied
or uncertain witness makes concurrent/recovery launch refuse. Qualification injects
failure/death/hang at every lease/create/resume/duplicate/return/query/ack/close/exit
edge.

For controlled restart, the admitted old owner first settles every inner job/lease/
I/O, creates bootstrap suspended with exact object descriptors, and relies on implicit
membership in the unchanged outer job—never a duplicate job-list entry, breakaway, or
new job. Creation gives only bounded control and a real old-owner handle with
`PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE`, never
`PROCESS_DUP_HANDLE`. From the distinct broad `PROCESS_INFORMATION` sources and before
closing either, old owner derives the exact DUP-only and QLI/TERMINATE/SYNCHRONIZE
process handles plus an exact noninheritable `THREAD_SUSPEND_RESUME` restart-resume
handle with zero duplicate options. It positively closes both broad sources, then uses
only the least process-lifecycle and owner-job handles to prove pre-resume membership
`[oldOwner,restartBootstrap]`. It requires `ResumeThread(restartResumeThread) == 1`
and positively closes the derived thread handle. Derivation or membership/resume
uncertainty prevents ready without quarantining unrelated handles; only an ambiguous
acquisition output or source/derived-close outcome quarantines that affected resource
slot. Every listed failure poisons and terminates the outer job.
After that exact resume/close, bootstrap arms an
independently progressing owner-process/deadline wait whose hard self-termination
path needs neither control progress nor a candidate value, then sends its ready ack.
Old owner alone retains one exact noninheritable restart-target bootstrap process
handle with only `PROCESS_DUP_HANDLE`, plus a separate minimal query/terminate/
synchronize lifecycle handle, derived while the process-creation coordinator is
held with explicit masks, noninherit, and zero duplicate options; both broad
`PROCESS_INFORMATION` sources are already positively closed and bootstrap remains secret-free.
Old owner remotely duplicates witness then job into the live bootstrap and
delivers each exact returned target value/type using sealed least masks, noninherit,
and zero duplicate options. Bootstrap locally sets/queries noninherit plus protect-from-
close, queries identity, and publishes each candidate to its watcher with ack before
acknowledging it. Sender death or value/control mismatch,
timeout, or loss after target return makes bootstrap hard-self-terminate, so process
teardown closes even unknown/unprotected target handles; this avoids granting it
broad duplication authority over owner DB/vault/file/socket handles. Durable prepare
follows only after bootstrap protection/query acks, old owner clears and queries the
target handle's inherit flag, gets positive `CloseHandle`, and the coordinator remains
consistent. Any uncertainty
poisons creation and terminates the outer job. Restart commit is bootstrap's positive
receive/validation of the durable nonce/generation
`prepared → committed` CAS/read-back digest; its return ack only coordinates drain.
A single owner-lifecycle component owns the restart schema/commands/queries/DTOs/state
machine. Every prepared/committed/aborted/completed/reconciled/attention transition
atomically commits the row plus its canonical outbox/control event, with nonce/
generation/event idempotency and replay that never re-executes restart. Crash injection
and disposable power-reset tests use a sealed SQLite journal/`synchronous`/checkpoint/
flush/close/reopen contract; read-back is visibility, not by itself power-loss proof.
They prove neither row-without-event nor event-without-row can survive, including the
new owner's post-bootstrap completed transition.
A safe abort after prepare needs acknowledged CAS/read-back to `aborted`. Uncertain
send/receive/ack/abort kills the known outer job. Old owner then closes product state and exits; bootstrap
proves it absent and membership `[restartBootstrap]`, creates new Node by implicit
membership in the same job using the complete cold-owner broad-source derivation/
retirement and derived-thread resume/close rule above, transfers the exact nonsecret committed nonce/old-
generation/new-generation/digest tuple over sealed bounded launch/control input, and
shows `[restartBootstrap,newOwner]`. New owner challenge-validates that tuple and binds
it to its successor-admitted ack; it never discovers a generic/latest committed row.
New owner repeats
the cold witness/job handoff, and only its dedicated SF-001 admission-SQLite lifetime
transaction proves old SQLite release. It sends one bounded successor-admitted ack;
bootstrap exits; and `[newOwner]` is proven. Only then may new owner open product DB
and CAS that exact expected restart record `committed → completed` before other product
state, atomically recording its exact PID/creation/image identity and outbox event. No
general DB IPC reaches bootstrap. A pre-CAS `committed` row cannot record that not-yet-
created identity; after fresh acquisition of both SF-001 layers, cold recovery proves
no admitted holder and marks the exact generation interrupted without inventing a PID.
Only `completed` identity is later reconciled. Final
proof is that CAS, `[newOwner]`, one protected holder/generation, exact bootstrap
exit, and old-generation I/O/handle/lease/resource zero. While bootstrap lives,
counterpart-visible uncertainty terminates the job. After exit, responsive failure
self-terminates and crash/death releases; a live-hung new owner remains pre-vault/
provider/project, holds the witness, and makes contenders refuse rather than infer
death. Kill injection
covers create/resume/ready/duplicate-target-return/value-delivery/protect/query/
self-exit/record/send/receive/ack-loss/owner-exit/committed-tuple loss/wrong/stale/
replay/SQLite edges, including sender death
after each duplicate return while the main control receive is stalled, with bootstrap
signaled, zero retained targets, and positive successor acquisition. A
later cold boot may reconcile prepared/committed/completed/aborted state only after
fresh SF-001 acquisition, distinguish crash/death successor from live-hang refusal,
and never replay the
restart autonomously. No long-lived helper or autonomous-restart authority remains.
The initial build statically links optional non-host/
non-system runtimes and admits only the exact sealed Node host plus a qualified
system/KnownDLL set; every required delay-load edge is enumerated and no ambient
plugin/dynamic edge exists. A broader immutable co-bundled closure needs its own
pre-load safe-search and immutability proof. Mutable application/cwd/`PATH`/project/
user-writable DLL search is unavailable. Final-PE/loader audit plus substitution,
swap-back, and load-execute-unload canaries must pass; post-load enumeration alone
would detect compromise too late.

The current `data-dir-admission.ts` statically imports `better-sqlite3`, but pinned
`better-sqlite3@11.10.0` maps `better_sqlite3.node` lazily only when `Database(...)`
runs without a supplied `nativeBinding`; supplying one does not seed the module-scoped
default-addon cache for later direct constructors. The future boot entry therefore
needs a preventive full-lifetime source/dependency/native-load gate and exact ordering:
the exact sealed Node host plus qualification-sealed system/KnownDLL import/delay/
dynamic-load set is admitted; the repository owner addon is the first optional non-
host/non-system/application-native load; owner postmortem posture
becomes positive; then the exact protected SQLite addon is verified and intentionally
loaded by canonical path. One owner-owned SQLite factory/injection seam supplies that
same admitted addon object to every admission/product/repository-lease/future
`Database` construction. Static guards ban direct constructors and ambient `bindings`
resolution, and qualification seals one exact package copy/version/singleton/module-
cache identity. The factory bans `Database#loadExtension`, SQL/native extension-load
routes, and SQLite auto-extension hooks; canaries prove none can map a later DLL.
Pinned `ws@8.21.0` has conditional optional `bufferutil` and `utf-8-validate` loads, so
the admitted artifact excludes both packages and seals `WS_NO_BUFFER_UTIL=1` plus
`WS_NO_UTF_8_VALIDATE=1`. The SQLite binding's package/version/content, Node ABI,
canonical file/ancestor identity,
provenance, PE import/delay-load closure, loader search, final-PE mitigation
disposition, and exact absence of process-creation, dynamic-resolution, service-start,
or spawn-capable background-thread paths; the coordinator cannot intercept a native
thread that bypasses it. Substitution/load-window crash behavior and source-build or verified-
prebuild reproducibility are sealed. Missing required mitigation is unavailable
without an exact owner-accepted residual. Preventive guards and the load gate enumerate
every `.node`, `process.dlopen`, `LoadLibrary`, and equivalent edge, admit only the
exact sealed Node/system closure, and among optional non-host/non-system/application-
native mappings admit only owner addon then SQLite binding for the entire owner lifetime. Runtime notifications/
periodic enumeration corroborate only; an unenumerated capability is unavailable and
an observed unknown/late mapping fences and terminates. Every future native dependency
gets a new manifest and full affected requalification. Repository static analysis/fuzz
applies to repository code; it does not qualify this third-party PE.

CX-004 must seal a compiler/linker/final-PE hardening manifest for both artifacts
before code. They share one qualified spawn/serialization/handoff core where
possible; divergence repeats the full matrix. The
pinned tuple names strict warnings-as-errors, stack-cookie, CFG, ASLR, DEP/NX, high-
entropy VA, and CET-compatible policy where positively supported, and verifies the
resulting PE properties. Missing/downgraded/unverifiable mitigation fails rather
than disappearing. Native static analysis and sanitizer/property/coverage-fuzz
lanes cover UTF-16 application/argv/environment serialization, arbitrary binary
I/O/framing/backpressure, handle/error unwinding, teardown, and failure states.

For both artifacts, pin conservative caps for application/cwd UTF-16 units; argument count/per-argument/
total command line; environment entry/name/value/total double-NUL block; staged
script/content; stdio buffering; and privileged IPC/control/receipt frame sizes and
collection counts. Server and native layers perform checked conversion/add/multiply
before allocation/copy/parse/OS calls. Environment collision and sort use one sealed
Windows-native ordinal case-insensitive oracle for ASCII/non-ASCII, never locale-
default behavior. Test zero/bound/+1, huge/wrap-shaped counts, allocation failure,
NUL, sealed invalid/unpaired-UTF-16 behavior, and giant fragmented/coalesced frames;
fail typed before mutation with bounded diagnostics/evidence.

CX-004 generates a closed native-resource acquisition/release-site manifest from the
exact built artifacts. It covers every acquired/output/duplicated/borrowed/pseudo
kernel/user-object handle and every raw OS/native opaque resource explicitly acquired by
either artifact with a release obligation, including heap/attribute-list and crypto/
catalog/certificate/signature contexts. C++ standard-library and Node/runtime-managed
allocations stay under RAII/sanitizer/fuzz proof, outside this OS-resource manifest. Each site binds a
compile-time ID, type, acquisition callsite, owner/borrower/no-release class, rights/
inheritance, identity slot, last use, type-specific close/destroy/free API, sealed
documented no-failure normal return, positive result, or independently verified
idempotent postcondition, order, and fault canary.
Typed wrappers are the only native acquisition/release path; AST/static/import/dynamic-
resolution guards reject direct/unregistered calls, and the embedded manifest digest
must equal independent source/PE inspection. That generated manifest—not prose examples—
is closure; an unmanifested/ambiguous site, incompatible generic `CloseHandle`, or owned
release without one sealed completion proof is unavailable.

Every owned recyclable numeric handle has an artifact-owned `known-live`, `positively-
closed`, or `close-outcome-quarantined` identity slot. Close is attempted once from
known-live; only its sealed positive result records closed. A nonpositive/uncertain
result quarantines the value, forbids later query/use/reclose, fails the active transient
or poisons later owner process creation, and mandates process exit/non-restart owner
shutdown. Opaque/non-numeric resources use analogous known-live/positively-released/
release-outcome-quarantined state and type-appropriate identity/liveness canaries. RAII/
transient cleanup touches only known-live slots. Borrowers never release; their manifest
owner stays positively live through last use. No-release/pseudo sites have stable
documented identity and no release call or effect.

The full-spawn binding is a qualification-sealed two-entry-point family. Same-token
bootstrap/base creation uses exact `CreateProcessW`. Restricted provider/action/
transition/Git primary tokens use exact `CreateProcessAsUserW`. The target token is
already sealed; its handle has the documented `TOKEN_QUERY | TOKEN_DUPLICATE |
TOKEN_ASSIGN_PRIMARY` rights, while caller-token access, target/caller session equality,
restricted-token waiver, and `SE_INCREASE_QUOTA_NAME` behavior are exact receipt facts.
Missing privilege/right, session mismatch, or any need for elevation, logon, profile
load, alternate credentials, or another process API is unavailable. The addon's token-
preparation suboperation owns the target-primary and every caller/root query-token handle
under the same coordinator; no caller-owned/externally borrowed token handle is accepted.
All owned token handles positively retire through the generated manifest before success
publication; release uncertainty quarantines only the affected slot and poisons.
CX-004 positively qualifies `CreateProcessAsUserW` with the same suspended
`STARTUPINFOEX`, ordered job-list, handle-list, explicit process/thread descriptor,
query, resume, I/O, failure, and teardown matrix used by `CreateProcessW`.

Use that full-spawn Windows family rather than spawning in Node and assigning
afterward. The operation acquires the process-creation coordinator before new-leaf
creation/configuration or parent-baseline capture, and keeps it through atomic success
publication or complete failure cleanup plus atomic poison/unavailability publication:

1. Admit only the exact Windows 11 25H2 x64 client qualification tuple: base build
   `10.0.26200` plus full revision/UBR and admission-checkable native OS/security-
   component identity/provenance sealed by positive CX-004. Runtime equality is
   mandatory; any delta is typed unsupported until full CX-004 requalification
   seals a replacement tuple. Then create an unnamed non-inheritable immediate
   lifecycle leaf Job Object owned by this spawn instance.
2. Accept only a repository-enumerated, qualification-sealed job template, never
   caller-supplied raw flags or a limit structure. For the CX-004 base template,
   zero-initialize `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, set/query it through
   `JobObjectExtendedLimitInformation`, and require
   `BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
   That base equality excludes both breakaway flags and every other limit flag.
   Later qualified provider-session/action templates require their exact sealed
   superset of kill-on-close plus named resource flags/fields and reject every
   missing or unsealed extra. The full CX-004 behavioral/failure matrix reruns
   with those composition-specific expected assertions. Every template validates
   only fields enabled by its flags, never mutable accounting/peak telemetry. Every
   outer/session/action/transition/Git job also sets and queries exact zero
   `JobObjectBasicUIRestrictions`; any nonzero UI restriction is unsupported for this
   nested topology, independently of window-station/desktop isolation. Each
   ordinary addon launch classifies jobs as implicitly inherited ancestors, borrowed
   explicit parents, and exactly one newly created owned immediate leaf. While the
   coordinator is held, it seals each implicit/borrowed parent's complete retained-
   handle-backed pre-create PID baseline.
   Every explicit-list handle carries `JOB_OBJECT_ASSIGN_PROCESS` through create. A new
   leaf's broad source handle is paired with its exact noninheritable
   `JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE` lifecycle handle. A provider-
   session leaf alone also derives a separate exact noninheritable
   `JOB_OBJECT_ASSIGN_PROCESS`-only handle for future action joins. All required job
   derivations precede create, but the broad job source remains known-live through child
   creation and the later process/thread derivations because it supplies assignment
   authority to the atomic job list. It is not retired at this point. No child resumes
   and no receipt publishes until every required job/process/thread derivation and all
   broad-source retirements are positive; the PC-SDK owner is the sole process holding
   the exact successful session pair. An action launch borrows the assign-only handle only inside the process-
   creation coordinator and never owns or closes it. Action/transition/Git leaves
   retain only their lifecycle handle and no later assignment path. The
   implicit outer owner handle has no assignment authority.
3. Prove the coordinator runs on the sole spawn-capable main Node isolate.
   Every repository and transitive-dependency process-creation path reachable from the
   admitted Node owner participates; bootstrap modes have only their sealed launch
   edges and the external N7 UI launcher/browser remains outside this coordinator.
   Production
   `worker_threads` or spawn-capable native background threads are absent or
   share an enforceable native critical section. Fail closed if the dependency
   audit cannot establish that invariant. Pinned Claude Agent SDK 0.3.206 exposes
   both an injectable live default provider-spawn path and a dormant managed-settings
   `child_process.execFile(reg.exe, ...)` export. The first must use the full-spawn port;
   that injection is mandatory for both session execution and model discovery. The
   second is eliminated through an admitted in-process registry query or receives
   its own qualified inner-job/template/handle receipt. Neither may remain an
   uncoordinated owner-job-only child. Both current PC-SDK MCP stdio wrappers instantiate
   SDK `StdioClientTransport`, which reaches `cross-spawn`; admitted mode replaces them
   with a PC-SDK-owned SDK-compatible transport backed by exact canonical application
   plus the restricted full-spawn/stdio port and sealed MCP templates, or types stdio
   MCP unavailable. PATH/shebang/`%COMSPEC%`/`cmd.exe` fallback is forbidden. Dependency
   upgrades cannot add unlisted spawn surfaces.
4. Inside that non-interleavable section, create only the exact child-side
   stdio handles as inheritable. Put those
   three handles in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, set
   `STARTF_USESTDHANDLES` with exact `hStdInput`, `hStdOutput`, and
   `hStdError`, and pass `bInheritHandles=TRUE`. Keep the job, parent-side I/O,
   and all unrelated handles non-inheritable.
5. Build `STARTUPINFOEX` with both
   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` and
   `PROC_THREAD_ATTRIBUTE_JOB_LIST` containing the template's qualification-sealed
   ordered inner-job vector/cardinality/ownership classes: newly owned session;
   borrowed session then newly owned action; or newly owned standalone transition/Git.
   The outer owner job is inherited implicitly and never repeated. Missing, extra,
   duplicate, or reordered handles fail before create. Scrub→cold alone explicitly
   supplies `[ownerJob]`; cold→Node and every controlled-restart bootstrap/new-owner
   launch are separately qualified implicit-outer protocols with no duplicate outer
   entry. Add the
   qualification-sealed `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` and
   `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` raw values required by the selected
   template. A template claiming AppContainer/capability enforcement also supplies
   `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` with exact SID array/count/flags/
   backing lifetime and verifies the resulting token; restricted-token state alone is
   insufficient. Initial headless restricted templates atomically set Win32k system-call
   disable and no-child-process/no-override. Seal value sizes, OS support, post-create
   query, negative/unsupported behavior, and every other creation-time policy attribute
   the boundary relies on.
6. Call the qualification-selected entry point with explicit noninheritable process
   and primary-thread security attributes containing the exact object owner/group,
   protected DACL/`OWNER RIGHTS`, and any qualification-proven mandatory label. The
   already-sealed target primary token separately supplies its exact integrity,
   restricted-SID, and privilege state. `CREATE_NO_WINDOW` is not UI isolation: every
   headless template supplies an exact protected noninteractive isolated window-
   station/desktop through `STARTUPINFO.lpDesktop`, and receipts its identity/DACL/
   `OWNER RIGHTS`/mandatory policy/access/name-open denial/lifecycle/recovery. A NULL,
   default, or inherited parent desktop is not admitted; inability to compose this with
   the token/AppContainer/Win32k policy makes the template unavailable. Use a canonical absolute `lpApplicationName`
   and no search, plus a mutable command line containing that exact path as quoted
   `argv[0]` and exact per-argument Windows quoting. Reject embedded NUL in the
   application path, every argument, cwd, and every environment name/value.
   Reject empty environment names, names containing `=`, and duplicate case-
   insensitive keys. Use the canonical cwd and a sorted double-NUL-terminated
   UTF-16 allowlisted environment block, plus
   `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
   CREATE_NO_WINDOW | CREATE_SUSPENDED`.
7. After the qualification-selected entry point returns, complete every exact process/
   thread descriptor and identity query that requires its distinct broad
   `PROCESS_INFORMATION` process/thread sources. Before closing any broad job/process/
   thread source, derive with `bInheritHandle=FALSE` and `dwOptions == 0` an exact
   `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE` root-lifecycle
   handle from the broad process source and a separate exact `THREAD_SUSPEND_RESUME`
   root-resume handle from the broad thread source; neither duplicate option is
   admitted. Then clear
   `HANDLE_FLAG_INHERIT` on every
   temporary child-side handle, query each flag back as clear, and close each
   handle while the coordinator remains held. A nonpositive/uncertain close outcome
   enters the global handle quarantine above.
   Any clear/query/close uncertainty
   atomically poisons process creation for the server lifetime before any release:
   every later app-owned spawn fails typed without an OS process
   call. Controlled restart is forbidden; durable attention plus non-restart owner
   shutdown precedes any later external-launcher cold start. Killing a job cannot
   repair a possibly inheritable handle retained by the parent. After every required
   handle derivation and every temporary-child close is positive, positively close the broad job source,
   broad process source, then broad thread source while the coordinator remains held.
   A nonpositive/uncertain source close quarantines that value, prevents resume, and
   enters the poison/failure path; it is never queried, reused, or reclosed. Before
   `ResumeThread`,
   prove the root belongs to the newly owned immediate leaf and every implicit/
   borrowed explicit parent; every configuration equals its template; the leaf alone
   has `ActiveProcesses == 1` and complete list `[root]`; and each parent complete list
   equals its sealed retained-handle-backed pre-create baseline plus the root. Provider
   launch therefore proves session `[providerRoot]` and outer `[owner,providerRoot]`;
   action launch proves action `[actionRoot]`, borrowed session
   `[providerRoot,actionRoot]`, and outer `[owner,providerRoot,actionRoot]`.
   Any uncertainty terminates only the newly owned leaf with exact-root fallback, then
   requires root signaled, leaf zero/empty, and every borrowed/implicit parent restored
   to its pre-create baseline. Any job/process/thread target derivation failure occurs
   before a broad-source close attempt, so every untouched broad source remains known
   cleanup authority. If all targets derive but a broad job/process/thread close is
   nonpositive or uncertain, that attempted value is quarantined permanently; no resume
   occurs, and cleanup uses only independently known derived handles, untouched broad
   sources, and exact-root fallback. Every case is pre-resume. Only after zero/baseline
   queries does RAII release positively still-owned temporaries and any derived assign-
   only handle; it never touches a release-outcome-quarantined resource. On derivation
   failure, it releases only known-live resources in manifest order; for the job object,
   any derived assign-only handle precedes the untouched broad source and job lifecycle
   last when present, or broad job source last when lifecycle derivation failed. It also
   closes known broad/derived process and thread handles without using a quarantined
   value. After source-close uncertainty it never touches that value, closes known
   derived handles without a last-handle claim, poisons the coordinator, and requires
   non-restart owner shutdown as the final fail-safe for process-owned raw OS/native
   resource cleanup without inferring any quarantined release. It never
   terminates or closes a borrowed owner/session job. Unproven
   removal poisons the coordinator and escalates to durable attention/non-restart owner
   shutdown rather than killing a borrowed parent in place. Every failure keeps the
   coordinator through terminate/wait, leaf-zero and parent-baseline proof, ordered
   known-resource cleanup/quarantine, and atomic poison/unavailability publication; only
   then may it release.
8. Require `ResumeThread(rootResumeThread) == 1`, proving the expected single
   `CREATE_SUSPENDED` count transitioned to runnable. Zero, greater than one,
   or `(DWORD)-1` makes execution state unknown; never assume suspension.
   Immediately follow the same owned-leaf termination/baseline-restoration path.
   Publish streams and the spawn receipt only after the exact-one result and positive
   close of that derived resume handle. A nonpositive/uncertain derived-handle close
   enters global quarantine, publishes nothing, terminates the owned leaf with exact-
   root fallback, restores parent baselines, and mandates poisoned non-restart shutdown.
   Only after positive close atomically publish the immutable spawn receipt and retained
   ownership of the lifecycle-job, least root-process lifecycle, and I/O handles for the peer lifetime;
   a provider session also retains its separate assign-only handle. The coordinator
   releases only after that publication.

`PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns the child as part of either qualified
process-creation entry point,
closing the race inherent in `spawn -> AssignProcessToJobObject`. Suspended
creation still matters because it permits positive membership/limit checks
before the child executes useful code.

After resume, a hostile root can create an unnamed inner job and self-assign through
its pseudo process handle. Windows exposes no outside handle/enumeration path for that
unnamed immediate job, so receipts claim exact retained PC-SDK ancestor/leaf
memberships and complete lists, not a total immutable post-resume job chain. This is an
explicit non-escape/denial-of-service residual: a self-created child job cannot remove
the root or descendants from no-breakaway PC-SDK ancestors, whose retained handles
still terminate the tree. CX-004 proves the self-nesting canary remains contained;
CX-005/008 separately deny cross-process assignment/handle effects. Forbidding self-
nesting would require a new enforceable OS boundary and product/security decision.

These ordinary addon leaf rules exclude the separately sealed bootstrap protocols.
Scrub→cold alone explicitly assigns the permanent outer job. Cold→Node inherits it and
proves transitional outer membership `[coldBootstrap,owner]` before resume; only after
witness/job handoff, source close, and exact bootstrap exit may owner prove steady
`[owner]`. Controlled restart proves each old-owner/bootstrap/new-owner transition.
Those protocols may terminate the permanent outer job on their defined uncertainties,
but generic leaf RAII never explicitly closes its protected process-lifetime handle.

### Normal explicit teardown receipt

Normal provider-session disposal first closes action admission under the process-
creation coordinator, settles every in-flight action create, proves all action jobs
disposed and no remaining assign-handle use, and positively closes the owned session
assign-only handle. An uncertain close poisons the coordinator, mandates non-restart
owner shutdown, and cannot report cleanup. Disposal then closes input. A later provider
contract may first attempt graceful protocol shutdown, but if the tree remains,
disposal calls abrupt `TerminateJobObject` through the newly owned lifecycle handle
rather than a synthetic
`SIGTERM`/`SIGKILL`.
`terminationMode: natural | graceful | job` records how termination occurred;
it cannot authorize cleanup. The addon holds the owned lifecycle handle while it:

- queries `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses == 0`;
- queries a complete `JOBOBJECT_BASIC_PROCESS_ID_LIST` and requires it empty;
- observes the exact root process handle signaled and captures its exact Windows
  exit code; and
- observes stdout/stderr EOF before closing remaining I/O/process and lifecycle handles.

A complete zero/root/EOF observation records
`cleanupProof: tree-exited`. Only that proof, paired with the exact root exit
code and positive closure of remaining I/O/process handles followed by the lifecycle
handle last, authorizes success. A bounded wait or query failure records
`cleanupProof: uncertain`, closes every remaining known-live I/O/process handle and then
the lifecycle handle for best-effort cleanup, and never claims zero. The provider-
session assign handle was already positively closed before this phase; other leaf types
never retained one. Any close uncertainty follows the poison/non-restart shutdown rule
rather than claiming no leak. Job
completion-port messages may improve diagnostics, but Microsoft says most such
notifications are not guaranteed and they cannot be the sole receipt.

Disposal while pipe work is pending atomically refuses new input and retains
native state until every outstanding read, write, and cancellation settles
exactly once. It cannot synchronously freeze the Node event loop, free state
before a native completion, emit a late/duplicate callback or post-settlement
byte, or authorize cleanup while a native I/O request or worker thread remains.
Failure or uncertainty is a typed terminal outcome, not EOF or success.

### Hard-kill receipt

`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` supplies the crash mechanism: Windows
terminates job members when the owning server's last job handle closes. The
proof must come from an external test harness that owns duplicated process
handles but not the job handle. Immediately before the kill it proves the root
and every deterministic descendant handle are unsignaled, fixture enumeration
is complete, and a heartbeat/marker is advancing. It then hard-kills only the
server owner, requires every retained handle to transition to signaled within a
bound, and confirms no marker advances afterward. A dead owner cannot
authoritatively receipt its own cleanup. This fixture proves only that the
deterministic descendant did not inherit the job handle. Microsoft documents
that `DuplicateHandle` supports Job handles and requires a process handle with
`PROCESS_DUP_HANDLE`; because kill-on-close fires only when the last job handle
closes, hostile same-user acquisition/retention is not mislabeled as CX-004
containment. CX-005 proves provider-root-to-owner/outside denials before credentials;
CX-008 revalidates them and adds lower/sibling/cross-tier directions.

## Node integration and toolchain decision

| Option | Strength | Cost/risk | Decision |
| --- | --- | --- | --- |
| Exact transient native cold-start/controlled-restart bootstrap | Establishes native code/install/postmortem trust before JavaScript, closed plain-Node owner launch, SF-001 lease transfer, in-job generation handoff, and outer owner job with zero steady-state helper | Second native PE, protected-install provisioning, deterministic compiled boot artifact, handoff/IPC/job/lease/restart build and failure matrices | Recommended as the sole bounded cold-start/restart exception |
| Repository-owned C++ Node-API full-spawn addon | Small direct Win32 surface; Node-API ABI stability; owns process/stdio/lifecycle atomically | Native review, node-gyp/MSVC, Windows CI, prebuild/integrity policy | Recommended |
| Existing pinned `better_sqlite3.node` owner dependency | Already required for SQLite; exact explicit lazy-load/factory seam can remove ambient binding resolution | Privileged third-party PE; protected provenance/load closure, final-PE disposition, exact package-copy/cache identity, and verified-prebuild/source-build qualification on every DB constructor path | Retain only as a separately admitted owner-TCB dependency |
| Rust with napi-rs | Strong language safety and packaging ecosystem | Larger dependency/toolchain surface for a narrow Win32 binding; still needs unsafe FFI and prebuilds | Rejected for this slice |
| Third-party job addon | Potentially less code | No package market scan was performed or claimed; owner selection does not rely on one. Any future candidate needs exact name/version/license/source plus full-spawn/stdio/teardown audit | Deliberately deferred |
| Node `child_process.spawn` then native assign | Familiar streams | Child can execute/spawn before assignment; Node exposes no public suspended-process/Win32-handle adoption API | Rejected |
| General PowerShell/C#/native relay, helper, broker, or supervisor | Can call Win32 outside Node | Adds a continuing lifecycle/relay/parent-watch authority and cannot transfer complete process/stdio/action ownership under the selected contract; unlike the exact bootstrap, it retains steady-state authority | Rejected |
| `taskkill /T`, PID enumeration, parent polling | No compiler | Racy, PID-reuse prone, incomplete after reparenting/root exit, and cannot prevent initial escape | Rejected |

The addon should use stable Node-API through the official C or header-only C++
API, not V8 or undocumented libuv/process bindings. Target `NAPI_VERSION=8`
unless a demonstrated requirement needs 9, and pin node-gyp/header/build
inputs. Local host inspection reports Windows 11 Pro 25H2
`10.0.26200.8655`, client product type (`VER_NT_WORKSTATION` equivalent), and
AMD64. The local host also has Visual Studio Build Tools 2022 17.13.2, MSVC
19.43.34808, MSBuild
17.13.15.12501, and Windows SDK 10.0.22621.0 available after activating its x64
developer environment. Repository CI cannot currently test Windows. These facts
prove prerequisites, not a successful addon build or floor-runner provenance.

Recommended delivery policy:

- implement one exact qualified Windows 11 25H2 x64 client full-revision/UBR/
  identity tuple within base build `10.0.26200` first behind a provider-neutral
  contained-process port. Runtime admission must equal it; every identity delta/
  other host is typed unsupported until full CX-004 requalification, with no
  assignment fallback;
- require the full admitted-path source-build/hard-kill matrix on a pinned,
  disposable build-26200 client runner. A repository-owned native probe must
  positively report `VER_NT_WORKSTATION`, AMD64, and `10.0.26200`; CI records
  the exact full revision/UBR and immutable VM/image provenance/digest pinned in
  the CX-004 contract before implementation and fails on any mismatch. The same
  sealed admission-checkable identity/provenance gates production runtime.
  `windows-latest` is an independently observed, always non-admitted lane that
  runs source-build plus the public typed-unsupported contract. If its identity
  ever matches the admitted tuple, fail for an explicit runner-policy decision
  rather than silently admit the label. Retain Ubuntu CI for the same
  unsupported behavior;
- admit the native build explicitly in pnpm rather than relying on hidden
  install scripts;
- produce an exact deterministic precompiled server boot artifact and complete
  JavaScript/source-map/loader/package/native-load manifest. Admitted cold start and
  restart invoke exact protected `node.exe` directly; shell/package-manager/tsx/
  esbuild/source-loader/ambient-preload paths remain typed non-admitted;
- source-build both native artifacts during development from pinned inputs and seal
  both complete native-load/final-PE hardening closures plus shared-core equivalence
  or independently qualified divergence;
- qualify the exact pinned `better_sqlite3.node` as a third privileged PE, enforce one
  owner SQLite factory with the admitted binding on every constructor, seal package-
  copy/cache identity, ban SQLite extension loading, disable/exclude pinned `ws` optional
  native accelerators, and close the owner native-load inventory for its full lifetime;
- close every repository and dependency-owned process-spawn surface reachable from the
  admitted bootstrap/owner runtime under its sealed bootstrap edge or native
  coordinator; keep the external N7 UI launcher/browser explicitly separate; include
  replacement/elimination of the pinned Claude SDK's default
  provider-spawn and `reg.exe` helper edges plus both MCP stdio SDK/cross-spawn paths;
- before one-click distribution, publish/package integrity-verified Node-API
  prebuilds plus their immutable loader/provenance manifest so the user's machine
  does not need compilers; and
- let CX-004 fake-provision the code-integrity/owner-nonwritable install/postmortem
  baseline only inside its pinned disposable runner. Production stays unavailable
  until a separate provisioning/packaging/N7-launcher-lifecycle decision; no installer/elevation, WDAC/
  AppLocker mutation, or runtime self-ACL sealing is authorized here; and
- report non-Windows and unbuilt architectures as typed `unsupported`, with no
  general helper, taskkill, direct-spawn, or uncontained fallback.

### Required CX-004 proof matrix

The native primitive is not accepted on the strength of code review alone. The
normative contract is `docs/execution/slices/CX-003.md`; this minimum matrix cannot
narrow any later-added invariant or failure edge. Windows tests must prove:

1. a fixture whose first instruction starts a grandchild is already contained
   across repeated runs;
2. a grandchild remains in the job after its root exits, then reaches zero on
   tree termination;
3. `CREATE_BREAKAWAY_FROM_JOB` is refused and creates no outside marker;
4. a child-created nested job remains beneath and dies with the PC-SDK job;
5. the inner job works while the harness is already in a CI-like outer job;
6. an incompatible outer-job case fails before resume and leaves no marker or
   process;
7. normal termination proves root exit, stdout/stderr EOF,
   `ActiveProcesses == 0`, and an empty complete process-id list;
8. an external witness first proves the root and every deterministic descendant
   handle are unsignaled, fixture enumeration is complete, and a heartbeat/
   marker is advancing. Without holding the job handle, it then hard-kills only
   the Node owner, requires every retained process handle to transition to
   signaled within a bound, and proves no marker advances afterward;
9. exact handle inheritance prevents the deterministic descendant from
   inheriting the job handle. This does not claim denial of hostile cross-process
   handle acquisition, out-of-job parent spoofing, cross-process execution/
   control, or memory/token/security-descriptor access to a privileged same-job
   peer. CX-005 proves every provider-root-to-owner/outside direction before
   credentials; CX-008 revalidates it and adds lower/sibling/cross-tier directions;
10. while the child stdio handles are temporarily inheritable, concurrent
     unrelated process-spawn calls serialize through the audited coordinator and
     cannot inherit them, hold EOF open, or gain a job handle; static/dependency
     guards reject uncoordinated worker/native spawning. The pinned Claude SDK's
     default provider-spawn and managed-settings `reg.exe` edges are eliminated or
     full-spawn-qualified; both MCP stdio `StdioClientTransport`/`cross-spawn` paths
     use the qualified replacement or remain unavailable; and an upgrade adding any
     edge fails the closed inventory;
11. the generated closed native-resource manifest drives exhaustive owner/borrower/no-
    release and release-fault matrices. Its handle floor includes transient bootstrap source/control/event/
    thread/process/job/pipe handles; generic broad job source; every broad
    `PROCESS_INFORMATION` process/thread source and derived handle; child-side temporary
    stdio; primary thread; provider-session assign/lifecycle; action/transition/Git
    lifecycle; target/caller/root token handles; retained process/I/O; isolated window-
    station/desktop handles through `CloseWindowStation`/`CloseDesktop`; and any selected
    in-process registry handle through `RegCloseKey`. Every manifest-listed opaque
    release site receives type-appropriate fault proof. Borrowed sites prove never-
    release plus owner liveness. No-release/pseudo sites prove stable documented
    identity and no release call or effect under exact wrapper/static/PE guards. For
    every owned site a qualification-only wrapper
    injects before-call failure and underlying-release-succeeded/report-uncertain,
    including APIs whose only documented success is no-failure normal return. For each
    recyclable numeric handle, that shim reissues the exact same-process numeric
    value to an externally witnessed benign same-domain canary within a sealed bound,
    and proves class-specific identity/validity plus unsignaled state where waitable
    while the stale slot is never queried/used/waited/reclosed. Failure to demonstrate
    exact-value reuse is inconclusive, never pass. Opaque/non-numeric resources use a
    type-specific reuse/liveness/release canary, not a numeric-ABA claim. No receipt or success
    publishes; the applicable independent watcher/job/root fail-safe fires; and process
    exit is the final fail-safe for process-owned raw OS/native resource cleanup without
    inferring a quarantined release. The primary-thread case proves no receipt after
    `ResumeThread == 1` unless close is positive. Owner-addon cases poison before
    coordinator release, every later spawn fails typed without an OS process call,
    controlled restart is forbidden, and durable attention/non-restart shutdown follows;
    transient cases take their sealed non-success/termination/exit path;
12. two concurrent jobs are isolated when one is terminated;
13. repeated cycles do not grow owner handle/thread counts;
14. argv round-trips cover empty, spaces, quotes, trailing backslashes, Unicode,
    quoted exact-path `argv[0]`, and literal
    `cli_auth_credentials_store="file"`; relative/search paths, NUL, empty or
    `=`-containing environment names, and case-colliding keys fail before create;
15. canonical cwd and the sorted double-NUL UTF-16 environment round-trip
    exactly without ambient inheritance;
16. injected set/query/create/terminate/I/O failures fail closed and cannot
    mint a receipt;
17. injected `ResumeThread` results of zero, greater than one, and `(DWORD)-1`
    all terminate only the newly owned leaf with exact-root fallback and unwind
    without publishing streams or a receipt. The zero-return fixture is actually
    resumed first and may spawn a descendant before the guarded call proves the
    unknown-state path contains it; leaf zero/empty and exact borrowed/implicit parent-
    baseline restoration are required;
18. simultaneous stdout and stderr round-trip byte-exact arbitrary/binary data
    across adversarial split and coalesced chunk boundaries without cross-stream
    corruption or ordering claims between the independent streams;
19. stdin proves partial writes, backpressure/drain, close/EOF, and broken-pipe/
    error behavior, with EOF, I/O failure, and teardown reported as distinct
    typed outcomes. Pending/queued stdin bytes remain within the per-direction
    and combined native/JS bounds pinned before implementation; excess input is
    rejected/backpressured without unbounded queue growth;
20. simultaneous high-volume stdin/stdout/stderr traffic larger than every pipe
    buffer completes without deadlock or directional starvation while an
    independent timer proves the Node event loop remains responsive;
21. pausing each output consumer separately keeps that direction and the total
    stdin/stdout/stderr native/JS buffering within the per-direction/combined
    byte bounds pinned in the CX-004 contract before implementation,
    backpressures the corresponding child writer without starving the other
    stream or event loop, and resumes byte-exactly;
22. a mid-flight teardown fixture first positively saturates/pends stdin,
    stdout, and stderr, including a paused output consumer, then disposes/
    terminates. Within the settlement timeout pinned in the CX-004 contract, an
    independent event-loop timer keeps advancing;
    every stream and queued write settles exactly once with one typed terminal
    outcome; no callback or byte arrives after settlement; pending native I/O
    and worker-thread counts reach zero; and tree/handle cleanup still passes;
23. a queried job-limit fixture contains nonzero accounting/peak telemetry. The
    implementation admits it by comparing only the selected sealed template's
    exact `LimitFlags` and fields enabled by those flags; a missing or unsealed
    extra flag fails, and accidental whole-structure equality cannot pass; and
24. the admitted matrix's native probe matches `VER_NT_WORKSTATION`, AMD64, base
    build `10.0.26200`, and the exact full revision/UBR plus immutable image
    provenance/digest sealed in the CX-004 contract before implementation.
    Production runtime must equal the sealed admission-checkable OS/security-
    component identity; any delta is unsupported pending full requalification.
    `windows-latest` independently records its observed identity as an always
    non-admitted lane and returns typed unavailability without invoking
    `node:child_process`, an admission override, or another fallback. An identity
    match fails for explicit runner-policy review instead of changing admission;
    and
25. each transient mode arms its noncancelable independent hard self-deadline. The
    CX-004 internal entry-scrub fixture is positively unjobbed; after watcher arm, main
    creates/configures/queries and publishes the sole outer-job handle with watcher ack
    before child create. Scrub→cold then uses the exact challenge channel, initially
    nonsignaled two-phase auto-reset event, parent lifecycle, atomic `JOB_LIST`, post-
    ready job target return, cold protect/query/publication, phase-two ack, all-watcher-
    handle retirement, protected-source clear/query/close, and exact-success parent
    exit. Event phase two is
    causally impossible before the post-phase-one target, so signals cannot collapse.
    Direct/replay/already-jobbed/inherited-handle/redirection/death/hang cases cannot
    reach SF-001; from positive scrub-watchdog arm they leave no helper. N7 create-to-
    arm crash/death/hard-kill remains explicitly unqualified, production unavailable,
    and topology-unfrozen for the separate N7 decision. Hang injection covers outer-
    job create/configure/query/publication; child create→ready; duplicate→delivery/
    query/publication/ack; cleanup-handle retirement/protected-source clear/query/close/
    success exit; and
    cold/controlled validation, parent wait, image/job/witness/owner creation, and every
    later handoff. Admitted `cold-bootstrap` wins SF-001 exactly once, immediately
    protects/queries/publishes its witness, full-spawns exact sealed `node.exe` against
    the protected deterministic precompiled boot entry by implicit outer inheritance,
    proves transitional `[coldBootstrap,owner]`, transfers witness then job at the
    defined linearization points, retires every watcher-visible handle, clears/queries/
    closes transient protected sources, obtains exact success exit, and proves steady
    `[owner]`. On cold start SQLite remains closed until that exit with no witness/job
    lease gap. No shell/package-
    manager/tsx/esbuild/source-loader/preload process or module executes before addon;
    the current source-run path is non-admitted. Concurrent-launch/death/hang/failure
    injection passes at every handoff edge before product state. Every handle
    duplicate uses its explicit least mask, noninherit, and `dwOptions == 0`; SAME-
    ACCESS/CLOSE-SOURCE negative canaries pass;
26. the deterministic boot JavaScript/source-map/loader/package/native-load manifest;
    both repository PEs; exact Node; and the pinned SQLite package/binary/install roots,
    ancestors, imports, and delay-load closures equal the seal before each load.
    Mutable search is absent, substitution/swap-back/load-execute-unload fixtures
    cannot execute a marker; preventive gates admit the exact sealed Node/system
    closure and, among optional non-host/non-system/application-native mappings, only
    owner addon then SQLite for the owner's entire lifetime. Runtime enumeration only
    corroborates;
27. both repository final-PE mitigation profiles, warnings/static analysis, sanitizer/
    property/fuzz lanes, and every checked argv/env/content/I/O/IPC/receipt limit pass;
    separately, the exact SQLite final PE, provenance, package-copy/cache singleton,
    owner factory on every DB constructor, extension-load denials, pinned `ws` optional-
    native absence/disable, and source-build/verified-prebuild matrix pass without
    ambient `bindings` resolution. Zero/
    bound/+1, huge/wrap-shaped, allocation-failure, Unicode/NUL, and fragmented/
    coalesced-frame fixtures fail or pass exactly before any OS mutation;
28. the native SF-001 pipe binds exact name/server handle, first/local/one-instance
    flags, protected owner/group/DACL/`OWNER RIGHTS`/mandatory policy, and zero
    legitimate clients. Desired-access-zero, query/`FILE_READ_ATTRIBUTES`, generic
    read/write, ACL-relax, create-instance, and server-handle duplicate/inherit/
    retain canaries fail for every fake root/lower/transition/Git role; owner hard-
    kill then permits exact successor acquisition. Client-only orphan behavior is
    measured, never inferred;
29. same-token `CreateProcessW` and restricted-token `CreateProcessAsUserW` both pass
    the identical suspended `STARTUPINFOEX`/ordered-job-list/handle-list matrix with
    atomic explicit process/primary-thread object descriptors, exact zero
    `JobObjectBasicUIRestrictions` for every nested job, exact mitigation/no-
    child/security-capabilities attributes, and protected noninteractive isolated
    station/desktop/`lpDesktop` policy. Target primary-token
    rights/state, caller-token access, session equality, restricted-token waiver,
    privilege behavior, and no-elevation/no-logon/no-profile/no-fallback outcomes are
    exact, with failure injection before every OS effect;
30. the permanent protected outer owner job and SF-001 witness survive normal owner
    operation, reject explicit/addon-finalizer/early close, and close only at process
    teardown. Graceful non-restart shutdown proves inner-job/I/O/lease zero, durable
    exit state, contender refusal during drain, prior-owner reconciliation, and an
    external hard-kill successor result;
31. controlled restart passes the exact old-owner→live-bootstrap→new-owner protocol
    inside the unchanged outer job: pre-resume security/membership; ready-before-
    witness/job duplication; local protect/query; durable prepared/committed/aborted
    CAS; commit-receive linearization; old-owner lifecycle handle; bounded challenge-
    bound transfer of the exact committed nonce/old-generation/new-generation/digest
    tuple with wrong/stale/replay rejection; successor-admitted ack bound to that tuple;
    dedicated admission-SQLite handoff while bootstrap remains; exact bootstrap exit;
    only then product-DB CAS of that exact expected record to `completed`;
    membership `[oldOwner,restartBootstrap] → [restartBootstrap] →
    [restartBootstrap,newOwner] → [newOwner]`; generation/no-overlap; cold recovery;
    owner-lifecycle row-plus-outbox atomicity/idempotent replay and sealed SQLite
    journal/synchronous/checkpoint/power-loss semantics; live-hang refusal versus
    crash/death successor acquisition; and every create/
    resume/duplicate/record/send/receive/ack-loss/death/hang/SQLite/product-DB/CAS
    failure edge; and
32. bootstrap/precompiled-boot/owner-addon/SQLite-load/posture windows inject crash,
    fast-fail, hang, report/dump/JIT/
    monitor/recovery/restart calls, and diagnostic/content-inspection canaries before
    protected input. Every unknown OS/image/install/load/postmortem or sink outcome is
    unavailable, and production boot remains non-destructive.

PID identity alone is diagnostic. The complete job-bound process-id list is a
receipt only when combined with the exact retained process handles, job
membership, accounting, and empty-list proof, so PID reuse cannot counterfeit
absence.

## Accepted product decision

The product owner accepted all three choices below together on 2026-07-13:

1. Accept the exact repository-owned transient native cold-start/controlled-restart
    bootstrap plus C++ Node-API addon; internal scrub→cold and old-owner→restart pre-arm
    containment plus noncancelable per-mode hard self-deadlines; and the same-PE non-
    authoritative `entry-scrub`→hard-gated `cold-bootstrap` protocol. CX-004 requires a
    positively unjobbed scrub, independent watcher arm, main-path outer-job create/
    configure/query/publication with watcher ack, atomic cold assignment, causal two-
    phase ready/job-target/ack handoff, all-watcher-handle retirement, protected-source
    clear/query/close, exact-success parent exit, and extra-job refusal. Production
    remains unavailable until a separate N7 launcher-lifecycle decision supplies a
    crash-race-safe kernel anchor for create→scrub-watchdog-arm, exact death/hard-kill/
    handoff proof, and requalification of any changed outer-job topology; a retained
    process handle alone is insufficient. Keep pre-
    existing same-user malware racing the scrub child-handle window explicitly
    outside the descendant-origin threat and requiring a separate OS-trusted launch-
    anchor decision if selected; the no-
    fallback same-token `CreateProcessW`/
    restricted-token `CreateProcessAsUserW` family with implicit/borrowed/new-leaf job
    ownership, the provider-session-only lifecycle-plus-assign-only handle pair and
    assign-first/lifecycle-last teardown, exact parent-baseline cleanup, global per-
    resource release-state/quarantine with exhaustive release-fault and, where
    applicable, non-vacuous exact-numeric-value ABA proof, and
    zero PC-SDK-job UI restrictions;
    accept hostile post-resume self-nesting only as the contained denial-of-service
    residual above, not an exact total-chain receipt; atomic process/thread descriptors;
    exact plain sealed `node.exe` plus deterministic protected precompiled JavaScript
    boot artifact/manifest, with every shell/package-manager/tsx/esbuild/source-loader/
    ambient-preload path non-admitted; a closed admitted bootstrap/owner-runtime
    transitive process-spawn inventory, with external N7 UI launcher/browser separate,
    that replaces/eliminates the pinned Claude SDK and MCP stdio spawn edges;
    the protected no-client pipe; cold SF-001/owner-job handoff and in-job old-owner→
    bootstrap→new-owner restart state machine; both complete pre-load native-
    dependency/loader closures plus a full-lifetime native-load gate; the exact pinned
    `better_sqlite3.node` provenance/load/final-PE/prebuild/package-copy/cache identity
    and owner factory on every DB construction, SQLite extension-load denial, and
    pinned `ws` optional-native absence/disable; native hardening/input-bound ownership;
    and one exact
   qualified Windows 11 25H2 x64 client full-revision/UBR/identity tuple within base
   build 26200. Require
   a pinned admitted-path/hard-kill runner with exact native/image proof, production
   runtime equality to the sealed admission identity, independent observed-
   identity non-admitted `windows-latest` tests, and typed unsupported behavior on
   every identity delta/other host until full CX-004 requalification. CX-004 may
   fake-provision the protected OS/image/install/postmortem baseline only in its
   disposable VM. Production remains unavailable pending a separate provisioning/
   packaging/N7-launcher-lifecycle decision; this authorizes no installer, elevation, WDAC/AppLocker
   mutation, runtime self-ACL seal, long-lived helper, or supervisor.
2. Wait for and deliberately upgrade to a later stable Codex release that can
   produce the complete effective-policy admission receipt, quiescent two-step
   admission barrier, and immutable policy epoch. Reject a Codex fork,
   experimental protocol, alternate SDK/exec wire or raw API path as a bypass
   for these gates, and weaker detect-and-abort substitutes. Future evaluation
   of a governing-doc-authorized SDK/exec wire must satisfy the same gates.
3. Require an independently verified, attempt/selection/thread-bound receipt
   with an exact all-origin empty external-action inventory, approval requests
   disabled, and unknown/unapproved actions always denied for the first live
   gate and its immutable epoch.

## Follow-on gates

- **CX-004:** fake-only provider-neutral same-PE internal entry-scrub/cold-bootstrap gate
  from positive scrub-watchdog arm on a provably unjobbed runner, scrub→cold and old-
  owner→restart pre-arm containment, every transient-mode hard self-deadline, and phase-
  complete hang/parent-exit canaries. It records N7 create→arm as unqualified,
  production-blocking, and topology-unfrozen; proves ordinary owned-leaf/borrowed-parent
  cleanup and the contained hostile self-nesting residual;
  cold-start and controlled-restart bootstrap/
  SF-001 protected no-client pipe/outer-owner-job handoffs plus the same-token/
  restricted-token full-spawn family; exact plain-Node protected precompiled boot
  artifact/manifest with no pre-addon shell/package-manager/tsx/esbuild/source-loader,
  unlisted spawned process, or optional non-host/non-system native mapping; full-
  lifetime owner-native-load gate allowing the exact sealed Node/system closure and,
  among optional application-native mappings, only owner addon then exact pinned
  `better_sqlite3.node`; one injected SQLite factory
  for every DB construction plus extension-load denial; pinned `ws` optional-native
  absence/disable; closed admitted owner-runtime transitive dependency-spawn inventory
  including Claude SDK
  and MCP stdio edges; compiler/
  linker/final-PE/static-analysis/sanitizer/fuzz/input-bound matrices; byte-exact full-
  duplex stdio and bounded backpressure/high-volume/event-loop/pending-I/O teardown;
  all cold/restart/load/postmortem failure injection; one exact pinned Windows 11 25H2
  x64 client full-revision/UBR/admission-identity tuple within base build `10.0.26200`;
  independent non-admitted `windows-latest` identity/unsupported CI; and non-vacuous
  pipe/job hard-kill successor witnesses. It emits a fake lab qualification receipt,
  never production protected-install admission.
- **CX-005:** after positive CX-004 lab qualification, offline static schema/source
  review may first prove a later
  pinned stable release plausibly exposes the required closed-world policy,
  two-step admission, and immutable-epoch semantics. Before any provider process,
  login-home access, or provider invocation, a separately approved production
  bootstrap/protected-install provisioning receipt for the exact current host/build
  must be fresh. It binds the exact plain-Node precompiled boot artifact and no-pre-
  addon execution, owner-addon/`better_sqlite3.node` order and full-lifetime native/
  SQLite-factory/extension-denial/optional-native/process-spawn closures, protected
  SF-001 pipe, cold/restart outer-job
  handoffs/state/recovery, full-spawn family, load/postmortem posture, and exact host/
  build identity; no fake VM receipt substitutes. Then credential-free evidence
  chooses the root TCB-versus-
  broker mode and positively qualifies the root executable/config/auth separation,
  shared-home fencing, and—without deferral to CX-008—every root-applicable
  attester/raw-effective-token/privilege-removal/self-access, non-DACL self-tamper,
  child/UI/job/IPC/owner-vault/network/capability-export, executable/load-closure,
  1:1 topology/exact sole-PC-SDK-holder session handle pair/membership/limit, durable-
  recovery, and preventive-
  filesystem/created-object/WER/diagnostic/audit/content-inspection and resource
  invariant/canary in the active contract. It reruns the composed CX-004
  matrix with exact qualification-sealed job-template expectations. Only a
  positive root-trust/broker-and-OS receipt permits the contained binary/version
  confirmation, schema generation/review, initialize/config/account/model/
  warning admission, and no-turn policy handshake. Re-run CX-002 mapping/static
  conformance on the regenerated schema and seal complete CX-001/CX-002
  requalification before admitting a quarantined thread. Never reuse the
  CX-001 direct spawner; no inference.
- **CX-006:** contained, disposable, unregistered native subscription/session/
  dispatch conformance after CX-004/CX-005 and the root-trust/broker-and-OS receipts
  are positive. Prove exact ChatGPT
  subscription and no-raw-API billing provenance, account/model/effort
  usability, native workspace/plan/service-tier stability, unchanged-identity
  token refresh and drift fencing, warning-stop behavior, first turn/
  continuation/interruption, immutable empty-action policy, and canonical
  adapter dispatch. Context proves exact/derived/approximate/unavailable
  confidence plus compaction. Subscription usage separately proves native used/
  remaining semantics, normalization to used, window, observation time,
  runtime/account attribution, staleness, confidence, and unavailable
  degradation.
- **CX-007:** provider-free in-memory/non-process external-action/tool/approval
  policy compilation and consumer-specific MCP compilation, with no server,
  connection, or tool call. Bind the compiled bridge/provenance digest to the
  receipt. The digest covers effective server identity/config/provenance/
  connection state, tools, resources, resource templates, prompts, and
  instructions, with explicit absence where PC-SDK exposes tools only.
  Approvals are exact action/argument-attributed; session-wide and exec/network
  policy amendments are forbidden. Canonical descriptors for shell/exec, process-
  spawning MCP, setup/readiness/verification, repository scripts, and broker-
  denial fixtures may exist only as inert compiled data; executing them, starting
  a server/process/connection, or making a tool/broker call is excluded. No real
  project mutation.
- **CX-008:** make the explicit OS process/security-boundary decision, revalidate
  every CX-005 provider-root guarantee without narrowing, and add lower/sibling/
  standalone provider-auth-credential-free transition/restricted-Git composition.
  Qualify exact attester; raw/effective tokens and non-revertible self-security;
  process/thread/token/job/handle/IPC/child/Win32k/UI boundaries; executable/config/
  parser/native-load and full-spawn closure; diagnostic/WER/audit and content-
  inspection residuals; provider generation/prior-zero; owner/session/action/
  transition/Git hierarchy; exact private-volume/path/stream/alias/created-object
  semantics; capability export; per-target durable recovery; and preventive per-lane/
  global resource budgets. Git delivery is exactly restricted candidate creation →
  memory-safe owner verifier → verified-byte owner promotion/files-ref CAS, with exact
  format/backend restrictions and disposable abrupt-reset/power-loss proof. Stable
  transition/Git templates, implementations, recovery epochs, and positive no-active-
  instance state are qualification facts; each actual generation/process/job remains
  per-call. The initial lower template is leaf-only and network-empty; process-spawning
  parity needs a separately accepted mediated-child or stronger-isolation topology.
  Every required pair gets a matched differential or positive ambient-inaccessibility
  result, subject only to the exact accepted root TCB residual. The pinned VM identity,
  full composed CX-004 matrix, post-state, cleanup, and VM teardown all pass. No real
  credential/data/project is used or mutated.
- **CX-009:** require positive CX-006, CX-007, and CX-008 receipts, then obtain a
  fresh provider-originated quiescent all-origin complete admission receipt/new
  epoch before activation. Its policy/provenance digest must equal the sealed
  CX-007 compiled-policy/provenance digest, and its disclosed effective action/
  MCP inventories must equal the sealed inventories committed by that digest.
  A fresh independently attested CX-008 deployment receipt contains without omission
  the production plain-Node/bootstrap/full-spawn/protected-pipe/outer-job/controlled-
  restart facts; owner-addon/SQLite/load/postmortem/native/process-spawn closure;
  provider generation/prior-zero; root-trust/broker/shared-home; and every root/lower/
  transition/Git token, executable, diagnostic, inspection, filesystem, protected-
  target, export, resource, recovery, IPC, lifecycle, hierarchy, and attester fact.
  It also binds the exact Git version/format/files backend/restricted-parser/owner-
  verifier/promotion/ref-CAS/durability digests and stable standalone transition/Git
  templates, implementations, recovery epochs, and positive no-active-instance state.
  Each actual action/transition/Git/mediated-child generation/process/job is admitted
  only by its independent per-call pre-first-instruction receipt. While both receipts
  are current/quiescent, a challenge-bound PC-SDK composite CAS verifies every current/
  qualification-equality field, the CX-007 mapping, zero unresolved leases, and no
  oversubscription before any action initializes. Unknown/stale/mismatched/drifted
  facts fence or quarantine. After positive process-spawning-topology proof, exercise
  deterministic disposable action/tool/MCP and transition parity plus hostile OS/Git
  fixtures. In a synthetic repository prove restricted Git candidate → memory-safe
  owner verifier → verified-byte owner promotion/files-ref CAS and exact snapshot/
  commit/tree/parent/scope/secret receipt bound to composite/action identities. No real
  project mutation.
- **CX-010:** require positive CX-006 through CX-009. Before any action/mutation,
  obtain a new provider-originated quiescent complete admission epoch bound to
  CX-010's exact selection, attempt, and thread; its policy/provenance digest and
  disclosed inventories must equal the positively proven sealed CX-009 policy/
  digest/inventories. Also require a fresh CX-008 deployment receipt containing every
  current/equality field required by CX-009, freshly bound to the exact host/image,
  selection, app/provider session, owner/root/session jobs, action queue, generations,
  attempt, and thread. A new challenge-bound composite CAS re-verifies every mirrored
  production bootstrap/load/pipe/restart/hierarchy/generation, trust, token, diagnostic/
  inspection, filesystem/target/export, recovery/resource, IPC/lifecycle, standalone-
  transition/Git, exact Git format/backend/parser/verifier/promotion/CAS, cross-digest,
  and qualification fact before mutation. Every actual new process remains per-call
  receipted; no lab/prior-attempt evidence substitutes. Drift fences or quarantines.
  Only then run the isolated specialist mutation. After positive lower cleanup and
  lease revocation, delivery uses only the qualified restricted Git candidate → owner
  memory-safe verifier → verified-byte promotion/files-ref CAS split. Verified landing
  requires its fresh snapshot/commit/tree/parent/scope/secret/CAS receipt bound to the
  current composite and action evidence. Then guarded landing and teardown.

No CX-003 finding promotes a requirement or authorizes native execution.

## Primary references

- Microsoft, Windows 11 release/build identity:
  <https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information>
- Microsoft, Job Objects:
  <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>
- Microsoft, `DuplicateHandle` and `PROCESS_DUP_HANDLE`:
  <https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle>
- Microsoft, process access rights including `PROCESS_CREATE_PROCESS`:
  <https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights>
- Microsoft, `ReadProcessMemory`:
  <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory>
- Microsoft, `OpenProcessToken`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken>
- Microsoft, access-token object rights:
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/access-rights-for-access-token-objects>
- Microsoft, removed versus disabled token privileges:
  <https://learn.microsoft.com/en-us/windows/win32/secbp/changing-privileges-in-a-token>
- Microsoft, security-information fields and access requirements:
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information>
- Microsoft, access checks, token queries, token-information classes, and object
  security-descriptor queries:
  <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck>,
  <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo>
- Microsoft, current-process pseudo-handle rights:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getcurrentprocess>
- Microsoft, `SetSecurityInfo` and object DACL replacement:
  <https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo>
- Microsoft, thread security and access rights:
  <https://learn.microsoft.com/en-us/windows/win32/procthread/thread-security-and-access-rights>
- Microsoft, `ImpersonateLoggedOnUser` token requirements:
  <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-impersonateloggedonuser>
- Microsoft, parent-process job inheritance and `PROCESS_CREATE_PROCESS`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>
- Microsoft, child-process policy fields:
  <https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_process_mitigation_child_process_policy>
- Microsoft, queried Win32k system-call-disable policy:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-process_mitigation_system_call_disable_policy>
- Microsoft, `CreateRemoteThread` cross-process rights:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createremotethread>
- Microsoft, parent-process job inheritance example:
  <https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812>
- Microsoft, `UpdateProcThreadAttribute` and
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>
- Microsoft, `CreateProcessW`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw>
- Microsoft, DLL search order and DLL preloading security:
  <https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order>
  and
  <https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-security>
- Microsoft, process mapped-name query returns a name:
  <https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getmappedfilenamea>
- Microsoft, default DLL-directory restriction:
  <https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-setdefaultdlldirectories>
- Microsoft, `ResumeThread`:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread>
- Microsoft, `AssignProcessToJobObject`:
  <https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject>
- Microsoft, process creation flags:
  <https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags>
- Microsoft, nested jobs, ambient membership/query limits, pseudo self handles, and Job
  Object access:
  <https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs>,
  <https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob>,
  <https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getcurrentprocess>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/procthread/job-object-security-and-access-rights>
- Microsoft, Job Object accounting:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information>
- Microsoft, Job Object active-process/memory/time limit fields:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information>
- Microsoft, Job Object UI restrictions:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_ui_restrictions>
- Microsoft, `JOBOBJECT_BASIC_PROCESS_ID_LIST`:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list>
- Microsoft, job completion-port notifications:
  <https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port>
- Microsoft, `TerminateJobObject`:
  <https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject>
- Microsoft, `WSADuplicateSocket` protocol-info transfer and lack of access control:
  <https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsaduplicatesocketw>
- Microsoft, legacy non-NT DXGI shared handles:
  <https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiresource-getsharedhandle>
- Microsoft, COM interface marshaling:
  <https://learn.microsoft.com/en-us/windows/win32/api/objidlbase/nf-objidlbase-imarshal-marshalinterface>
- Microsoft, handle flags and process termination semantics:
  <https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-sethandleinformation>,
  <https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-gethandleinformation>,
  <https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process>
- Microsoft, restricted-token process creation and token rights:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw>,
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens>,
  <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/access-rights-for-access-token-objects>
- Microsoft, process-creation attribute-list initialization, mitigation/child/
  AppContainer/job attributes, and post-create mitigation query:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-initializeprocthreadattributelist>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-deleteprocthreadattributelist>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessmitigationpolicy>
- Microsoft, `STARTUPINFO.lpDesktop`, process window stations, desktops, and their
  object security and type-specific close APIs:
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow>,
  <https://learn.microsoft.com/en-us/windows/win32/winstation/process-window-station>,
  <https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-and-desktop-security>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-closewindowstation>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-closedesktop>
- Microsoft, registry-key handle close:
  <https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regclosekey>
- Microsoft, security descriptors, mandatory integrity control, and the `OWNER
  RIGHTS` well-known SID (`S-1-3-4`):
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptors>,
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control>,
  and
  <https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers>
- Microsoft, protected named-pipe creation/security/connect/info/client-open/
  disconnect behavior:
  <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew>,
  <https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights>,
  <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe>,
  <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-getnamedpipeinfo>,
  <https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client>,
  <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe>
- Microsoft, bootstrap one-shot pipe, two-phase event, and parent identity/lifetime
  proof:
  <https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createpipe>,
  <https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createeventw>,
  <https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-setevent>,
  <https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createthread>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessid>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess>,
  <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject>
- Node 22.13/libuv, pinned Windows pipe create/listen/open behavior:
  <https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/pipe.c#L541-L550>,
  <https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/pipe.c#L778-L794>,
  and
  <https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/pipe.c#L1143-L1195>
- Pinned owner-dependency source for SQLite lazy binding/extension loading and `ws`
  optional native acceleration:
  <https://github.com/WiseLibs/better-sqlite3/blob/v11.10.0/lib/database.js#L36-L55>,
  <https://github.com/WiseLibs/better-sqlite3/blob/v11.10.0/lib/methods/wrappers.js#L18-L20>,
  <https://github.com/websockets/ws/blob/8.21.0/lib/buffer-util.js#L115-L129>,
  and
  <https://github.com/websockets/ws/blob/8.21.0/lib/validation.js#L142-L151>
- Microsoft, ordinal comparison, Unicode normalization/conversion, and environment
  blocks:
  <https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringordinal>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-normalizestring>,
  <https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-multibytetowidechar>,
  <https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-widechartomultibyte>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables>
- Microsoft MSVC native hardening and analysis:
  <https://learn.microsoft.com/en-us/cpp/build/reference/gs-buffer-security-check?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/guard-enable-control-flow-guard?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/dynamicbase-use-address-space-layout-randomization?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/nxcompat-compatible-with-data-execution-prevention?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/highentropyva-support-64-bit-aslr?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/cetcompat?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/compiler-option-warning-level?view=msvc-170>,
  <https://learn.microsoft.com/en-us/cpp/build/reference/analyze-code-analysis?view=msvc-170>,
  and
  <https://learn.microsoft.com/en-us/cpp/sanitizers/asan?view=msvc-170>
- LLVM, coverage-guided native fuzzing:
  <https://llvm.org/docs/LibFuzzer.html>
- Microsoft, WER, dump, recovery/restart, and silent-exit/JIT policy surfaces:
  <https://learn.microsoft.com/en-us/windows/win32/wer/windows-error-reporting>,
  <https://learn.microsoft.com/en-us/windows/win32/wer/wer-settings>,
  <https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps>,
  <https://learn.microsoft.com/en-us/windows/win32/api/werapi/nf-werapi-wersetflags>,
  <https://learn.microsoft.com/en-us/windows/win32/recovery/registering-for-application-recovery>,
  <https://learn.microsoft.com/en-us/windows/win32/recovery/registering-for-application-restart>,
  <https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/registry-entries-for-silent-process-exit>,
  and
  <https://learn.microsoft.com/en-us/visualstudio/debugger/debug-using-the-just-in-time-debugger?view=visualstudio>
- Microsoft, ETW/Event Log/debug-output APIs:
  <https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing>,
  <https://learn.microsoft.com/en-us/windows/win32/api/evntprov/nf-evntprov-eventregister>,
  <https://learn.microsoft.com/en-us/windows/win32/api/evntprov/nf-evntprov-eventwrite>,
  <https://learn.microsoft.com/en-us/windows/win32/api/evntprov/nf-evntprov-traceloggingregisterex>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reporteventw>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-outputdebugstringw>
- Microsoft, AMSI, PowerShell scanning, and Defender cloud/sample submission:
  <https://learn.microsoft.com/en-us/windows/win32/amsi/antimalware-scan-interface-portal>,
  <https://learn.microsoft.com/en-us/powershell/scripting/security/security-features?view=powershell-7.6>,
  and
  <https://learn.microsoft.com/en-us/defender-endpoint/cloud-protection-microsoft-antivirus-sample-submission>
- Microsoft, Windows path/stream/link/reparse and durability primitives:
  <https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file>,
  <https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams>,
  <https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw>,
  <https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw>,
  <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew>
- Microsoft, handle-based file/volume identity, link count, and no-follow reparse
  inspection:
  <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info>,
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info>,
  <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew>,
  <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew>,
  and
  <https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-deviceiocontrol>
- Microsoft, ownership/security descriptors on newly created objects:
  <https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces>
- SQLite, WAL/checkpoint and synchronous durability semantics:
  <https://sqlite.org/wal.html> and
  <https://sqlite.org/pragma.html#pragma_synchronous>
- Git, exact repository/config/ref/object format authorities:
  <https://git-scm.com/docs/gitrepository-layout>,
  <https://git-scm.com/docs/git-config>,
  <https://git-scm.com/docs/git-hash-object>,
  <https://git-scm.com/docs/git-mktree>,
  <https://git-scm.com/docs/git-commit-tree>,
  <https://git-scm.com/docs/git-update-ref>,
  <https://git-scm.com/docs/git-reflog>,
  <https://git-scm.com/docs/git-check-ref-format>,
  <https://git-scm.com/docs/reftable>,
  <https://git-scm.com/docs/gitformat-loose>,
  <https://git-scm.com/docs/gitformat-pack>,
  <https://git-scm.com/docs/gitformat-index>,
  <https://git-scm.com/docs/gitformat-commit-graph>,
  <https://git-scm.com/docs/hash-function-transition>,
  <https://git-scm.com/docs/git-worktree>,
  <https://git-scm.com/docs/git-replace>,
  and
  <https://git-scm.com/docs/shallow>
- Evidence caveat: these sources establish documented APIs and formats; they do not
  prove PC-SDK's compound WER-policy immutability, SQLite row/outbox power-loss
  durability, or custom Git object-plus-ref durability. Those remain qualification-
  dependent. `DUPLICATE_CLOSE_SOURCE` can close the source regardless of error, so this
  design never uses it. Flush/replace documentation does not prove compound durability;
  CX-008 must run disposable abrupt-reset/power-loss injection at every object/ref/
  reflog/rename/flush edge and otherwise keep the Git transition unavailable.
- Node.js, C++ addons and Node-API:
  <https://nodejs.org/api/addons.html> and
  <https://nodejs.org/api/n-api.html>
- Node.js, child-process lifecycle:
  <https://nodejs.org/api/child_process.html>
- Node 22.13/libuv, inherited-handle `CreateProcessW` behavior:
  <https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/process.c#L1057-L1065>
- OpenAI Codex 0.144.1 release/source:
  <https://github.com/openai/codex/releases/tag/rust-v0.144.1> and
  <https://github.com/openai/codex/tree/44918ea10c0f99151c6710411b4322c2f5c96bea>
- OpenAI, pinned experimental app-defined tools:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/README.md#L1557-L1577>
- OpenAI, pinned global/thread MCP status semantics:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/README.md#L236-L239>
- OpenAI, pinned thread config override resolution:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/src/config_manager.rs#L220-L249>
- OpenAI, pinned recursive config merge:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/config/src/merge.rs#L6-L34>
- OpenAI, pinned external-notifier configuration/construction behavior:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/core/src/config/mod.rs#L3451-L3490>
- OpenAI, pinned config-read snapshot implementation:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/src/config_manager_service.rs#L111-L152>
- OpenAI, pinned MCP status connection/inventory implementation:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-mcp/src/mcp/mod.rs#L365-L437>
- OpenAI, pinned MCP effective catalog sources:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-mcp/src/mcp/mod.rs#L241-L292>
- OpenAI, pinned `never` MCP approval behavior:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/codex-mcp/src/mcp/mod.rs#L77-L98>
- OpenAI, pinned thread start/resume response construction:
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/src/request_processors/thread_processor.rs#L1319-L1342>
  and
  <https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server/src/request_processors/thread_processor.rs#L2928-L2944>
