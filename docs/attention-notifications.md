# Project attention and notifications

Status: **planned daily-driver requirement** (2026-07-10). Brave on Windows is
the primary browser target. This slice tells the user when PC-SDK has stopped
working and is waiting for them without turning the left rail into an alarm
panel.

## User outcome

When an orchestrator or specialist reaches a state that needs the user, the
relevant project becomes visibly distinct in the left rail. If PC-SDK is not
focused, it may also play one short ding and show a Brave/Windows desktop
notification. Attention remains until the user actually views that project.

## Attention states

These states are app-owned and provider-neutral:

| State | Meaning | Left-rail treatment | Notification copy |
| --- | --- | --- | --- |
| `ready` | The orchestrator completed normally and is waiting for the next user turn. | Soft gold pulse/glow. | “Project name is ready.” |
| `decision-required` | A pending ask, approval, or human review requires an answer. | Stronger amber attention treatment with a decision indicator. | “Project name needs your decision.” |
| `failed` | The turn or run failed and needs inspection. | Persistent red/error treatment; no success styling. | “Work in Project name failed.” |

`decision-required` outranks `failed`, which outranks `ready`, when more than
one unseen condition exists. Active work is not an attention state and does not
ding merely because streaming or a tool call begins.

Initial triggers come from canonical PC-SDK facts, not timers or inferred idle
state:

- chat `turn-end` creates `ready` when the project is not currently visible and
  focused;
- an open pending ask/approval or a contract parked for human review creates
  `decision-required`;
- `turn-failed` or a terminal failed run creates `failed`;
- provider-native events never drive the UI directly.

## Clearing and persistence

- Attention clears only after the project is selected while the document is
  visible and focused. Merely reconnecting, replaying events, or booting does
  not mark it seen.
- Store a durable per-project seen cursor/revision. Rebuild attention from the
  DB-backed event/resource stream so reload and server restart preserve what
  still needs attention.
- Sound and desktop notification delivery are edge-triggered. Replayed or
  duplicate events must not ding or notify again.
- Opening a desktop notification selects the correct project and relevant
  chat, ask, review, or failed run when that target still exists.

The existing `unreadProjectIds`/project-tile attention seam should be wired to
this state rather than replaced with a second badge system.

## Visual behavior

- The currently selected project uses a stable warm surface tint, crisp left
  accent, and distinct active monogram tile. It has no scanline/texture overlay
  and exposes `aria-current="page"`.
- Selection and attention are separate: selected means “I am viewing this”;
  pulse/glow and status indicators mean “this inactive project needs me.”
- Use a restrained pulse/glow on inactive project tiles, not a rapid hard
  blink. The state remains legible without motion.
- Respect `prefers-reduced-motion`: show the persistent color/indicator with no
  animation.
- Never rely on color alone; expose an icon/indicator and an accessible label
  describing the state.
- The active project does not pulse while the user is looking at it. If the
  Brave window is unfocused when the terminal event arrives, retain attention
  until focus returns to that project.

## Ding and desktop notifications

Brave requires explicit site permission for desktop notifications and may
gate audible autoplay. PC-SDK therefore uses deliberate setup rather than
assuming either capability:

1. Settings contains **Enable desktop notifications**, which requests Brave's
   notification permission from that user action. Never prompt on boot.
2. Settings contains **Enable sound** plus a **Test ding** control. That user
   gesture initializes/unlocks audio for the local origin.
3. Permission states are explicit: `enabled`, `denied`, `not-requested`, or
   `unavailable`, with a short recovery instruction for Brave site settings.
4. Windows Focus Assist/Do Not Disturb and Brave permission decisions are
   respected; PC-SDK does not attempt to bypass them.
5. V1 notifications require the Brave PC-SDK window/page to remain open. Closed-
   browser/background delivery is not promised; adding it later requires a
   separately designed service-worker/push or native launcher path.

The sound is one brief local asset, played once per transition into an unseen
attention state. Multiple terminal facts arriving together are coalesced so a
single project does not produce a burst of dings.

## Settings

App settings provide:

- visual project attention: on by default;
- sound: on/off, volume, and Test ding;
- Brave/Windows desktop notifications: on/off and Test notification;
- notification timing: **only when PC-SDK is unfocused** by default, with an
  option to notify even while focused;
- per-project mute for sound/desktop notifications without disabling the
  persistent visual state.

`decision-required` and `failed` use their own copy and appearance even when
sound is muted. Muting must never hide a request that is visible in the app.

## Acceptance criteria

1. Completing work in inactive Project B leaves one persistent `ready`
   indicator on B while the user remains in Project A.
2. With sound enabled and PC-SDK unfocused, that transition plays exactly one
   ding; reconnect, replay, and reload play none.
3. With Brave notification permission granted and PC-SDK unfocused, the same
   transition shows one Windows notification whose click opens Project B.
4. Pending decisions, normal completion, and failures are visually and
   textually distinct.
5. Selecting the project in a visible, focused window clears its seen
   attention; background selection does not.
6. Denied notification permission and blocked audio are visible settings
   states, never silent failures and never blockers for chat or dispatch.
7. Reduced-motion mode removes animation while retaining an equally clear
   persistent indicator.
8. Unit tests cover priority, clearing, deduplication, replay, and focus rules;
   a real Brave browser pass covers permission, ding, notification click, and
   Windows Focus Assist behavior.

## Brave references

- [Brave Push Notification Test](https://support.brave.com/hc/en-us/articles/360058972091-Push-Notification-Test)
- [Brave site permissions](https://support.brave.com/hc/en-us/articles/360018205431-How-do-I-change-site-permissions)
