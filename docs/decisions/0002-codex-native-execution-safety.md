# ADR-0002: Codex native-execution safety boundary

Status: accepted, 2026-07-13; explicitly approved by the product owner after
proposal checkpoint `4fbbdf0f77b447e78f4218816e90d553ed93145a`.

## Context

CX-001 pinned and admitted the stable Codex app-server subscription surface.
CX-002 implemented its provider-local mapping against a provider-free peer.
Neither slice authorized a native process or turn. Production remains blocked
on two facts that application prose and post-action detection cannot supply:

- the root and ordinary in-tree `CreateProcess` descendants must die with the
  local server and produce positive lifecycle evidence; and
- the exact closed-world effective external-action inventory from every
  runtime source, plus sandbox/filesystem/network and approval behavior, must
  be independently attested and bound to the immutable attempt, selection,
  and thread before the first turn.

Windows Job Objects can provide the lifecycle primitive, but Node has no public
API for the required atomic full-spawn operation. Stable app-server 0.144.1 can
echo some sandbox/approval settings in a thread response before a turn, but it
cannot attest the complete effective external-action policy, hold a quiescent
barrier while PC-SDK verifies it, or keep an admitted policy epoch immutable.
One acceptable future wire is a challenge-bound passive preflight/token;
another is quarantined thread creation followed by PC-SDK's positive admission
commit. A one-phase response is insufficient.

## Decision

The accepted bundle is:

1. PC-SDK owns a minimal transient native cold-start/controlled-restart bootstrap plus C++ Node-API full-
   spawn binding for one exact qualified Windows 11 25H2 x64 client tuple within
   base build `10.0.26200`. External `entry-scrub` has no SF-001/product authority.
   A live N7 launcher retains its least scrub lifecycle handle through success or
   terminate/wait, but closing a process handle does not terminate scrub if N7 dies.
   N7 create→scrub-watchdog-arm crash/hard-kill containment is therefore an unresolved
   production blocker requiring a separate crash-safe kernel anchor, exact handoff/
   death receipt, and requalification of any changed job topology. CX-004 does not
   qualify or freeze that edge. Its internal fixture positively requires an unjobbed
   scrub. After the independent watcher arms, scrub's main path creates/configures/
   queries the permanent unnamed kill-on-close outer job with zero UI restrictions,
   sets/queries source noninherit plus protect-from-close, publishes the process-sole
   handle to the watcher with ack, then atomically creates, deliberately without
   `CREATE_SUSPENDED`, hard-gated same-PE `cold-bootstrap` in that sole job with challenge-read, initially
   nonsignaled two-phase watchdog-ready/handoff-ack event, and parent-lifecycle handles.
   From the broad process result it derives separate DUP-only target and query/terminate/
   synchronize lifecycle handles, publishes watcher cleanup with ack, and positively
   closes both broad `PROCESS_INFORMATION` process/thread sources.

   After child watchdog-ready, scrub duplicates only `JOB_OBJECT_QUERY |
   JOB_OBJECT_TERMINATE | SYNCHRONIZE` into cold, sends its identity-bound target value,
   and remains sole source holder until cold sets/queries noninherit and protect-from-
   close, queries/publishes the exact sole job and acknowledges. The causal two-phase
   event prevents signal collapse. Target return is the ownership linearization; any
   pre-ack uncertainty terminates the source job. Only after retiring every watcher-
   visible cleanup handle with quiescence ack may scrub close child/control handles,
   clear and query-clear source-job protect-from-close, close that job source last,
   and emit the exact success exit. Cold's independent watchdog requires
   that planned success, terminates the job on any other parent result, and continues
   its noncancelable post-parent deadline. Only after child image/manifest/launch/UI/
   exact sole outer job, still-unjobbed parent, and parent-success revalidation plus
   watcher-quiesced close may cold acquire and later gaplessly transfer
   SF-001's canonical-data-directory kernel witness, launch
   exact sealed `node.exe` against a deterministic protected precompiled JavaScript
   boot entry with a closed nonsecret argv/environment/cwd/handle/debugger policy and
   explicit restrictive process/thread security descriptors supplied atomically with
   implicit inheritance of the already-held outer job, prove those descriptors and dangerous-access
   denials, then derive exact noninheritable query/terminate/synchronize process-
   lifecycle and `THREAD_SUSPEND_RESUME` handles before positively closing both broad
   `PROCESS_INFORMATION` sources. With only the least owner-lifecycle and owner-job
   handles it then proves `[coldBootstrap,owner]`. Cold requires
   `ResumeThread(ownerResumeThread) == 1` and positive derived-resume-handle close before
   owner readiness. Any derivation/source-close/membership/resume/derived-close
   uncertainty prevents readiness and terminates the outer job. Cold holds exact bootstrap/Node/addon/install/native-load identities
   through mapping, and waits for a challenge-bound addon-ready/owner-posture receipt
   before the owner may open the product DB/vault/provider/project state. No admitted
   cold-start/restart path contains `cmd.exe`, PowerShell, `pnpm`, `tsx`, esbuild,
   a runtime source loader/hook, `NODE_OPTIONS`, `--require`, or `--import`; the exact
   boot JavaScript/source-map/loader/package/native-load manifest is protected. The
   current source-run launcher fallback is development-only and typed non-admitted.
   During
   controlled restart only, new owner may open the dedicated SF-001 admission-SQLite
   connection while bootstrap lives, acquire its lifetime transaction, and return one
   bounded successor-admitted digest/ack. Bootstrap then exits; new owner proves
   `[newOwner]`, opens product DB, and CASes the nonce/generation restart record from
   `committed` to `completed` before any other product state. Owner-initiated
   noninheritable witness-then-job duplication has one exact target-return handle-
   ownership linearization followed by protect/query validated admission. Bootstrap
   immediately protects/queries/publishes its source witness, publishes every watcher-
   visible lifecycle handle, and after target ack retires/quiesces all of them before
   clearing/querying/closing transient protected witness then job sources. Steady owner
   target handles stay protected. Every
   duplicate uses an explicit least target mask, `bInheritHandle=FALSE`, and
   `dwOptions == 0`; neither duplicate option is admitted. Ack/source-
   close/exit and the SF-001 SQLite half complete under bounded
   failure/death/hang handling with no lease gap. On failure the bootstrap/owner
   terminates the exact known process/job; concurrent or uncertain launch refuses.
   On success it transfers only the sealed owner-job/witness lifecycle state and exits.
   The same PE preserves one-click engine restart through one exact owner-invoked
   handoff: after inner-job/I/O/lease zero, the old owner creates it suspended inside
   the existing outer job with only bounded control plus a real old-owner lifecycle
   handle without `PROCESS_DUP_HANDLE`. From the distinct broad `PROCESS_INFORMATION`
   sources and before closing either, old owner derives the explicit least-mask,
   noninheritable, zero-option duplicate-only and process-lifecycle handles from the
   broad process source plus an exact `THREAD_SUSPEND_RESUME` handle from the broad
   thread source. It positively closes both broad sources, then requires pre-resume proof,
   `ResumeThread(restartResumeThread) == 1`, and positive derived-resume-handle close
   before the ready ack. Any derivation/source-close/membership/resume/derived-close uncertainty
   prevents ready, poisons creation, and terminates the outer job. Old owner then remotely duplicates witness and same-job handles, delivers
   each exact target value with the same zero-option/least-mask rule, and bootstrap
   protects/queries them itself. Sender death
   or value-delivery uncertainty makes bootstrap self-terminate so unknown target
   handles close. Old owner alone holds one exact coordinator-bound target-bootstrap
   `PROCESS_DUP_HANDLE` process handle while that secret-free transfer runs and
   clears its inherit flag, queries it clear, and closes it before durable `prepared`;
   uncertainty poisons creation and
   terminates the job. The bootstrap never receives that right; a
   durable nonce/generation-bound restart commit precedes old-owner exit. One owner-
   lifecycle component owns the restart schema/commands/queries/DTOs/state machine;
   every prepared/committed/aborted/completed/reconciled/attention transition commits
   its canonical outbox/control event in the same product-DB transaction with replay-
   safe identity. CX-004 seals SQLite journal/`synchronous`/checkpoint/flush/close-
   reopen semantics and uses abrupt-process plus disposable power-reset injection;
   read-back alone is not a power-loss receipt. Bootstrap
   proves old-owner absence, creates new Node by implicit inheritance of that same
   job using the exact cold-owner distinct-broad-source derivation/retirement/resume-
   close rule, and transfers the exact nonsecret committed nonce/old-generation/new-
   generation/digest tuple over bounded challenge-bound launch/control input. The new
   owner validates and binds it to the successor-admitted ack; it never discovers a
   generic/latest committed row. It completes the second witness/job handoff and exits after the new owner
   acquires only the dedicated admission-SQLite transaction and sends the bounded
   successor-admitted ack. New owner then proves `[newOwner]` and completes the post-
   exit product-DB CAS of that exact expected record described above; no general DB IPC
   reaches bootstrap. Exact transitional memberships, no-
   overlap, and both handoff failure matrices are mandatory. After bootstrap exit,
   responsive failure self-terminates and crash/death releases the witness; a live-
   hung new owner remains pre-vault/provider/project, keeps the witness occupied, and
   makes contenders refuse rather than infer death or kill it. Detached/breakaway
   replacement, a new outer job, autonomous replay, or manual-babysitting fallback is
   unavailable. The bootstrap has no provider/action/repository/autonomous-restart/
   relay/supervisor or steady-state authority, leaving one steady-state server
   process. The Windows SF-001 witness is one local-only,
   first-instance/one-instance native named-pipe server handle with an explicit
   protected DACL/`OWNER RIGHTS`/mandatory policy that allows no legitimate client
   open or name-based reopen. Root/lower/transition/Git desired-access-zero/query/
   read/write, ACL-relax, connect/create-instance, and server-handle duplicate/
   inherit/retain attacks must fail, and owner hard-kill must permit exact
   successor acquisition. The binding creates each root in an unnamed kill-on-close
   Job Object through
   a qualification-sealed ordered `PROC_THREAD_ATTRIBUTE_JOB_LIST` vector/cardinality,
   suspended, with breakaway disabled and an
   exact `STARTF_USESTDHANDLES`/handle-list boundary. One process-creation
   call also supplies the qualification-sealed explicit process and primary-thread
   security descriptors for every provider/action/transition/Git root; their exact
   owner/group/protected-DACL/`OWNER RIGHTS`, any qualification-proven mandatory
   label, and access facts are queried
   before publication or resume, with no default-DACL or post-create-seal window.
   Bootstrap/base same-token creation uses exact `CreateProcessW`; restricted-token
   roots use exact `CreateProcessAsUserW` with an already-sealed primary token and
   qualified token rights, caller-token access, session equality, and privilege
   behavior. The addon token-preparation suboperation owns target-primary and caller/
   root query-token handles under the coordinator; it accepts no caller-owned or
   externally borrowed token handle and positively retires all owned token handles
   before success publication. Both APIs share the same suspended `STARTUPINFOEX`/job-list/handle-list/
   descriptor/query/resume/I/O/failure matrix plus exact creation-time mitigation,
   no-child, and—when claimed—security-capabilities attributes. Initial headless
   templates atomically set Win32k disable and no-child/no-override; AppContainer claims
   require exact `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, not merely a restricted
   token. `CREATE_NO_WINDOW` is not UI isolation, so `lpDesktop` names a qualified
   protected noninteractive isolated station/desktop; NULL/default/inherited parent UI
   association is unavailable. Missing privilege or any need for
   elevation/logon/alternate credentials is unavailable; other process APIs are not
   fallback. One process-creation coordinator covers every repository and transitive-
   dependency spawn path reachable from the admitted Node owner; bootstrap modes use
   only their sealed launch edges. The external one-click UI launcher/browser remains
   N7 operations work: its future server edge may invoke exact `entry-scrub` and retain
   only that least routine process-control handle through exact success or terminate/
   wait, then close; it must additionally provide the separately approved crash-safe
   create→watchdog-arm kernel anchor and topology receipt. The routine handle alone is
   insufficient, CX-004 does not qualify that edge, and the browser is not owner-jobbed. An
   uncoordinated Worker or spawn-capable native thread makes
   the capability unavailable. The pinned Claude SDK spawn hook is injected through
   full-spawn for session and model discovery, while its `reg.exe` helper is eliminated
   or independently qualified. Both MCP stdio wrappers replace
   `StdioClientTransport`/`cross-spawn` with the restricted full-spawn/stdio transport
   and sealed templates, or stdio MCP is unavailable; no PATH/shebang/cmd fallback is
   admitted. Dormant/install-only dependency process exports and toolchains are absent
   from the admitted bundle/allowlist. The binding
   is privileged owner-TCB code. The bootstrap's qualification-sealed OS/image
   admission—not addon self-attestation—enforces exact code integrity plus an owner-
   nonwritable protected install/namespace and postmortem-policy baseline. It binds
   the canonical `.node`/install-root/ancestor identity, final PE import/delay-load
   closure, exact Node host and qualified system/KnownDLL dependencies, immutable
   loader configuration, and absence of mutable cwd/`PATH`/project/user-writable
   search through mapping.
   Preventive source/dependency guards and a sealed native-load gate make the owner
   addon the first optional native module and close the inventory for the full owner
   lifetime. After addon/postmortem readiness and before any admission-SQLite use,
   owner verifies and loads the exact protected pinned `better_sqlite3.node` by
   canonical path. One owner SQLite factory supplies that same admitted addon object to
   every admission/product/repository-lease/future `Database` constructor; direct
   constructors and ambient `bindings` resolution are banned because pinned
   `better-sqlite3@11.10.0` loads lazily and a supplied binding does not seed its
   default cache. CX-004 replaces current manifest ranges with exact manifest/lock/
   store/integrity versions for this binding and pinned `ws@8.21.0`; semver drift is
   not admission. Exact package-copy/singleton/cache identity, package/version/content,
   Node ABI, file/ancestor identity, provenance, PE import/delay-load closure, loader
   search, final-PE mitigation disposition, absence of process-creation/dynamic-
   resolution/service-start/spawn-capable-background-thread paths, source-build/
   verified-prebuild, and
   substitution/load-crash matrix are qualification facts. SQLite extension-loading
   APIs/SQL/native/auto-extension hooks are disabled and canaried. Pinned `ws` optional
   native accelerators are absent and disabled by sealed environment. An unknown/late
   optional native module or unaccepted SQLite-addon gap is unavailable and fences.
   Broader co-bundled dependencies require a pre-load safe-search/immutability
   proof. Substitution, swap-back, and load-execute-unload canaries must fail; post-
   load notifications/enumeration are corroboration only; every future native
   dependency needs its own manifest and affected requalification. The addon loads while the owner contains
   no DB/vault/provider secret or untrusted project/process capability, then before
   exposing spawn exports seals the owner's effective WER/dump/JIT/monitor/recovery/
   restart posture. Disposable qualification injects addon-load and initialized-
   owner crash/hang cases; production boot records a non-destructive receipt. CX-004
   may fake-provision the protected OS/image/install/postmortem baseline only in its
   pinned disposable runner. Production native admission remains unavailable until a
   separate approved provisioning/packaging/N7-launcher-lifecycle decision supplies the exact baseline;
   this ADR authorizes no installer, elevation, WDAC/AppLocker mutation, or runtime
   self-ACL seal. If the lab cannot cover both bootstrap and addon-load windows,
   CX-004 blocks; no long-lived helper, second lifecycle, or fallback is authorized.
   The qualification-sealed compiler/linker/final-PE profile for both repository-owned artifacts includes strict
   warnings-as-errors, stack cookies, CFG, ASLR, DEP/NX, high-entropy VA, and CET
   where supported, plus final-PE verification, static analysis, sanitizer/property/
   fuzz lanes, and typed failure for missing or downgraded mitigation. The pinned
   SQLite addon's independently sealed final PE must meet that profile or an exact
   separately owner-accepted residual; repository-native static analysis/fuzz does not
   launder a third-party binary.
   The binding
   rejects embedded NUL, relative/search application paths, empty or
   `=`-containing environment names, and case-colliding keys. It serializes a
   canonical absolute application with no search, the same path as quoted
   `argv[0]`, exact arguments, canonical cwd, and a sorted allowlisted UTF-16
   environment using one sealed Windows ordinal case-insensitive key comparator.
   CX-004 pins and checks application/cwd, argument-count/per-argument/command-line,
   environment entry/name/value/block, staged-content, stdio, IPC/control/receipt-
   frame, and collection-cardinality bounds in both server and native layers before
   allocation, parse, or OS mutation. Zero/bound/+1, huge/wrap, allocation-failure,
   NUL/Unicode, and fragmented/coalesced fixtures are mandatory. CX-004 generates from
   the exact built artifacts a closed manifest of every native-resource acquisition/
   release site: acquired/output/duplicated/borrowed/pseudo kernel/user-object handles
   plus raw OS/native opaque resources explicitly acquired by either artifact with a
   release obligation, such as heap/attribute-list and crypto/catalog/certificate/
   signature contexts. C++ standard-library and Node/runtime-managed allocations remain
   under RAII/sanitizer/fuzz proof. Typed wrappers with compile-time site IDs are
   the only path; AST/static/import/dynamic-resolution guards reject direct/unregistered
   calls, and the embedded manifest digest must equal independent source/PE inspection.
   Each site binds type, owner/borrower/no-release class, rights/inheritance, identity,
   last use, type-specific close/destroy/free API, sealed documented no-failure normal
   return, positive result, or independently verified idempotent postcondition, order,
   and fault canary. Unmanifested/ambiguous
   sites, incompatible generic `CloseHandle`, or owned release without sealed completion proof
   are unavailable. Recyclable numeric handles use `known-live`, `positively-closed`, or
   `close-outcome-quarantined`; opaque resources use analogous released/quarantined
   states and type-appropriate canaries. Each owned-site wrapper qualifies before-call
   failure and underlying-release-succeeded/report-uncertain, including documented no-
   failure normal-return APIs. A nonpositive/uncertain release forbids stale
   query/use/release, fails the transient or poisons owner process creation, and mandates
   process exit/non-restart owner shutdown. Cleanup touches only known-live resources;
   borrowers never release and owner liveness is positive. No-release/pseudo sites must
   prove stable documented identity and no release call or effect under the exact
   wrapper/static/PE guards. Each full-spawn
   operation holds the sole process-creation coordinator from before new-leaf creation/
   configuration and parent-baseline capture through either atomic successful handle-
   ownership/receipt publication or complete failure cleanup plus atomic poison/
   unavailability publication. Callers cannot
   supply raw job flags or a limit structure. Every PC-SDK outer/session/action/
   transition/Git job sets and queries zero `JobObjectBasicUIRestrictions`; any nonzero
   value is unsupported for nesting. The CX-004 base template's zero-initialized limit input sets only
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; its pre-resume query requires that exact
   `LimitFlags` value. Later qualification-sealed provider-session/action templates
   require their exact named kill-on-close/resource-flag superset and enabled
   fields, rejecting missing or unsealed extras, then rerun the full CX-004 matrix
   with composition-specific assertions. No template compares mutable accounting/
   peak telemetry. Each ordinary addon launch distinguishes implicit ancestors,
   borrowed explicit parents, and one newly owned immediate leaf. Explicit job-list
   handles have assignment authority only as sealed. After job configuration and before
   process creation, every new leaf derives from its broad job source an exact
   noninheritable `JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE` lifecycle
   handle; provider session alone also derives a separate exact noninheritable
   `JOB_OBJECT_ASSIGN_PROCESS`-only future-action handle. The broad job source remains
   known-live through atomic create. After create and broad-only descriptor/identity
   queries, the distinct broad `PROCESS_INFORMATION` process/thread sources derive exact
   noninheritable zero-option least process-lifecycle and `THREAD_SUSPEND_RESUME`
   handles. Every required job/process/thread derivation precedes any broad-source close;
   then temporary child handles retire and the broad job, process, and thread sources
   close positively in that order. Any nonpositive/uncertain source-close outcome
   quarantines that numeric value permanently and permits only independently known
   derived handles, untouched broad sources, and exact-root fallback; no child resumes
   earlier. The PC-SDK owner
   is the sole process holding the exact successful session pair;
   actions borrow the assign-only handle only inside the coordinator, and the implicit
   outer has no assignment authority. Pre-resume proof requires root membership and exact limits in every
   named job; only the new leaf has `ActiveProcesses == 1`/`[root]`, while each parent
   complete list equals its retained-handle-backed baseline plus root. Cold→Node and
   controlled restart inherit the outer without a duplicate entry; cold proves
   `[coldBootstrap,owner]` before resume and `[owner]` only after exact bootstrap exit;
   their separately sealed uncertainties may terminate the permanent outer job. For
   ordinary addon launches, `ResumeThread(rootResumeThread) == 1` is mandatory; any other
   return makes execution state unknown, terminates only the new leaf with exact-root
   fallback, restores every borrowed/implicit parent baseline, and unwinds without
   publishing a spawn receipt. Exact-one must be followed by positive derived-resume-
   handle close before atomic ownership/receipt publication and coordinator release; a
   nonpositive/uncertain close enters quarantine,
   terminates/restores through the same path, poisons, and mandates non-restart shutdown.
   It never terminates or closes a borrowed owner/session job. While the coordinator
   remains held, every temporary child handle must prove its inherit flag clear and
   close. The coordinator stays held through all derivations, source/temp close, job/
   baseline proof, exact resume, positive derived-resume-handle close, and atomic success publication. A
   nonpositive/uncertain close enters the global quarantine above. Any clear/query/close uncertainty
   poisons all later process creation. Controlled
   restart is then forbidden; durable attention/non-restart shutdown precedes a
   later external-launcher cold start. Killing the job cannot repair a parent-retained inheritable
   handle. Normal teardown records
   `terminationMode` as `natural`, `graceful`, or `job`, independently from
   `cleanupProof: tree-exited | uncertain`.
   `TerminateJobObject` returning is never cleanup success: success also needs
   new-leaf zero/empty, restored parent baselines, the exact root exit code, a signaled
   root, and I/O EOF. Provider-session teardown first stops/settles action admission and
   borrowing, proves every action job disposed, and positively closes its assign-only
   handle. RAII releases only known-live resources and never touches a release-outcome-
   quarantined resource. On derivation failure it follows manifest order across all
   known-live job/process/thread sources and derived handles; for the job, any derived
   assign-only handle precedes its untouched broad source and lifecycle last when
   lifecycle exists, or broad last when it does not. After source-close uncertainty it
   never reuses that value, closes only known derived/untouched handles, and makes no
   last-handle claim. Action/transition/Git leaves retain no assign handle after
   successful create. Any owned-resource release uncertainty poisons creation, requires
   non-restart owner shutdown as the final fail-safe for process-owned raw OS/native
   cleanup without inferring a quarantined release, and cannot claim cleanup; borrowed
   handles remain with their owners. Every failure
   holds the coordinator through terminate/wait, leaf-zero and parent-baseline proof,
   ordered known-resource cleanup/quarantine, and atomic poison/unavailability publication
   before release. Fake-process conformance must also prove byte-exact
   simultaneous stdout/stderr, stdin backpressure/partial-write/EOF/error
   semantics, high-volume full-duplex progress beyond pipe capacities, bounded
   buffering and byte-exact resume for each independently paused output
   consumer, bounded pending/queued stdin without advisory-backpressure queue
   growth, and Node event-loop responsiveness. The CX-004 contract pins every
   per-direction/combined byte bound and teardown timeout before implementation.
   Saturated mid-flight teardown must settle each stream/write exactly once
   within that timeout, preserve timer progress, emit no callback/byte after
   settlement, and leave zero pending I/O, native workers, handles, or tree
   members. A non-vacuous external witness
   proves every deterministic process live immediately before it kills only the
   owner, then proves every handle transitions to signaled and fixture progress
   stops. The witness proves non-inheritance for the deterministic fixture, not
   hostile same-user owner/job-handle acquisition. CX-005 must prove every provider-
   root-to-owner/outside denial before credentials; CX-008 revalidates it and adds
   lower/sibling/cross-tier directions.
2. Initial support is one qualified Windows 11 25H2 x64 client tuple within base
   build `10.0.26200`. The full
   admitted-path source-build and hard-kill matrix is mandatory on a pinned
   disposable runner whose native probe matches `VER_NT_WORKSTATION`, AMD64, and
   build `10.0.26200`; the CX-004 contract pins its exact full revision/UBR and
   immutable image provenance/digest before implementation. Production runtime
   admission must equal that sealed full revision/UBR and admission-checkable
   native OS/security-component identity/provenance; any delta is typed unsupported
   until a full CX-004 rerun requalifies and seals a replacement tuple. CI fails
   on mismatch. `windows-latest` is an independently observed, always non-admitted
   lane that may source-build and proves the public typed-unsupported path, but
   contributes no containment or admission evidence; an identity match fails for
   an explicit runner-policy decision. Every other Windows
   build/product/architecture and every non-Windows host fails typed with no
   fallback.
   Development may source-build from pinned inputs, but every build seals both
   complete native-load closures and final PEs. Future one-click distribution must
   ship integrity-verified prebuilds plus those immutable loader/provenance manifests and cannot
   require user compilers.
3. Native Codex execution stays unavailable on 0.144.1. PC-SDK will upgrade
   only to a later pinned stable release that exposes a complete independently
   verifiable effective-policy admission receipt, quiescent two-step barrier,
   and immutable policy epoch, all bound to the continuation attempt,
   selection, and thread. After offline package/source plausibility review, the
   later-version gate runs every binary/version/schema/initialize/config/account/
   model/warning/policy invocation through CX-004 containment, reruns CX-002
   mapping/static conformance, and seals full requalification before thread
   admission. It never reuses CX-001's direct spawner. It will not maintain a
   Codex fork, enable experimental protocol, use SDK/exec or raw API billing to
   bypass these gates, or substitute detect-and-abort behavior. A future
   governing-doc-authorized wire must satisfy the same gates.
4. The first live native gate requires a closed-world all-origin empty
   external-action inventory: built-in and dynamic tools, PC-SDK bridges, exact
   effective MCP server identity/config/provenance/connection state plus tools/
   resources/resource templates/prompts/instructions,
   apps/plugins/skills/deferred namespaces, hooks/notifiers, collaboration/
   subagents/remote control, plus explicit absence for precautionary code-mode,
   companion-host, external-broker, and future composition origins. The latter
   are closed-world requirements, not asserted stable-0.144.1 schema surfaces.
   The same receipt binds exact sandbox/filesystem/network policy; approval
   requests disabled; no automatic reviewer, guardian, or escalation fallback;
   deny-on-unapproved-or-unknown semantics for the entire admitted epoch; a
   closed request/notification vocabulary; effective-config provenance/digest;
   and the immutable runtime, account, model, effort, attempt mode/id, native
   thread id or explicit create absence, and canonical cwd. No policy/catalog/
   approval mutation takes effect without quiescent re-admission. Effective
   provider auth identity, native account/workspace, auth mode, plan, service
   tier, billing route, runtime, model, and effort cannot change in an app
   session; drift fences the attempt and requires a new selection/session.
   Token refresh is allowed only with positive unchanged-identity/route proof.
   MCP initially has zero effective servers/connections and empty subordinate
   catalogs. Named least-privilege actions and PC-SDK-owned MCP delivery require
   a later explicit parity contract whose digest covers the same fields and
   forbids session-wide and exec/network policy amendments.
5. CX-004 implements and lab-qualifies only provider-neutral fake-process
   containment: exact plain-Node compiled boot, both repository PEs and the pinned
   SQLite PE/factory/load closure, closed native/process-spawn inventories, protected
   SF-001 pipe, cold/restart outer-job handoffs, full-spawn family, hardening/bounds,
   load/postmortem, and exhaustive failure matrices;
   its fake protected-install receipt permits offline CX-005 source review only.
   Before any provider process, login-home access, or credential-bearing invocation,
   a separately approved fresh production bootstrap/protected-install admission for
   the exact host/build is mandatory; it includes exact compiled-boot/addon/SQLite/
   native-and-process closure, qualified full-spawn family, controlled-restart/outer-
   job state/recovery, and exact SF-001 pipe security/instance/handle/zero-client/
   successor facts, and no
   lab receipt substitutes. Credential-free
   evidence must then choose and record either (a) the exact attested
   provider binary/control plane as a TCB for credential non-declassification and
   provider-network semantics, accepting the precise root credential/socket
   residual, or (b) a separately approved opaque auth/inference broker the root
   cannot read/replay and that is not a generic oracle. CX-003 does not prove (b)
   compatible with Codex subscription login. Without deferral to CX-008, the same
   gate qualifies every provider-root-applicable invariant/canary in the normative
   contract: independent attester identity/provenance; raw/effective token,
   removal-not-disable privileges, and self-token access; owner/DACL/MIL/other
   security attributes and exact access; independent non-DACL prevention of
   pseudo-handle/`SetSecurityInfo` self-relaxation across process/thread/token/
   default-DACL/group/restriction/capability/privilege/integrity/AppContainer/
   session/child/UI and protected PC-SDK job/handle/IPC state, excluding only the
   accepted self-created inner-job residual; root-created-object/OWNER RIGHTS and exact
   filesystem/volume/path/alias semantics; WER/recovery plus diagnostic/audit/ETW/
   Event Log/debug channels; AMSI/Defender/EDR/SmartScreen/cloud/sample content-
   inspection policy/residual; and atomic root enforcement. It also binds
   executable/native-load/config/auth separation, cross-app shared-home
   fencing, owner/DB/vault/outside denial, exact mode-specific network/IPC/
   capability-export outcome, full-spawn API/token/session/privilege facts, SF-001
   protected-pipe/outer-owner-job handoff and hierarchy, one
   monotonic active provider generation with prior-zero/no-overlap, 1:1 PC-SDK-owned app-
   session/root/session-job topology, the PC-SDK owner as sole process holding the exact
   session-job lifecycle-plus-assign-only handle pair, exact retained-job membership/
   limits,
   durable recovery, and preventive
   bounds for every independently enforceable root resource. An unbounded root
   class is unavailable unless a separate future product/security decision accepts
   that exact residual before credentials. The full CX-004 matrix reruns with the
   exact composed job-template assertions. No login-home access or provider call
   occurs without a positive owner-approved root-trust/broker-and-OS receipt.

   CX-005 then performs later-stable CX-001/CX-002 requalification and contained
   no-turn admission. CX-006 requires the same root receipt and proves subscription/
   no-API billing, warnings, identity/model stability, session/interrupt/dispatch,
   empty policy, context, and usage. CX-007 remains provider-free in-memory/non-
   process policy/approval/MCP compilation. It may compile canonical future
   process action descriptors only as inert data; no server, process, connection,
   tool, repository script, or broker call starts.

   After positive CX-005 root and CX-007 receipts, CX-008 revalidates without
   narrowing every provider-root guarantee and adds lower-action, standalone
   provider-auth-credential-free transition-action, restricted-Git, sibling, and
   cross-tier composition: independent attestation; raw/effective token, child,
   Win32k/UI, self-DACL/created-object, handle/IPC, executable/config/parser;
   diagnostic/audit/content-inspection residuals; exact private-volume/path/alias/
   resource semantics; Git format/backend plus restricted parser and owner verifier/
   promotion/ref CAS; capability export; per-target recovery; owner/session/action/
   transition/Git job hierarchy and global budgets; lifecycle; and CX-007-template
   proofs. Every
   model/runtime/untrusted-project action crosses that lower boundary. The initial
   lower template is leaf-only with empty raw Winsock/network capability. Process-
   spawning parity needs a separate mediated-child or stronger-isolation decision
   and independent receipt for every process; job inheritance never substitutes.
   Disposable pinned VMs use matched differential or positive ambient-
   inaccessibility evidence, except the exact option-(a) root TCB residual, and
   rerun the full CX-004 matrix under the composition. Any effect, unlisted delta,
   cleanup/recovery uncertainty, or VM teardown uncertainty blocks CX-009. Contract-
   defined preparation/readiness/verification/cleanup always uses the standalone
   transition lane with its own generation/job/receipt/recovery, never owner/provider
   authority.

   Lower principals never receive Git-administrative authority. Every general Git/
   parser/build step runs as an exact transient restricted principal with only
   leased precreated run content/admin/quarantine/index handles and bounded IPC.
   Quarantine remains mutable/untrusted until process zero; restricted processes
   receive no common-object-parent create or target-ref rights. CX-008 separately
   accepts/qualifies a minimal memory-safe owner-TCB streaming verifier, followed by
   an owner-only verified-byte temp/flush/reopen/rehash/no-replace promotion and
   files-backend expected-old/new ref CAS primitive that invokes/parses no Git.
   Their independently receipted boundary re-reads commit/tree/parent/ref/reflog/
   lock/cleanliness/scope before delivery. Admission pins exact Git version,
   repository format/extensions/object algorithm, files ref backend, loose target-
   ref/reflog/lock protocol, and excludes compatibility format/worktreeConfig,
   reftable/packed-only target, shallow/partial/promisor/missing/unknown state.
   Writable grants require a dedicated/equivalent private volume preventing cross-
   boundary hardlinks plus exact path/stream/case/encoding/resource/durability
   qualification; alias cleanup alone is insufficient.

   CX-009 requires positive CX-006/007/008 plus matching fresh provider and OS
   receipts. The OS receipt contains the current production plain-Node compiled-boot/
   owner-addon/SQLite/native-and-process closure, bootstrap/full-spawn family, SF-001
   protected-pipe/zero-client/successor facts, controlled-restart state/recovery/no-
   transition, and owner-job hierarchy;
   monotonic provider generation/prior-zero/no-overlap; root trust/
   shared-home; all root/lower/transition/Git token/executable/child/UI/target/
   diagnostic/inspection/filesystem/export/resource/recovery/IPC/lifecycle facts;
   Git format/backend/parser/owner-verifier/promotion/CAS digests; attester; session/
   queue/action state; stable standalone transition/Git templates, implementations,
   recovery epochs, and positive no-active-instance state; and exact equality to CX-
   008 qualification. Each actual transition/Git generation/process/job is admitted
   only by its fresh per-call receipt. A challenge-bound composite CAS verifies every
   field, zero unresolved leases, and no oversubscription before any action; every
   new process remains independently pre-first-instruction receipted. Positive
   process-spawning topology is still required. CX-010 repeats the entire fresh join
   before real mutation. Delivery/landing additionally requires the cross-bound
   restricted-candidate/verifier/promotion/ref-CAS snapshot/commit/tree/parent/scope/
   secret receipt bound to current evidence. Lab/prior-attempt receipts never
   substitute; drift fences/quarantines.

The complete normative safety contract is
`docs/execution/slices/CX-003.md`; this ADR summary cannot narrow it. Supporting
evidence and primary references are in
`docs/research/codex-native-execution-safety.md`.

## Rejected alternatives

- Node spawn followed by assignment leaves an initial escape window.
- `taskkill /T`, PID enumeration, process groups, parent polling, and direct-
  child kill do not prove descendant containment.
- A general or long-lived PowerShell/C#/native relay/helper/supervisor adds a second
  lifecycle and parent-watch authority and cannot transfer complete action process/
  stdio ownership under this contract. The exact transient native bootstrap is the sole
  bounded exception: it has a sealed full-spawn/IPC/job/lease handoff, failure matrix,
  and no steady-state authority.
- Rust/napi-rs adds more build/dependency surface than the narrow Win32 binding
  requires; it does not remove unsafe FFI or prebuild obligations.
- No third-party package market evaluation was performed or claimed. The owner
  would deliberately select repository-owned code without relying on one;
  future adoption requires an exact name, version, license, source review, and
  full-spawn/stdio/lifecycle audit against the same receipt.
- Cross-platform containment now adds cgroup/macOS scope without advancing the
  personal Windows daily driver.
- Assigning after spawn on older Windows is not a compatibility path; versions
  without `PROC_THREAD_ATTRIBUTE_JOB_LIST` remain unsupported.
- Forking Codex, enabling experimental APIs, or using another authorized
  runtime wire/raw API billing to bypass these gates is rejected. A future wire
  or billing change remains a separate decision and must meet the same safety
  boundary.
- Request echoes, read-only sandboxing, `approvalPolicy: never`, rejected
  callbacks, and post-start item monitoring are not effective-policy receipts.

## Consequences

- PC-SDK gains two narrow but security-critical native PEs: a transient cold-start/
  controlled-restart bootstrap and the Node-API addon, plus Windows CI, shared/divergent-core review,
  ABI/build ownership, architecture gating, handoff/outer-job/SF-001 invariants, and
  future prebuild-integrity obligations. Admitted owner launch also gains a deterministic
  protected precompiled JavaScript artifact; the current tsx development path is not a
  production fallback.
- The existing `better_sqlite3.node` becomes an explicit privileged startup
  dependency: owner-addon-first/full-lifetime load order, one injected binding factory
  for every DB constructor, extension-load denial, exact package/cache identity,
  protected provenance/load closure, final-PE disposition, substitution/crash
  qualification, and verified prebuild or source-build evidence are required before
  admission SQLite can open. Optional `ws` native accelerators are excluded.
- CX-004 is fake-only lab qualification. Production native admission remains blocked
  until a separate product decision provisions an OS code-integrity rule, owner-
  nonwritable install and postmortem baseline. This ADR does not authorize an
  installer, elevation, WDAC/AppLocker change, or runtime self-ACL seal.
- Process creation becomes a server-owned coordination invariant: every
  repository and transitive-dependency spawn path must participate, including Claude
  provider/model discovery and stdio MCP, and source/dependency guards must
  detect any uncoordinated Worker or native background spawner. Irreducible
  generated-manifest owned-resource release uncertainty poisons all process creation for that owner lifetime;
  the controlled-restart bootstrap cannot be used as recovery.
- The full-spawn family owns both same-token `CreateProcessW` and restricted-token
  `CreateProcessAsUserW` qualification. It never elevates, logs on, synthesizes a
  profile, or falls back when token/session/privilege requirements are unavailable.
- CX-003's Windows SF-001 path becomes a protected native server-handle witness with
  no legitimate client connection. Its exact DACL/`OWNER RIGHTS`/mandatory policy,
  first/local/one-instance flags, handle transfer, descendant retention denial, and
  successor-after-hard-kill behavior become admission facts.
- Native-mode one-click restart changes from the current detached replacement to the
  same transient bootstrap's in-outer-job old-owner→bootstrap→new-owner handoff. Its
  durable restart record, exact memberships/generations/zero-overlap, two handle-
  transfer matrices, SQLite reacquisition, component-owned row/outbox atomicity and
  power-loss durability, and stranded-record recovery are owner-TCB
  obligations; no long-lived restart helper is introduced.
- The native primitive remains adapter-neutral and testable without provider
  credentials, quota, or repository mutation, including byte-exact full-duplex
  stdio, bounded output backpressure, high-volume progress, pending-I/O
  teardown, and event-loop responsiveness.
- Job Objects provide process-lifecycle containment for ordinary in-tree
  `CreateProcess` descendants, not a security sandbox. They do not prove
  filesystem/network/token isolation, contain externally created work such as
  WMI `Win32_Process.Create`, or stop a same-user process from acquiring and
  retaining a duplicated job handle, spoofing an out-of-job parent, injecting
  into another process, or reading a same-job privileged root's memory/token
  without a separate two-tier OS boundary.
- After resume, a hostile root can create an unnamed inner job and self-assign through
  its pseudo process handle. PC-SDK cannot enumerate that unnamed immediate job, so it
  claims only exact retained PC-SDK ancestor/leaf memberships—not an immutable total
  chain. This is an accepted non-escape/denial-of-service residual: no-breakaway PC-SDK
  ancestors still contain/terminate the tree. CX-004 proves that canary; forbidding it
  requires a new enforceable OS boundary and product/security decision.
- The declared hostile same-user scope starts with PC-SDK-created provider/lower/
  transition/Git descendants, not arbitrary pre-existing same-user malware racing
  bootstrap or owner startup. Selecting that broader threat later requires a
  separately approved OS-trusted pre-first-instruction launch anchor; protected
  install/code integrity or runtime self-DACL changes cannot substitute.
- Codex capability is explicitly unavailable outside the one sealed Windows 11
  25H2 x64 client full-revision/UBR/identity tuple within base build
  `10.0.26200`; any delta needs full requalification. The exact tuple itself remains
  production-unavailable until the separately approved protected-install/OS-policy
  receipt exists. The rest of the app remains provider-neutral.
- Codex native execution may wait on upstream stable protocol support. This is
  preferred to presenting an unverified runtime as safe.
- N5 remains open until exact subscription/no-API-billing provenance, account/
  model usability, warning-stop behavior, contained native conformance, tool/
  MCP/approval parity, context/usage degradation, dispatch, two-tier all-origin
  lower-principal enforcement, OS broker/owner-job-handle/parent-spoof/cross-
  process execution-read-token-security denial, process-capable parity, fresh
  real-fix admission, and one real specialist fix all pass.

## Accepted decision

On 2026-07-13 the product owner explicitly approved ADR-0002 as proposed and
accepted all three product-level choices together:

1. the exact repository-owned transient native cold-start/controlled-restart
   bootstrap plus C++ Node-API addon and the separately admitted pinned
   `better_sqlite3.node` PE; the same-PE non-authoritative `entry-scrub`→hard-gated
   `cold-bootstrap` internal protocol from positive scrub-watchdog arm on a provably
   unjobbed fixture, with noncancelable mode deadlines, main-path outer-job create/
   configure/query/publication plus watcher ack, atomic cold assignment, causal two-
   phase ready/job-target/ack, all-watcher-handle retirement/quiescence, protected-
   source clear/query/close, exact parent-success exit, and extra-job refusal. Keep N7
   create→scrub-arm crash/death/hard-kill and any resulting topology change an explicit
   separately approved production blocker; its routine process handle alone is
   insufficient. Keep pre-existing same-
   user malware racing the scrub child-handle window explicitly outside the declared
   descendant-origin threat and requiring a separate OS-trusted launch-anchor
   decision if selected; exact protected plain-
   Node precompiled boot artifact with
   shell/package-manager/tsx/esbuild/source-loader/preload paths non-admitted; the no-
   fallback same-token `CreateProcessW`/restricted-token `CreateProcessAsUserW` full-
   spawn family with sealed ordered inner-job vectors, implicit/borrowed/new-leaf
   ownership and cleanup, the provider-session-only exact lifecycle-plus-assign-only
   handle pair with assign-first/lifecycle-last teardown, exact least-rights job/process/
   thread derivation before ordered broad job/`PROCESS_INFORMATION` source retirement,
   exact derived-resume-handle use and positive retirement before publication, a generated closed typed-
   wrapper/static-guard/PE-digest native-resource site manifest, and global release-
   state/quarantine with exhaustive owner/borrower/no-release site/release-fault and non-vacuous exact-numeric-
   value ABA canary proof where applicable, zero nested-job UI
   restrictions, restrictive process/thread
   descriptors, mitigation/child/security-capabilities attributes, and isolated
   station/desktop; accept hostile post-resume self-nesting only as a contained denial-
   of-service residual, never as an exact total-chain receipt; a closed admitted
   bootstrap/owner-runtime Claude/MCP process-spawn
   inventory with the external N7 UI launcher/browser kept separate;
   the protected no-client SF-001 pipe, gapless cold-start witness/outer-owner-job
   handoff/lifetime, and in-job old-owner→bootstrap→new-owner restart state machine
   with exact committed-tuple binding, component-owned row-plus-outbox atomicity, and
   sealed SQLite power-loss semantics; full-lifetime native-load closure permitting
   the exact sealed Node/system set and, among optional non-host/non-system/application-
   native mappings, only owner addon then SQLite; one injected SQLite factory on every constructor,
   extension-load denial, exact package/lock/store/integrity pins, and `ws` optional-
   native exclusion; final-PE hardening, checked input/failure matrices, mandatory
   Windows CI, and future prebuild ownership; with CX-004 limited to disposable fake
   provisioning and production unavailable until a separately approved protected-
   install/OS-policy packaging/N7-launcher-lifecycle decision (no installer, elevation, WDAC/AppLocker
   mutation, self-ACL seal, or long-lived helper here);
2. one exact qualified Windows 11 25H2 x64 client full-revision/UBR/identity tuple
   within build 26200, a pinned native-identity/image-provenance runner,
   independently observed `windows-latest` non-admitted build/unsupported proof,
   and typed unsupported behavior on every identity delta/other host; and
3. stable-upgrade/wait with full version requalification, quiescent two-step
   admission, immutable policy epochs, and an all-origin empty external-action
   first gate, rejecting fork/experimental/wire/API bypasses and weaker policy.

Acceptance authorizes the auditable CX-003 decision closeout and, only after both
CX-003 landings and teardowns are positively proved, provider-neutral fake-process/
fake-principal CX-004. It does not authorize a Codex process, provider/login-home
access, production native admission, or any separately blocked provisioning,
packaging, OS-policy, or N7 launcher choice.
