# AInativePM ownership and integration discovery

Status: evidence complete; reference-first ownership proposal awaits product
acceptance before implementation.

Source receipts:

- PC-SDK Next base: clean pushed `main` at
  `a7c5423cb5a4aa8549521badcfdd320437a74def`.
- PC-SDK Next discovery branch: `codex/pm-001-ainativepm-discovery`, defined by
  `85c8fbadd43d85ec0429755ab5b9a655d0f6eeaa`.
- AInativePM initial audit snapshot: clean pushed `main` at
  `5033d5ecae931d2f60e9672849f1f5c9650125f4`.
- A concurrent external landing advanced AInativePM during proposal review. The
  final source boundary is clean pushed `main` at
  `c146162177df258a845c6aa5be40d5627f542c7c`. The bounded delta contains only
  24 `web/**` files (595 additions, 1,888 deletions), replacing the bespoke
  project board with the generic container view. UI/route claims were
  revalidated; schema, core, REST server, MCP, auth, events, folder resolution,
  and idempotency sources are byte-unchanged across the delta.
- PM-001 made no AInativePM Git edit. No explicit AInativePM mutation,
  folder-registration, auth, admin, config, or deployment operation was invoked.
  One live `get_started` call preceded the source finding that this orientation
  tool invokes first-run domain seeding before it returns the domain map
  (`AInativePM/src/tools/handlers/get_started.ts:120-133,277-284`). Without a
  pre-call snapshot or private DB inspection, no-op versus one-time marker stamp
  versus default-domain creation is inconclusive. The later observation of five
  roots cannot distinguish those cases. No further side-effect-capable live
  orientation call was made, and this slice does not claim the remote remained
  unchanged.

## Result

Adopt a **reference-first seam**, not synchronization and not a project-only
anchor:

1. A PC-SDK project may have an optional **PM context target**. The target is an
   AInativePM project, Space, or Room used to orient queries and suggestions. It
   is a hint, not an authorization boundary and not the work item.
2. A PC-SDK contract/run may carry one exact **external PM item reference**.
   That reference identifies the long-lived intent the technical run serves.
3. AInativePM remains the only authority for PM identity, hierarchy, lifecycle,
   assignment, decisions/context, membership, and PM-side content. PC-SDK
   remains the only authority for sessions, contracts, execution, verification,
   worktrees, landing, and technical evidence.
4. Strictly classified reads may be automatic and authoritative at observation
   time. `get_started` is excluded from the query port because it can seed a new
   account. AInativePM's current SSE feed is only an invalidation hint;
   reconnect always re-queries.
5. PC-SDK must not perform automatic or background PM writes with the current
   surface. A future write requires a caller-supplied idempotency key, a durable
   positive receipt/query-by-key path, an expected-version conflict contract,
   and attributable authority. None exists across the current generic mutation
   surface.
6. Attribution alone is not authority. This proposal authorizes no current PM
   write. A direct PM action requires an explicit originating user request or
   positive user approval **and** a positive app policy/approval receipt. The
   current permission-bypassed generic bridge does not satisfy that gate.
7. Once the receipt/idempotency/identity/revision prerequisites exist, the
   recommended first automatic writes are immutable evidence links from two
   distinct positive triggers: `verification:<verificationReceiptId>` and
   `landing:<landingReceiptId>`. Each has its own stable operation ID. PM
   lifecycle, assignment, context, archive, and deletion remain suggested or
   explicit rather than automatic.

This keeps both systems useful during either system's outage, preserves one
owner for every durable fact, and avoids converting PC-SDK into a second PM
application.

## As-built AInativePM map

### Domain and persistence

AInativePM's durable center is a generic `items` row. It carries type,
`parent_id` hierarchy, project/list filing, stage, completion, assignment,
dates, type-defined fields, archive state, and timestamps
(`AInativePM/src/db/migrations/036_fold_projects.sql:24-67`). The global
`thing_types` registry adds one of four behaviors—`record`, `staged`,
`time_anchored`, or `container`—plus field/display/action metadata
(`AInativePM/src/db/migrations/024_thing_types.sql:3-13`;
`AInativePM/src/core/operations.ts:400-424,568-659`). Lists, list entries,
tasks, sprints, and projects retain some type-specific branches, so the
implementation is generic by default rather than perfectly type-neutral
(`AInativePM/src/core/operations.ts:1844-2035`).

The human hierarchy is broader than software work:

```text
Space (root container)
  -> Room (nested container)
     -> projects, records, events, documents, lists, or staged work
        -> any item's Story/detail page
```

Domains are accessible root container items; Rooms nest by `parent_id`; projects
may appear below either (`AInativePM/src/core/operations.ts:2502-2552`). A second
containment axis, `project_id`, files work into a project; subtree queries
deliberately union both axes (`AInativePM/src/core/operations.ts:2449-2468`).

| PM concern | AInativePM representation and semantics |
| --- | --- |
| Identity/type | UUID item plus registry type. Registry behavior and fields drive most UI/core behavior. |
| Hierarchy | `parent_id` Spaces/Rooms/item tree plus orthogonal `project_id` filing; cycle-safe ancestor/subtree queries. |
| Membership | `item_members`; nearest ancestor owner/member role inherits down the `parent_id` tree with private-subtree pruning (`operations.ts:1132-1154,1315-1341`). |
| Lifecycle | No universal status string. Staged items use stage/transition data; unstaged items use `completed`; removal is normally `archived_at`. Completing staged work moves to Done and can be blocked by brief gates (`core/lists.ts:545-602`). |
| Assignment | One `assignee_id`, plus orthogonal `sprint_id`; moving between projects can clear an inaccessible assignee (`operations.ts:4503-4515,4620-4629`). |
| Decisions | Text in the `decisions` brief section, inherited as context from ancestors; no first-class decision identity/status/approval stream (`operations.ts:662-669,707-732`). |
| Context | Distilled `brief_sections`, raw `attachments`, and validatable `anchors`; binary `item_files` are separate (`migrations/002_context_engine.sql:14-48`, `055_item_files.sql:1-17`). |
| Links | Directional unique `item_links`; relation fields either link or reparent (`migrations/023_item_links.sql:3-24`; `operations.ts:7245-7250,7299-7340`). |
| Rules | Global change/manual/clock rules. Some rule-specific dedup exists, but effects and the `rule_runs` ledger do not share one transaction (`core/rules-engine.ts:752-828,933-982,1961-1985`). |
| Views/templates | User-scoped opaque saved-view JSON; templates are ordinary `type='template'` items. Reapplying a template creates another tree without an idempotency key (`core/templates.ts:285-420`). |
| Calendar | Ordinary timed items plus AInativePM-owned Google credentials, mappings, cursors, retry, and outbox tables (`migrations/048_gcal_sync.sql:18-83`). |
| Folder binding | User-scoped `folder_registrations` owned by AInativePM and able to target a project or any accessible generic container (`migrations/083_folder_registrations_generic_target.sql:23-45`). |
| Audit/events | Selective `history` plus specialized ledgers. UI events are process-local `EventEmitter` notifications with no durable cursor, sequence, replay, or transactional outbox (`src/events.ts:23-32`). |

Normal item deletion is archive/restore. Some files, raw context, lists, generated
rule rows, and caches have hard-delete paths. A stale external reference must
therefore remain historical PC-SDK evidence even when its PM target is archived,
deleted, or no longer accessible; it cannot be cascade-deleted from PC-SDK.

### Human UI and REST

The browser and MCP surfaces are peers over shared core operations. Representative
MCP handlers call the same functions used by REST: `create_item` calls
`coreCreateItem`, `list_items` calls `coreListItems`, `update_item` calls
`coreUpdateItemScoped`, and `set_done` calls `coreSetItemDone`
(`AInativePM/src/tools/handlers/create_item.ts:92-114`;
`list_items.ts:299-309`; `update_item.ts:344-346`; `set_done.ts:60-61`).
The matching REST mutation routes call those same scoped cores: create at
`AInativePM/src/app.ts:1951-1999`, update/archive at `2274-2290,2339-2349`, and
advance/done at `2366-2478`.

| Human surface | Meaning and shared operation |
| --- | --- |
| Today/Tasks/Events | Reusable grouped collections over cross-project reads, with distinct loading/error/empty presentation (`web/src/components/CollectionView.tsx:28-95`; `src/app.ts:1243-1279,2628-2699`). |
| Space/Room | Loads the container, children, open work, and subtree; people add/move typed items, select scoped or rolled-up views, share, pin, configure, and archive (`web/src/components/ContainerView.tsx:174-217,435-537,653-711`). |
| Explorer/type view | Every registry type is globally browseable and can use Table/List/Calendar plus behavior-driven Gallery/Kanban (`web/src/components/TypeView.tsx:237-274,390-415`; `web/src/App.tsx:1717-1731`). |
| Story/detail | Universal item chassis. Work items show legal stages, assignee, sprint, dates, subtasks, brief, context, and gates; records show registry fields, relations, files, body, and backlinks (`web/src/components/StoryPage.tsx:145-214`; `CardDetail.tsx:700-870`; `ThingDetail.tsx:540-690`). |
| Project | A project remains a stage-owning item, but is rendered through the same `ContainerView` surface as a Space/Room rather than claiming `container` registry behavior. Project selection opens that surface; its merged Tasks group is pinned first and switches through a read-only Kanban plus Table/List/Calendar. Legal transitions, project brief, and routing description live in generic `ThingDetail`, not the Kanban (`web/src/App.tsx:948-952,1109-1118,1844-1853`; `web/src/lib/containerTypes.ts:80-92,165-180,302-310`; `web/src/components/TypeViewCore.tsx:62-65,133-134`; `web/src/components/BoardCollectionView.tsx:12-16,31-40`; `web/test/container-view.spec.tsx:814-860`; `web/src/components/ThingDetail.tsx:619-690`). |
| Lists | Shared/global or project-local list containers with nested entries, ordering, completion, fields, and rollups (`web/src/components/ListView.tsx:1040-1119,1176-1436`). |
| Context/evidence | Story gravity rail, brief sections, raw research/context, anchors, synthesis, history, and files (`web/src/components/GravityRail.tsx:113-126,437-460`; `AgentContextDetails.tsx:128-359`). |
| Sharing | Projects and generic containers inherit owner/member access down the hierarchy; Lists use their own scope semantics (`web/src/components/ShareItem.tsx:7-13,100-198`). |

No first-class comment thread or discussion service was found. AInativePM owns
management decisions and context through brief/body/attachments/history;
PC-SDK owns execution chat, asks, agent communication, and transcripts. A link
may connect them, but “discussion” is not silently assigned to a nonexistent PM
state machine.

Failure display is uneven. Collection/type/global-calendar reads have explicit
error/Retry states, and generic stage/detail actions surface errors. Several
container-subquery, context/hub, default-view, and reorder failures are
logged or projected as empty data. The PM adapter must not copy that ambiguity:
`unavailable` and `not_found_or_inaccessible` remain distinct from an
authoritative empty result.

### Deep links

AInativePM has stable hash routes (`AInativePM/web/src/lib/router.ts:51-100,160-203`):

- `#/item/<item-id>` — preferred universal external item reference;
- `#/space/<container-id>` and `#/space/<container-id>/<type-key>`;
- `#/list/<list-id>` and type/explorer/global routes.

`#/project/<project-id>[/view]` remains an inbound compatibility alias only; it
drops the old view segment and resolves to canonical `#/space/<project-id>`
(`AInativePM/web/src/lib/router.ts:84-90`;
`web/test/router.spec.ts:54-58`). New links do not emit the legacy project route.

An item URL cold-loads with a safe base history entry, and Story exposes Copy
link (`AInativePM/web/src/App.tsx:687-713`;
`web/src/components/StoryPage.tsx:222-230,421-425`). PM content can already
carry a generic clickable URL field, Markdown link, or context attachment URI.
It has no dedicated PC-SDK run-evidence widget.

PC-SDK currently has no stable session/run route. A source audit found only the
onboarding query parameter in `apps/web/src/App.tsx:43`; there is no hash-change,
history, or router path in `apps/web`. A stable PC-SDK run/deliverable URL is a
prerequisite before PM can link to authoritative technical evidence.

## MCP, auth, scope, and retry evidence

### Auth is identity, not project isolation

Both web and MCP ultimately resolve an authenticated user. A PAT may add a
`defaultProjectId`, but it does not narrow that user's authorization
(`AInativePM/src/auth.ts:255-292`). The default is consumed only by omitted-
project create/batch-create, the board branch of `list_items`, and
`next_action` (`tools/handlers/create_item.ts:49-73`;
`list_items.ts:299-309`; `next_action.ts:16-20`). A token can still enumerate
all accessible projects with `list_items(type='project')`
(`list_items.ts:146-158`).

Therefore:

- per-project PATs are routing convenience, not least-privilege isolation;
- the PAT default is not a universal target;
- most commands use `item_id`, `parent_id`, `under`, or `container_id`, not a
  universal `project_id`;
- there is no `list-projects` MCP tool; the generic query is
  `list_items(type='project')` (`AInativePM/src/server.ts:309-323`).

Admin/setup tool visibility is a per-user discoverability setting, not a new
authorization boundary. On stateless HTTP, changing it requires reconnect for
the advertised schema to change (`AInativePM/src/server.ts:561-622`). PC-SDK
must never toggle that setting as integration setup.

### Current mutation safety

Generic creates mint a new UUID for every call. Generic updates have neither a
request ID nor an expected-revision predicate
(`AInativePM/src/tools/handlers/create_item.ts:13-33`;
`src/core/operations.ts:2146-2147,4651-4678`). The process-local event feed has
no durable replay/cursor. Some specialized subsystems have bounded local dedup
or retries, but they are not a general PM mutation receipt.

Source registers 63 handler tools plus the always-callable admin-visibility
toggles; 11 handler names are deferred from the ordinary advertised schema
(`AInativePM/src/tools/index.ts:66-158`; `src/server.ts:599-624`). That source
would advertise 54 tools with the deferred group hidden or 65 with it shown.
The live connected schema exposed 59, so deployed-version/connector/capability
drift is unresolved; the count is not evidence of either admin state. An exact
live-schema audit found no caller idempotency-key field on any advertised tool
and no general query-by-operation receipt. `create_items` and `update_items` promise
all-or-nothing batches; that is transaction scope, not safe retry after an
unknown response. A timeout after a create or update is therefore
**inconclusive**, never permission to retry blindly and never proof of failure.

The handler convention adds another adapter requirement. Handlers return a
`{state,next_valid_actions}` envelope which the MCP registry serializes into
text (`AInativePM/src/tools/registry.ts:11-33,41-80`). Logical failures commonly
return `state.error` without MCP `isError` (`tools/handlers/create_item.ts:229-244`;
`update_item.ts:384-401`; `resolve_project.ts:34-45`). PC-SDK currently checks
only MCP-level `isError`, so a strict PM adapter must parse and validate the
inner envelope before claiming success.

`get_started` is not a query despite its orientation name: it calls
`coreSeedDefaultDomains` and swallows seeding errors
(`AInativePM/src/tools/handlers/get_started.ts:120-133`). The read-only port uses
`resolve_project`, `get_item`, and explicit list queries instead. REST
`/auth/me` returns opaque `user.id` but also calls the seeder; MCP has no
side-effect-free principal probe, and neither health surface exposes an
immutable remote-authority/instance fingerprint. Both pins are prerequisites
for write readiness.

The minimum future write contract is:

1. caller-supplied stable operation key scoped by remote authority, principal,
   PC-SDK app instance/caller, and operation ID;
2. canonical request digest stored with the key; identical replay returns the
   byte-equivalent prior receipt, while same key/different digest is a hard
   idempotency conflict;
3. mutation, target/effect-bound receipt, and PM event/outbox commit together;
4. receipt records operation/key scope, request digest, target, effect,
   committed time, revision, authority/approval, and retention horizon;
5. receipt lookup by the full key after timeout/restart; expiry never makes the
   key reusable or a retry safe, and receipts live at least as long as the
   originating PC-SDK evidence/recovery horizon;
6. explicit `applied`, `already_applied`, `rejected`, `conflict`,
   `not_dispatched`, or `unknown` result;
7. expected version/revision for overwrites and lifecycle transitions;
8. side-effect-free immutable remote-authority and authenticated-principal
   identity so endpoint/credential drift fails closed;
9. durable PM event/outbox cursor or explicit query-heal semantics for
   projections; and
10. a PC-SDK command intent committed before transmission with the same
    operation ID, target, request digest, authority/policy receipt, and pending
    state, so crash recovery can query the external receipt without losing K.

Until both the PM receipt seam and the PC-SDK policy gate exist, this integration
port exposes no PM command. An interactive PM action elsewhere in the product
must still have an explicit originating user request/approval, a positive app
policy receipt, visible lifecycle, and no hidden retry; model attribution alone
is insufficient.

### Live bounded observation

The current PM connector was exercised through query/orientation tools only;
the `get_started` seeding caveat is recorded in the source receipts above.
Private titles, item IDs, and token values were not recorded in this receipt.

- 25 current thing types: 15 record-behavior, 3 staged, 4 time-anchored, and 3
  containers; 21 are global and 4 use the legacy area scope label.
- Five root domains and one active sprint were observed after `get_started`;
  the domain count is not a pre-call state receipt.
- Five current folder registrations reported binding-kind labels of two
  `container`, two `room`, and one `project`. The targets were not independently
  access-queried, and `container` can also be a fallback label for a missing
  target, so this is not a five-valid-target claim.
- The original PC-SDK and AInativePM checkout paths each resolved by exact path
  to a Room/container. PC-SDK Next and its PM-001 worktree were not registered.
- The PC-SDK Next Git remote did not resolve a folder target.

This directly disproves the inherited assumption that a registered source
folder necessarily maps to a PM project. It also shows why a worktree path
cannot inherit a main-checkout path binding by convention. Folder resolution is
an optional PM-owned orientation hint, not PC-SDK authority.

Source adds one guard requirement: registration writes access-check the target,
but later path/remote resolution does not re-check current item access
(`AInativePM/src/core/operations.ts:6543-6587,6792-6842,6855-6890`). A resolved
hint must therefore be followed by an access-checked item query before PC-SDK
projects it as available.

## Current PC-SDK seam

PC-SDK currently carries `pmRef` as a nullable string:

- contract DTO and guard: `packages/contracts/src/contracts.ts:192-198,328`;
- run, contract, and pending-ask persistence:
  `packages/db/src/schema-agent-system.ts:91-93,167-182,267-268`;
- HTTP and orchestrator tool input:
  `apps/server/src/http/agent-runs.ts:62` and
  `packages/domain/src/tool-registry.ts:619-634`;
- dispatch copies it into the contract/run, continuations, asks, terminal
  envelopes, and independent review:
  `apps/server/src/dispatch/service.ts:445,490,517,699,1431,2169,2471,2501`;
- prompt projection emits one plain `pmRef:` line:
  `apps/server/src/dispatch/prompt.ts:142-149`.

The guard accepts any string or null. PC-SDK does not parse the provider,
connection, item identity, or URL; query existence/type/access; update PM; or
render a deep link. `pmRef` is absent from the browser source and from the
`AgentRunDto` mapper, although a worker can read it through `pc_get_contract`.
Specialists currently receive no remote MCP bridge. `pmRef` is therefore
durable traceability for contracts/terminal prose, not an end-to-end PM
integration. That is safer than copied PM truth, but too weak for the intended
typed seam.

The current MCP manager globally seeds AInativePM from
`PC_AINATIVE_PM_URL`/`PC_AINATIVE_PM_TOKEN` or a command, probes it, caches
tools, and exposes a typed health snapshot without blocking boot
(`apps/server/src/mcp/manager.ts:40-54,88-159,170-196`). Today the raw bearer can
still be part of stored transport configuration. The N6 vault and explicit
consumer-attachment boundary remains required; PM integration must refer to a
vault-backed connection, never copy credentials into projects/contracts/runs.

Current discovery health is only a boot/reload `tools/list` probe. It does not
prove the expected principal, required PM queries, logical handler behavior, or
write readiness, and the manager never currently produces its declared
`degraded` state (`apps/server/src/mcp/manager.ts:40-60,87-131`). Remote calls
are single-attempt with a 120-second timeout; a timed-out mutation may already
have committed (`apps/server/src/mcp/client.ts:56-90,114-135`). The bridge also
passes raw remote content to the model and drops AInativePM's server-level
operating instructions (`apps/server/src/mcp/client.ts:15-20,92-110`;
`apps/server/src/mcp/bridge.ts:78-89`).

Although persistence anticipates global/project registry rows, secret refs, and
per-agent tool attachments, current composition includes every healthy server
for the orchestrator and does not apply attachment/tool-subset policy;
specialists get none. Missing AInativePM config creates no visible unconfigured
row, and discovery persistence plus its resource event are not one transaction.
These are N6 manager gaps, not behavior the PM adapter may treat as reliable.
More critically, current orchestrator composition sets `bypassPermissions: true`
and the MCP bridge allowlists every discovered remote tool
(`apps/server/src/index.ts:126-159`; `apps/server/src/mcp/bridge.ts:51-75`). It
cannot serve as a positive SEC-002 approval receipt for mutating PM tools.

## Ownership decision

| Concern | Authority | Cross-system rule |
| --- | --- | --- |
| Long-lived intent and acceptance context | AInativePM | PC-SDK stores an attributed item ref; it may query a current observation. |
| PM item/type identity and hierarchy | AInativePM | Never mirror the type registry, Spaces/Rooms, parent tree, project filing, or folder registrations. |
| PM stage/status/completion | AInativePM | PC-SDK completion never implies PM Done. Any update is a separate explicit command. |
| Assignment, membership, sharing | AInativePM | PC-SDK runtime account/specialist is not a PM assignee/member unless PM says so. |
| Decisions, brief, management context | AInativePM | Reference or deep-link; do not fork brief text into PC-SDK-managed truth. AInativePM has no first-class discussion thread at this commit. |
| Execution chat, asks, agent communication | PC-SDK | PM may hold a link or concise management summary, never a copied transcript or chat state. |
| PM files, relations, rules, views, templates, calendar | AInativePM | PC-SDK does not reproduce or administer them. |
| Runtime/account/model/effort sessions | PC-SDK | PM may hold a deep link, never provider-native session truth. |
| Contract, run lifecycle, asks, cancellation | PC-SDK | PM may observe linked evidence; PM stage does not drive a hidden run transition. |
| Worktree, verification, review, landing | PC-SDK | Positive PC-SDK receipts remain authoritative regardless of PM availability. |
| Transcripts, diffs, technical artifacts | PC-SDK | PM stores a stable URL/reference plus human summary at most, not copied transcripts or mutable receipt fields. |
| PM deletion/archive/access loss | AInativePM for PM visibility; PC-SDK for history | Preserve the historical external ref and show `not_found_or_inaccessible`; never erase run evidence. |
| Audit provenance | Each owner | A cross-system mutation receipt links both identities without claiming the other system's audit is complete. |
| Disagreement | Concern owner | Display both labeled observations; never reconcile by last timestamp or overwrite the authority. |

"Progress" must be labeled by owner. PC-SDK owns execution progress such as
building/verifying/merge-ready; AInativePM owns management progress such as a
stage or completion flag. Neither is a projection of the other.

## Proposed typed PM port

This is a provider-neutral application/domain port, not an MCP tool mirror.
`systemId` selects a registered PM adapter; the AInativePM adapter maps its
native project/container/type/stage vocabulary behind the port.

```ts
type PmSystemId = Brand<string, 'PmSystemId'>;
type PmConnectionId = Brand<string, 'PmConnectionId'>;
type PmAuthorityId = Brand<string, 'PmAuthorityId'>;
type PmPrincipalId = Brand<string, 'PmPrincipalId'>;
type PmItemId = Brand<string, 'PmItemId'>;

interface ConnectionBoundPmItemRef {
  version: 1;
  verification: 'connection-bound';
  systemId: PmSystemId;
  connectionId: PmConnectionId;
  itemId: PmItemId;
}

interface VerifiedPmItemRef {
  version: 1;
  verification: 'verified';
  systemId: PmSystemId;
  connectionId: PmConnectionId;
  authorityId: PmAuthorityId;
  principalId: PmPrincipalId;
  itemId: PmItemId;
}

type ExternalPmItemRef = ConnectionBoundPmItemRef | VerifiedPmItemRef;

interface LegacyPmRef {
  version: 0;
  verification: 'legacy-display-only';
  raw: string;
}

type StoredPmRef = ExternalPmItemRef | LegacyPmRef;

interface PmContextTarget {
  ref: ExternalPmItemRef;
  kind: 'workspace' | 'container';
  providerKind: string;
  source: 'explicit' | 'folder-registration';
}

type PmAvailability =
  | { state: 'available'; identity: 'verified'; observedAt: number }
  | {
      state: 'degraded';
      reason:
        | 'authority_unverifiable'
        | 'principal_unverifiable'
        | 'required_query_missing'
        | 'tool_surface_drift';
      observedAt: number;
    }
  | { state: 'stale'; staleSince: number; reason: string }
  | { state: 'unavailable'; reason: 'network' | 'timeout' | 'auth' | 'server' }
  | { state: 'authority_mismatch'; expected: PmAuthorityId }
  | { state: 'principal_mismatch'; expected: PmPrincipalId }
  | { state: 'unsupported'; capability: string };

interface AvailablePmItemObservation {
  state: 'available';
  ref: VerifiedPmItemRef;
  identity: 'verified';
  freshness: 'fresh';
  title: string;
  itemType: string;
  archived: boolean;
  deepLink: string;
  observedAt: number;
  revision: string | null;
}

type PmItemObservation =
  | AvailablePmItemObservation
  | {
      state: 'stale';
      ref: ExternalPmItemRef;
      staleSince: number;
      reason: string;
      lastKnown: AvailablePmItemObservation;
    }
  | {
      state: 'degraded';
      ref: ConnectionBoundPmItemRef;
      reason: 'identity_unverifiable' | 'capability_missing';
      observedAt: number;
      data?: {
        title: string;
        itemType: string;
        archived: boolean;
        deepLink: string;
        revision: string | null;
      };
    }
  | { state: 'not_found_or_inaccessible'; ref: VerifiedPmItemRef; observedAt: number }
  | { state: 'unavailable'; ref: ExternalPmItemRef; reason: string; observedAt: number }
  | { state: 'malformed'; ref: ExternalPmItemRef; reason: string; observedAt: number };

interface PmQueries {
  health(connectionId: PmConnectionId): Promise<PmAvailability>;
  resolveContext(input: {
    connectionId: PmConnectionId;
    path?: string;
    gitRemote?: string;
  }): Promise<
    | { state: 'resolved'; target: PmContextTarget }
    | { state: 'no_match' }
    | { state: 'ambiguous'; candidates: PmContextTarget[] }
    | { state: 'unsupported'; reason: string }
    | { state: 'unavailable'; reason: string }
  >;
  getItem(ref: ExternalPmItemRef): Promise<PmItemObservation>;
}

type PmMutationAuthority =
  | { kind: 'user-request'; messageId: string }
  | { kind: 'user-approval'; approvalId: string }
  | {
      kind: 'automatic-evidence-policy';
      policyId: string;
      policyVersion: number;
      sourceEventId: string;
      source:
        | { kind: 'verification'; verificationReceiptId: string }
        | { kind: 'landing'; landingReceiptId: string };
    };

interface PmMutationRequest<TAction> {
  operationId: string;
  callerInstanceId: string;
  ref: VerifiedPmItemRef;
  action: TAction;
  requestDigest: string;
  expectedRevision: string | null;
  authority: PmMutationAuthority;
  policyDecisionReceiptId: string;
}

interface PmMutationReceiptEnvelope {
  operationId: string;
  callerInstanceId: string;
  systemId: PmSystemId;
  authorityId: PmAuthorityId;
  principalId: PmPrincipalId;
  ref: VerifiedPmItemRef;
  requestDigest: string;
  requestedEffect: string;
  policyDecisionReceiptId: string;
  observedAt: number;
}

interface ExternalTerminalPmReceipt extends PmMutationReceiptEnvelope {
  externalReceiptId: string;
  recordedAt: number;
  retainedUntil: number | null;
}

type ExternalTerminalPmOutcome =
  | {
      state: 'applied' | 'already_applied';
      committedAt: number;
      revision: string | null;
    }
  | { state: 'rejected'; reason: string }
  | { state: 'idempotency_conflict'; priorRequestDigest: string }
  | { state: 'conflict'; currentRevision: string | null };

type PmMutationReceipt =
  | (ExternalTerminalPmReceipt & ExternalTerminalPmOutcome)
  | (PmMutationReceiptEnvelope & { state: 'not_dispatched'; reason: string })
  | (PmMutationReceiptEnvelope & {
      state: 'unknown';
      reason: 'timeout' | 'disconnect' | 'malformed';
    });
```

`PmCommands` remains unsupported until AInativePM can honor the receipt contract
above. Future commands should be small product operations such as append-
execution-evidence or request-lifecycle-transition, not a generic escape hatch
for every MCP tool.

`requestDigest` covers the canonical action, target, expected revision,
authority source, and `policyDecisionReceiptId`; every result repeats that
binding. A user message/approval supplies intent, while the policy decision
receipt is the separate positive PC-SDK authorization required by SEC-002.

`authorityId` identifies the immutable remote PM authority/instance;
`principalId` identifies the authenticated subject. Neither is an endpoint,
email, or token. Current REST `/auth/me` exposes opaque `user.id`, but that route
also invokes default-domain seeding (`AInativePM/src/app.ts:422-435`); the MCP
surface has no side-effect-free principal probe, and `/health` exposes no remote
instance fingerprint. A connection-bound ref can support degraded read-only
display, but only a verified ref may reach `PmCommands`. Endpoint changes mint a
new PC-SDK connection identity rather than mutating a connection beneath stored
refs. Credential changes revalidate both pins; mismatch requires explicit
rebind.

The generic port retains an `ambiguous` result even though today's
`resolve_project` chooses one longest path or the first matching Git remote
(`AInativePM/src/core/operations.ts:6807-6839`). The adapter may use a path match
only after target re-query. Remote-only resolution is `unsupported` until PM
offers an ambiguity-preserving accessible query; it must not project the first
match as authoritative. The PAT default is absent because no read tool exposes
it.

An event port may publish only `PmInvalidationHint` with connection/ref/resource
and observation time today. It must trigger a query. It cannot carry truth or
advance a durable PC-SDK state machine because the current SSE source has no
replay cursor or transactional outbox.

### Reference storage and migration

Replace the unconstrained `pmRef: string | null` in one coordinated migration
with a versioned typed reference. Do not keep a parallel legacy/write path.
Historical strings require a conservative migration:

- migrate every historical string—including a bare valid UUID—to `LegacyPmRef`
  display-only provenance because it lacks confirmed system, connection,
  authority, and principal identity;
- a recognized URL may extract a candidate item ID for a rebind UI, but it does
  not become a live ref until the user confirms an immutable connection and the
  adapter verifies authority/principal where supported;
- never guess a connection, authority, principal, workspace/container, or item
  from a title, callsign, bare ID, or endpoint;
- new contracts accept only `ExternalPmItemRef`; legacy rows have no query or
  command path;
- continuations/reviews inherit the exact immutable reference from the parent
  contract/run as they do today.

The optional project-level PM context target is a different field and type. It
must never default `contract.pmRef` to the target itself; a Space/Room/project is
orientation, whereas the contract reference should normally be the exact item
representing the long-lived work.

## Interaction sequences

### Orient and dispatch

```text
Open PC-SDK project
  -> query explicit PM context target, else resolve an access-rechecked path hint
  -> remote-only hint is unsupported until ambiguity-preserving query exists
  -> resolved / no-match / ambiguous / unsupported / unavailable is visible
User or orchestrator selects an exact PM item
  -> getItem query when available
  -> create PC-SDK contract with immutable ExternalPmItemRef
  -> dispatch proceeds even if PM later becomes unavailable
```

No-match does not create a folder registration or PM item. An unavailable query
does not erase an existing reference. An explicitly supplied syntactically
valid reference may be recorded with `unavailable` validation state; PC-SDK
execution is not blocked by PM health.

### Execution, verification, and evidence

```text
PC-SDK run progresses
  -> persist PC-SDK run/contract/worktree/verification events only
  -> optionally re-query PM item for display
Run verifies and lands
  -> PC-SDK stores positive technical receipts
  -> UI proposes PM evidence link / lifecycle action
  -> PM remains unchanged unless an attributed explicit command succeeds
```

The PM evidence link targets a stable PC-SDK run/deliverable URL. The PM entry
may contain a short human summary, but hashes, verification, ancestry, and
landing receipts stay in PC-SDK.

### Retry and recovery after an external write (future)

```text
PC-SDK transactionally stores pending intent K, target, request digest,
authority/policy receipt, and exact source evidence receipt
  -> outbox/dispatcher submits K once
  -> applied/rejected/conflict receipt: persist terminal result
  -> timeout/disconnect: persist unknown; do not retry mutation
Recovery
  -> query AInativePM receipt by the full authority/principal/caller/K scope
  -> found: persist exact terminal result
  -> still unknown: require user/orchestrator resolution; never infer success
```

### Deletion, access loss, and disagreement

- AInativePM `404` intentionally cannot prove whether an item is absent or
  inaccessible. Project `not_found_or_inaccessible`, retain the ref, and do not
  delete or relink automatically.
- An archived PM item may still have valid historical PC-SDK runs. Show archive
  state if positively observed.
- A PM Done state does not complete/cancel/land a PC-SDK run. A completed or
  cancelled PC-SDK run does not change PM stage.
- If the user requests a conflicting PM update, use expected revision. Conflict
  exposes the new PM observation and the proposed action; no last-write-wins.

## Action authority

| Class | Allowed behavior |
| --- | --- |
| Automatic, read-only | Health/query, access-rechecked folder/path resolution, deep-link construction, exact parent-reference inheritance, cache invalidation followed by refetch, and visibly stale/unavailable projection. Remote-only resolution waits for an ambiguity-preserving capability. |
| Suggested, no side effect | Attach/select exact PM item, choose/repair a PM context target, create a PM item, add a PC-SDK evidence link, or advance/reopen/complete the PM item after PC-SDK evidence exists. |
| Explicit user-authorized command, after app policy gate exists | Item create/update/stage/completion, assignment, brief/context, link/file action, folder registration, or another permitted everyday PM operation. It requires an originating user request/positive approval plus an app policy receipt; no autonomous model authority or hidden retry. |
| Separate high-risk authority | Membership/sharing, archive/delete, type/rule/template/calendar administration, admin-tool visibility, credentials, connection configuration, or deployment. None is implied by linking a run. |
| Prohibited background behavior today | Automatic PM creation, progress/status mirroring, completion/cancellation sync, folder registration repair, evidence upload, or any retryable mutation. |

Recommended future policy after the full command receipt contract is proven:
an immutable, deduplicated PC-SDK evidence-link append may be automatic from
either (a) one positive deterministic verification receipt or (b) one positive
landing/ancestry receipt. These are separate evidence kinds with operation IDs
derived from their exact receipt IDs; verification cannot masquerade as landing
and neither changes PM status. All PM management-state changes remain suggested
or explicitly authorized. The full idempotency key is additionally scoped by
remote authority, principal, and PC-SDK app instance/caller, so two app
instances or two PM authorities cannot collide on the same local receipt ID.

## Failure matrix

| Condition | Typed result | PC-SDK behavior |
| --- | --- | --- |
| No PM connection/attachment | `unsupported` or `unavailable` | Keep chat/dispatch/verification available; show setup/degraded state. |
| Auth expired/forbidden | `unavailable(auth)` | Preserve refs; prompt connection repair; never report item absent. |
| Credential resolves a different principal | `principal_mismatch` | Disable PM queries/writes for that connection until explicit rebind; never reinterpret stored item IDs. |
| Network/timeout/server failure on read | `unavailable` | Preserve last observation as stale; no empty-state substitution. |
| `404` item read | `not_found_or_inaccessible` | Preserve historical ref/evidence; offer relink only by explicit action. |
| Malformed or unexpected schema | `malformed` | Fail closed, retain raw-safe diagnostic, no inferred fields. |
| SSE disconnect/gap | invalidation confidence lost | Mark observations stale and re-query; never replay inferred events. |
| Folder path/remote no match | `no_match` | No context target; do not register automatically. |
| Multiple plausible folder targets | `ambiguous` | Show candidates; do not choose by recency/name. |
| Remote-only resolution cannot expose all matches | `unsupported` | Do not use today's first matching registration as authority; wait for an ambiguity-preserving query. |
| Folder hint resolves but target query fails | `not_found_or_inaccessible` or `unavailable` | Do not trust registration metadata as current access proof; keep it only as a stale hint. |
| Mutation rejected | `rejected` | No local PM-success projection; show exact safe reason. |
| Mutation version mismatch | `conflict` | Re-query and require a new decision; never overwrite. |
| Mutation timeout/disconnect | `unknown` | Never retry or infer. Query by operation ID when supported; otherwise escalate. |
| Idempotency/receipt or app-policy capability absent | `unsupported` for command | Expose no integration command. A separate interactive PM action still requires explicit user request/approval plus a positive app policy receipt; the current bypassed bridge is insufficient. |
| Inner `{state.error}` with MCP success | typed PM failure | Strictly parse the PM envelope; never accept transport success as domain success. |

## Superseded anchoring assumptions

The inherited `docs/pm-anchoring.md` design is rejected as an implementation
plan:

1. **Project-only target:** false. Folder targets may be projects, Spaces, or
   Rooms, and long-lived work should normally reference an exact item.
2. **Per-project PAT isolation:** false. PAT defaults do not restrict the
   authenticated user's accessible domain.
3. **Default applies to every call:** false. Only a few handlers consume it.
4. **Universal `project_id`:** false. Generic operations are item/container/
   subtree addressed.
5. **`list-projects` tool:** nonexistent; use `list_items(type='project')`.
6. **PC-SDK setting is sole truth and folder binding derived:** false.
   AInativePM owns independently mutable user-scoped registrations.
7. **Register folder during anchor:** unsafe today and wrong for worktrees; it is
   an external mutation without the required receipt/idempotency contract.
8. **Prompt instruction enforces target:** false as policy. It can orient a
   model, but it is neither scope enforcement nor an authorization boundary.
9. **Anchor automatically becomes `contract.pmRef`:** false. Context target and
   exact work-item reference are separate concepts.

## Rejected duplications

PC-SDK will not add:

- an internal work-item table, board, workflow builder, PM stage machine, or PM
  assignee state;
- a mirror of AInativePM types, Spaces/Rooms, project hierarchy, membership,
  decisions/brief, links, rules, saved views, templates, calendars, files, or
  folder registrations;
- token-per-project pseudo-isolation or project credentials in project settings;
- copied transcripts/diffs/verification rows as PM-owned evidence;
- an SSE-derived PM replica or last-timestamp conflict policy;
- automatic PM Done/cancelled state derived from PC-SDK terminal prose;
- a folder-binding compatibility shim for worktree paths;
- direct AInativePM SQLite reads or shared database ownership.

## Dependency-ordered implementation proposal

After product acceptance, implementation should remain split into bounded
slices:

1. Add stable PC-SDK session/run/deliverable deep links and access-safe HTTP
   projection. This is useful independently and enables reciprocal evidence.
2. Complete the N6 vault/consumer-attachment policy and immutable endpoint
   connection identity. Do not expose mutating PM tools through the current
   permission-bypassed generic bridge.
3. Add side-effect-free AInativePM authority/principal/capability queries and an
   immutable remote-instance fingerprint. Prove account/endpoint drift fails
   closed before a write-capable ref exists.
4. Introduce the typed read-only PM connection/ref/query port, strict
   AInativePM adapter, health/freshness/degradation states, and one-path
   migration from `pmRef` to live or legacy-display-only variants.
5. Add optional explicit PM context target and read-only path resolution. Keep
   remote-only resolution unsupported until the PM query preserves ambiguity.
   Do not write registrations.
6. Render linked PM observation/deep link on contract/run surfaces without
   copying status into PC-SDK truth.
7. Separately add the idempotency/receipt/revision contract to AInativePM and
   prove timeout/restart/duplicate behavior.
8. Only then add the approved immutable PC-SDK evidence-link operation. The
   recommendation is automatic append from separately keyed positive
   verification and positive landing receipts. Lifecycle and other management
   changes remain suggested/explicit.

## Product decision requested

Accept or reject this direction:

> PC-SDK uses optional generic PM context plus exact external item references;
> AInativePM owns all PM truth; PC-SDK owns all technical execution truth; reads
> and deep links may be automatic. Evidence append remains blocked until PC-SDK
> has stable access-safe run links, vault-backed consumer policy, a positive app
> policy/approval receipt, and durable local intent/outbox recovery **and**
> AInativePM exposes receipt-backed, authority- and principal-pinned idempotent
> commands with revisions. Only then may PC-SDK automatically append an
> immutable evidence link from each separately keyed positive verification or
> landing receipt; PM lifecycle and other management-state changes remain
> suggested or explicit.

Acceptance approves the ownership seam, dependency order, and future evidence-
append policy. It does not authorize a current remote write, schema migration,
UI design, or automatic lifecycle policy. Rejection should identify which
ownership boundary or desired automatic update differs.

## Remaining known unknowns

- Deployed `PM_RULE_MODE`, Google Calendar push flag, replica count, and live DB
  health were not inspected.
- Data-dependent signed-in UI discoverability, mobile ergonomics, OAuth cold
  deep links, archived/forbidden link presentation, and partial Railway outage
  presentation remain visual QA questions. Source/tests establish the routes and
  current error behavior without authorizing live mutation.
- The current live registry may already contain a generic URL field suitable
  for PC-SDK evidence; private type definitions were not copied into this
  receipt.
- AInativePM's current direct tool response is useful to an interactive caller,
  but there is no proven durable cross-restart mutation receipt contract.
