-- Phase 1 of same-runtime, same-account model/effort continuation: a
-- provenance-only link from one app session to the prior session its native
-- thread continued from across a selection change. Not part of the bind/
-- continuation state machine enforced by 0012's triggers — purely evidence
-- for replay chain-walking, shared with a future cross-account handoff link.

ALTER TABLE `orchestrator_sessions` ADD `source_session_id` text;
