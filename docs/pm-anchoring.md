# PM context and references

Status: the inherited project-anchor implementation is superseded by PM-001
evidence. The replacement direction below is proposed, not yet product-accepted
or authorized for implementation.

Authority: `docs/research/ainativepm-discovery.md` contains the source receipts,
ownership table, failure matrix, typed port, and requested product decision.

## Verdict on the inherited design

The old design treated every PC-SDK project as belonging to one AInativePM
project and proposed a PC-SDK setting, prompt instruction, per-project PAT, and
automatic folder registration as enforcement. Joint source/UI/MCP inspection
shows that model is materially wrong.

| Inherited claim | Evidence verdict | Replacement |
| --- | --- | --- |
| Every anchor is an AInativePM project | Rejected. Folder targets and human domains may be a project, Space, or Room; the technical run normally serves one exact item. | Separate an optional generic PM context target from an exact contract/run item reference. |
| Folder binding is a project backstop | Rejected as enforcement. It is user-scoped PM state, can target project/container, is independently mutable, and sibling worktrees do not inherit an exact-path binding. | Query it as an orientation hint; do not write or mirror it automatically. |
| A per-project PAT is isolation | Rejected. A PAT authenticates the full user and only supplies a limited default-project hint. | Security comes from a vault-backed connection, pinned remote authority/principal, tool/consumer policy, and PM authorization—not a default. |
| The PAT default applies to every tool | Rejected. Only selected create/list/next-action handlers consume it. | Send explicit typed item/container parameters when an authorized action requires them. |
| Every tool accepts `project_id` | Rejected. Generic operations are variously item-, parent-, subtree-, container-, or global-scoped. | Use the narrow PM adapter operation, not a universal project override. |
| A `list-projects` MCP tool drives a picker | Rejected. The canonical query is `list_items(type='project')`; no `list-projects` tool exists. | Adapter queries return strict provider-neutral observations. |
| PC-SDK setting is truth; folder registration is derived | Rejected. AInativePM owns durable folder registrations and another same-user client can change them. | Do not create a competing folder map. Explicit PC-SDK context is only a local preference; resolved PM registration remains a fresh observation. |
| Prompt text enforces the target | Rejected. Instructions orient a model but do not constrain authorization or tool scope. | Enforce scope through typed ports, explicit refs, connection/principal identity, permissions, and receipts. |
| Anchor becomes `contract.pmRef` | Rejected. A context container and the exact long-lived work item are different identities. | Contract/run stores an immutable exact external item reference. |

## Proposed replacement

```text
PC-SDK project
  -> optional PM context target
     { system, immutable connection, authority/principal verification,
       workspace-or-container item, source }
     used only for orientation/query defaults

PC-SDK contract/run
  -> exact external PM item reference
     { system, immutable connection, authority/principal verification, item id }
     immutable across continuations and independent review
```

AInativePM owns item identity/type, hierarchy, lifecycle, assignment,
membership, decisions/context, files/links, rules, views/templates, calendar,
and folder registrations. PC-SDK owns sessions, contracts, run progress, asks,
worktrees, verification, review, landing, and technical evidence. Each side may
hold a stable deep link to the other's truth; neither copies the other's state
machine.

The context target never automatically becomes the contract item reference. A
folder/path/remote match can be absent, ambiguous, stale, or unavailable. Those
are visible states, not reasons to register a folder or guess a target.
Current remote-only resolution cannot expose duplicate matches, so it remains
unsupported until AInativePM offers an ambiguity-preserving query.

## Write boundary

Automatic behavior is read-only: health, context resolution, exact item query,
deep-link construction, parent-reference inheritance, and invalidation/refetch.

PM creation, folder registration, evidence attachment, lifecycle transition,
assignment, context, archive, or administration is never a hidden side effect.
This proposal authorizes no current PM write: the generic bridge bypasses app
permissions and therefore supplies attribution but not authority. A future
interactive action requires an explicit originating user request/approval plus
a positive app policy receipt and visible lifecycle. Background integration
writes remain blocked until AInativePM also provides caller idempotency keys,
durable positive receipts/query-by-key, expected-version conflict handling,
remote-authority/principal pinning, and durable event or query-heal semantics.

PC-SDK completion, cancellation, verification, or landing never implies a PM
stage change. The UI may suggest a PM action after technical evidence exists.
The proposed first automatic write after all receipt prerequisites land is an
immutable, deduplicated evidence link from separately keyed positive
verification and positive landing receipts; neither changes PM management
state.

## Deep-link direction

- PC-SDK -> AInativePM uses the stable universal `#/item/<id>` Story route.
- AInativePM -> PC-SDK uses a future stable run/deliverable route. PC-SDK does
  not yet have one, so that prerequisite lands before reciprocal evidence.
- PM holds a URL/reference and short human context at most. PC-SDK retains the
  transcript, diff, verification, and Git receipts.

## Implementation gate

No prior anchoring phase or estimate remains valid. Implementation begins only
after the product decision in `docs/research/ainativepm-discovery.md` is
accepted, then follows the dependency order recorded there. No PM-side write,
folder registration, token change, or compatibility shim is authorized by this
document.
