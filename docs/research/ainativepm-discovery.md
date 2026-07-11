# AInativePM discovery plan

Status: proposed read-only discovery. No integration design is approved yet.

## Objective

Determine the correct ownership seam between AInativePM's human/AI management
domain and PC-SDK Next's technical execution domain before changing either app.

## Evidence lanes

Run these in parallel where practical:

1. Domain and persistence: entities, hierarchy, ownership, lifecycle, events,
   decisions, artifacts, identity, and source-of-truth rules.
2. UI: how people create, organize, assign, discuss, review, and complete items;
   which concepts are broader than software work.
3. MCP/API: commands, queries, auth, idempotency, subscriptions/webhooks,
   degraded states, and current consumers.
4. PC-SDK touchpoints: `pmRef`, contract/run/deliverable/landing evidence,
   existing MCP tools, and prior anchoring assumptions.

## Questions to answer

- Where does long-lived intent/coordination end and execution begin?
- Which system owns status, assignment, decisions, progress, and evidence?
- What is referenced versus copied?
- Which updates are automatic, suggested, or user-approved?
- How are duplicate delivery, retries, deletion, and disagreement handled?
- What can PC-SDK do when AInativePM is unavailable?
- Which AInativePM UI should deep-link to PC-SDK run evidence, and vice versa?

## Deliverable

A reviewed domain map, ownership table, interaction sequences, typed integration
port proposal, failure matrix, and explicit list of rejected duplications. The
deliverable updates or supersedes `docs/pm-anchoring.md`; discovery itself does
not implement synchronization.

