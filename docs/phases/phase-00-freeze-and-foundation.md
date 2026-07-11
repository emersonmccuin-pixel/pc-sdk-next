# Phase N0: Freeze, fork, and planning foundation

Status: gate evidence passed; landing pending, 2026-07-11.

## Outcome

Preserve the known-working PC-SDK, create an operationally isolated PC-SDK Next,
and establish durable requirements, component boundaries, execution slices,
pickup, agent routing, and current-state memory before product behavior changes.

## Gate

- Original `main` and annotated baseline tag are pushed.
- Full CI and a live runtime smoke pass at the preserved baseline.
- New private repository and sibling checkout contain the same history/tag.
- `origin` targets Next; stable `upstream` is fetch-only.
- Next has distinct server/dev ports, data, logs, launcher/shortcut, and title.
- Requirements and boundary catalogs include the user's accepted additions.
- Master plan distinguishes inherited history from the active fork roadmap.
- Pickup and execution documents identify one next safe slice.
- Planning change passes CI, launcher/static checks, review, guarded landing, and
  positive ancestry proof.

## Non-goals

- No runtime/session schema migration
- No chat event implementation change
- No Codex adapter
- No AInativePM integration implementation
- No daily-driver cutover
