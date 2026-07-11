-- Full independent review — bind the in-flight verdict to the exact seal the
-- reviewer was briefed on. `review_sealed_commit` = the deliverable commit at
-- reviewer dispatch; approve settlement re-checks it against the contract's
-- CURRENT deliverable commit so a mid-review reseal (fix continuation or a
-- leftover builder process resubmitting) voids the verdict instead of landing
-- a never-reviewed commit. Additive + nullable; cleared with review_run_id.
ALTER TABLE `agent_contracts` ADD `review_sealed_commit` text;
