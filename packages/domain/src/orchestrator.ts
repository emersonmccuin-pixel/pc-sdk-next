// Provider-neutral orchestrator session lifecycle vocabulary. Runtime
// selection lives in @pc/contracts so persistence, server, and browser share
// one exact shape instead of a provider-shaped domain mirror.

export type SessionStatus = 'active' | 'ended';

export type SessionEndedReason =
  | 'user_ended'
  | 'provider_error'
  | 'provider_session_lost'
  | 'account_switched'
  | 'runtime_switched'
  | 'selection_changed'
  | 'selection_unavailable'
  | 'pty_exit'
  | 'archived';
