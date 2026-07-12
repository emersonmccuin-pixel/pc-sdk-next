-- DL-001: discriminate command-bearing preparation/readiness evidence from
-- explicit positive no-ops. Only exact, nonempty legacy command evidence is
-- promoted. NULL, empty, and malformed historical values remain unavailable.

UPDATE `agent_runs`
SET `preparation_receipt` = json_set(`preparation_receipt`, '$.outcome', 'executed')
WHERE `preparation_receipt` IS NOT NULL
AND CASE WHEN json_valid(`preparation_receipt`) = 1 THEN (
  json_type(`preparation_receipt`) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`preparation_receipt`) AS field
    WHERE field.key NOT IN ('phase', 'ok', 'steps', 'finishedAt')
  )
  AND (SELECT count(*) FROM json_each(`preparation_receipt`)) = 4
  AND json_extract(`preparation_receipt`, '$.phase') = 'preparation'
  AND json_type(`preparation_receipt`, '$.ok') IN ('true', 'false')
  AND json_type(`preparation_receipt`, '$.steps') = 'array'
  AND json_array_length(`preparation_receipt`, '$.steps') > 0
  AND json_type(`preparation_receipt`, '$.finishedAt') = 'integer'
  AND json_extract(`preparation_receipt`, '$.finishedAt') BETWEEN 0 AND 9007199254740991
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
    WHERE json_type(step.value) <> 'object'
      OR (SELECT count(*) FROM json_each(step.value)) <> 6
      OR EXISTS (
        SELECT 1 FROM json_each(step.value) AS field
        WHERE field.key NOT IN (
          'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
        )
      )
      OR json_type(step.value, '$.command') <> 'text'
      OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
      OR json_extract(step.value, '$.command') <>
        trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
      OR json_type(step.value, '$.exitCode') <> 'integer'
      OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
      OR json_type(step.value, '$.durationMs') <> 'integer'
      OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(step.value, '$.stdoutTail') <> 'text'
      OR json_type(step.value, '$.stderrTail') <> 'text'
      OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
  )
  AND (
    (
      json_extract(`preparation_receipt`, '$.ok') = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
        WHERE json_extract(step.value, '$.exitCode') <> 0
          OR json_extract(step.value, '$.timedOut') <> 0
      )
    )
    OR (
      json_extract(`preparation_receipt`, '$.ok') = 0
      AND EXISTS (
        SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
        WHERE json_extract(step.value, '$.exitCode') <> 0
          OR json_extract(step.value, '$.timedOut') <> 0
      )
    )
  )
) ELSE 0 END;
--> statement-breakpoint

UPDATE `agent_runs`
SET `readiness_receipt` = json_set(`readiness_receipt`, '$.outcome', 'executed')
WHERE `readiness_receipt` IS NOT NULL
AND CASE WHEN json_valid(`readiness_receipt`) = 1 THEN (
  json_type(`readiness_receipt`) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`readiness_receipt`) AS field
    WHERE field.key NOT IN ('phase', 'ok', 'steps', 'finishedAt')
  )
  AND (SELECT count(*) FROM json_each(`readiness_receipt`)) = 4
  AND json_extract(`readiness_receipt`, '$.phase') = 'readiness'
  AND json_type(`readiness_receipt`, '$.ok') IN ('true', 'false')
  AND json_type(`readiness_receipt`, '$.steps') = 'array'
  AND json_array_length(`readiness_receipt`, '$.steps') > 0
  AND json_type(`readiness_receipt`, '$.finishedAt') = 'integer'
  AND json_extract(`readiness_receipt`, '$.finishedAt') BETWEEN 0 AND 9007199254740991
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
    WHERE json_type(step.value) <> 'object'
      OR (SELECT count(*) FROM json_each(step.value)) <> 6
      OR EXISTS (
        SELECT 1 FROM json_each(step.value) AS field
        WHERE field.key NOT IN (
          'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
        )
      )
      OR json_type(step.value, '$.command') <> 'text'
      OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
      OR json_extract(step.value, '$.command') <>
        trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
      OR json_type(step.value, '$.exitCode') <> 'integer'
      OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
      OR json_type(step.value, '$.durationMs') <> 'integer'
      OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(step.value, '$.stdoutTail') <> 'text'
      OR json_type(step.value, '$.stderrTail') <> 'text'
      OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
  )
  AND (
    (
      json_extract(`readiness_receipt`, '$.ok') = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
        WHERE json_extract(step.value, '$.exitCode') <> 0
          OR json_extract(step.value, '$.timedOut') <> 0
      )
    )
    OR (
      json_extract(`readiness_receipt`, '$.ok') = 0
      AND EXISTS (
        SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
        WHERE json_extract(step.value, '$.exitCode') <> 0
          OR json_extract(step.value, '$.timedOut') <> 0
      )
    )
  )
) ELSE 0 END;
--> statement-breakpoint

-- Any remaining pre-discriminator value is not canonical positive evidence.
-- Collapse it to the already-defined unavailable state rather than leaving a
-- malformed nested DTO that prevents boot recovery from quarantining the row.
UPDATE `agent_runs`
SET `preparation_receipt` = NULL
WHERE `preparation_receipt` IS NOT NULL
AND CASE WHEN json_valid(`preparation_receipt`) = 1 THEN NOT (
  json_type(`preparation_receipt`) = 'object'
  AND json_extract(`preparation_receipt`, '$.phase') = 'preparation'
  AND json_type(`preparation_receipt`, '$.finishedAt') = 'integer'
  AND json_extract(`preparation_receipt`, '$.finishedAt') BETWEEN 0 AND 9007199254740991
  AND (
    (
      json_extract(`preparation_receipt`, '$.outcome') = 'executed'
      AND `continues` IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`preparation_receipt`) AS field
        WHERE field.key NOT IN ('phase', 'outcome', 'ok', 'steps', 'finishedAt')
      )
      AND (SELECT count(*) FROM json_each(`preparation_receipt`)) = 5
      AND json_type(`preparation_receipt`, '$.ok') IN ('true', 'false')
      AND json_type(`preparation_receipt`, '$.steps') = 'array'
      AND json_array_length(`preparation_receipt`, '$.steps') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
        WHERE json_type(step.value) <> 'object'
          OR (SELECT count(*) FROM json_each(step.value)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(step.value) AS field
            WHERE field.key NOT IN (
              'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
            )
          )
          OR json_type(step.value, '$.command') <> 'text'
          OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
          OR json_extract(step.value, '$.command') <>
            trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
          OR json_type(step.value, '$.exitCode') <> 'integer'
          OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
          OR json_type(step.value, '$.durationMs') <> 'integer'
          OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
          OR json_type(step.value, '$.stdoutTail') <> 'text'
          OR json_type(step.value, '$.stderrTail') <> 'text'
          OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
      )
      AND (
        (
          json_extract(`preparation_receipt`, '$.ok') = 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          )
        )
        OR (
          json_extract(`preparation_receipt`, '$.ok') = 0
          AND EXISTS (
            SELECT 1 FROM json_each(`preparation_receipt`, '$.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          )
        )
      )
    )
    OR (
      json_extract(`preparation_receipt`, '$.outcome') = 'not-required'
      AND json_extract(`preparation_receipt`, '$.ok') = 1
      AND json_type(`preparation_receipt`, '$.steps') = 'array'
      AND json_array_length(`preparation_receipt`, '$.steps') = 0
      AND (
        (
          json_extract(`preparation_receipt`, '$.reason') = 'no-commands-configured'
          AND `continues` IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM json_each(`preparation_receipt`) AS field
            WHERE field.key NOT IN ('phase', 'outcome', 'reason', 'ok', 'steps', 'finishedAt')
          )
          AND (SELECT count(*) FROM json_each(`preparation_receipt`)) = 6
        )
        OR (
          json_extract(`preparation_receipt`, '$.reason') = 'existing-worktree-preparation'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(`preparation_receipt`) AS field
            WHERE field.key NOT IN (
              'phase', 'outcome', 'reason', 'inheritedFromRunId', 'ok', 'steps', 'finishedAt'
            )
          )
          AND (SELECT count(*) FROM json_each(`preparation_receipt`)) = 7
          AND json_type(`preparation_receipt`, '$.inheritedFromRunId') = 'text'
          AND length(json_extract(`preparation_receipt`, '$.inheritedFromRunId')) = 26
          AND substr(json_extract(`preparation_receipt`, '$.inheritedFromRunId'), 1, 1) GLOB '[0-7]'
          AND json_extract(`preparation_receipt`, '$.inheritedFromRunId')
            NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
          AND `continues` IS NOT NULL
          AND `continues` = json_extract(`preparation_receipt`, '$.inheritedFromRunId')
        )
      )
    )
  )
) ELSE 1 END;
--> statement-breakpoint

UPDATE `agent_runs`
SET `readiness_receipt` = NULL
WHERE `readiness_receipt` IS NOT NULL
AND CASE WHEN json_valid(`readiness_receipt`) = 1 THEN NOT (
  json_type(`readiness_receipt`) = 'object'
  AND json_extract(`readiness_receipt`, '$.phase') = 'readiness'
  AND json_type(`readiness_receipt`, '$.finishedAt') = 'integer'
  AND json_extract(`readiness_receipt`, '$.finishedAt') BETWEEN 0 AND 9007199254740991
  AND (
    (
      json_extract(`readiness_receipt`, '$.outcome') = 'executed'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`readiness_receipt`) AS field
        WHERE field.key NOT IN ('phase', 'outcome', 'ok', 'steps', 'finishedAt')
      )
      AND (SELECT count(*) FROM json_each(`readiness_receipt`)) = 5
      AND json_type(`readiness_receipt`, '$.ok') IN ('true', 'false')
      AND json_type(`readiness_receipt`, '$.steps') = 'array'
      AND json_array_length(`readiness_receipt`, '$.steps') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
        WHERE json_type(step.value) <> 'object'
          OR (SELECT count(*) FROM json_each(step.value)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(step.value) AS field
            WHERE field.key NOT IN (
              'command', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'timedOut'
            )
          )
          OR json_type(step.value, '$.command') <> 'text'
          OR trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) = ''
          OR json_extract(step.value, '$.command') <>
            trim(json_extract(step.value, '$.command'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
          OR json_type(step.value, '$.exitCode') <> 'integer'
          OR json_extract(step.value, '$.exitCode') NOT BETWEEN -9007199254740991 AND 9007199254740991
          OR json_type(step.value, '$.durationMs') <> 'integer'
          OR json_extract(step.value, '$.durationMs') NOT BETWEEN 0 AND 9007199254740991
          OR json_type(step.value, '$.stdoutTail') <> 'text'
          OR json_type(step.value, '$.stderrTail') <> 'text'
          OR json_type(step.value, '$.timedOut') NOT IN ('true', 'false')
      )
      AND (
        (
          json_extract(`readiness_receipt`, '$.ok') = 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          )
        )
        OR (
          json_extract(`readiness_receipt`, '$.ok') = 0
          AND EXISTS (
            SELECT 1 FROM json_each(`readiness_receipt`, '$.steps') AS step
            WHERE json_extract(step.value, '$.exitCode') <> 0
              OR json_extract(step.value, '$.timedOut') <> 0
          )
        )
      )
    )
    OR (
      json_extract(`readiness_receipt`, '$.outcome') = 'not-required'
      AND json_extract(`readiness_receipt`, '$.reason') = 'no-commands-configured'
      AND json_extract(`readiness_receipt`, '$.ok') = 1
      AND json_type(`readiness_receipt`, '$.steps') = 'array'
      AND json_array_length(`readiness_receipt`, '$.steps') = 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(`readiness_receipt`) AS field
        WHERE field.key NOT IN ('phase', 'outcome', 'reason', 'ok', 'steps', 'finishedAt')
      )
      AND (SELECT count(*) FROM json_each(`readiness_receipt`)) = 6
    )
  )
) ELSE 1 END;
--> statement-breakpoint

-- Agent-run snapshots in the replay outbox embed the old nested shape. HTTP
-- re-seeds the current rows and subsequent mutations publish canonical frames;
-- retaining an invalid historical frame would make reconnect replay reject
-- it without advancing the cursor.
DELETE FROM `live_outbox` WHERE `entity` = 'agent-run';
