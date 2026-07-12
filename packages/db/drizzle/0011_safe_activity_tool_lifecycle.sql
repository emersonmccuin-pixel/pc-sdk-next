-- CF-004 retires raw tool-call/result/denial payloads, streamed tool input,
-- and legacy provider-authored system notices. Before this migration every
-- system producer was runtime-derived (including api_retry.raw); hiding those
-- rows both prevents unsafe prose replay and keeps strict new-frame validation
-- from rejecting an entire historical session.
-- Keep the rows as forensic evidence and preserve their sequence high-water,
-- but never replay them through the strict safe lifecycle contract.
UPDATE `conversation_events`
SET `projection_state` = 'legacy-hidden'
WHERE `projection_state` = 'visible'
  AND (
    `event_type` IN ('tool-call', 'tool-result', 'tool-denied')
    OR `event_type` = 'system'
    OR (
      `event_type` = 'stream-delta'
      AND json_valid(`payload`)
      AND json_extract(`payload`, '$.kind') = 'stream-delta'
      AND json_extract(`payload`, '$.delta.kind') = 'tool-input-delta'
    )
  );
