# BC-002 reproducible browser baseline

Status: passed and landed on 2026-07-12. Evidence sealed at `871c7986`; feature
tip `5f9325b` landed as `9278a6f`; post-merge CI and push passed.

## Executive result

The preserved and current production bundles retain the same primary visual
shell. Every audited shell source blob is byte-identical, desktop and narrow
geometry match, neither subject has document-level horizontal overflow, and no
browser console warning or error was observed. The current product's additional
conversation, session, context, quota, run, and transcript behavior is an
accepted-requirement-driven projection inside that shell rather than a visual
redesign.

The coherent current journey directly exercised project and session isolation,
canonical conversation families, durable queued-send controls, positive
interrupt confirmation, historical/read-only and resumed session provenance,
reload equivalence, two-tab convergence, context confidence, normalized quota
semantics, safe agent activity, and provider-neutral transcript provenance. No
private reasoning, raw native session ID, or raw continuation-attempt ID was
observed in the rendered UI.

The bounded N1 characterization and all BC-002 closeout gates pass. The evidence
found three non-N1 follow-ups rather than a Next regression:

- both subjects inherit a very narrow `480px` composer (about `101.197px`);
- Escape does not dismiss App Settings in either subject, although its Close
  control works and the modal remains usable at `480x720`;
- both isolated servers listened on wildcard IPv6 `::`, rather than proving a
  loopback-only bind. That is the open `OPS-006` listener-hardening gap owned by
  N7 unless an explicit safety slice pulls it forward.

## Fixed subjects and evidence boundary

| Subject | Revision boundary | Build/runtime boundary |
| --- | --- | --- |
| Preserved baseline | `e233aa54c58dca163e98cf6011e79a0b91bd2d6f` in a disposable detached worktree | Historical production web bundle, historical typecheck, and a temporary fake-only fixture. The original daily-driver checkout and data did not participate. |
| Current PC-SDK Next | production sources from clean pushed `main` at `36ac71c59bb1d4095e30c9e2e4ed4d8ef73c9fd1`; slice-definition commit `da92488985c0f956496c320d144d38b0268ff487` changes documentation only | Current production web bundle around the real HTTP/WebSocket/static server, deterministic `FakeRuntime`, disposable SQLite/project/worktree/credential directories, and no boot recovery. |

The current tracked fixture is
`apps/server/test/browser-baseline-fixture.ts`. It deliberately lives under
`test/` without the `*.test.ts` suffix so the server TypeScript project checks
it while the ordinary Node test discovery does not start a listener. It seeds
Alpha and Beta projects, active and historical sessions, typed conversation
families, exact/unavailable context, available/unavailable quota states, three
run/contract outcomes, a stranded worktree, and one hanging plus one rich fake
turn. Its server startup disables recovery and supplies no live provider, MCP,
poller, launcher, or specialist runtime.

The final fixture revision creates its two account credential homes under the
disposable database root. For the last current run that root was
`C:\Users\emers\AppData\Local\Temp\pc-sdk-test-mo1ykJ`, with credential homes
under `fixture-credentials\personal` and `fixture-credentials\work`. A final
direct account-menu recheck showed exactly those two temporary paths. Neither
the fixture nor the rendered settings supplied the user's real Claude/Codex
homes.

This is production-bundle browser characterization, not provider integration
testing. Process command lines and OS socket tables showed only each fixture
listener and loopback browser connections, with no external connection owned by
either fixture process at the observation time. No packet capture, browser
proxy, or complete host-network instrumentation was used, so the evidence does
not make a broader network-isolation claim.

## Reproduction procedure

The verification host was Windows `10.0.26200.0`, PowerShell `7.5.8`, Node
`v22.13.0`, and pnpm `10.33.0`. The captures used Codex's in-app browser; its
exact embedded engine version was not present in the captured receipt and is
therefore unavailable rather than guessed. The required viewports and measured
geometry are recorded below.

The fixture sources are fixed by hash:

| Subject | Tracked fixture artifact | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Current | `apps/server/test/browser-baseline-fixture.ts` | `25,076` | `00cfc83d47360975b29bcbcaff6075b464dfd77c2bdd8285e93b92019741ee48` |
| Preserved | `docs/research/browser-baseline-preserved-fixture.ts` | `11,655` | `3525029e7b3d97f0e05275bf070b37448147b7f7c12582ed2210621fdcc102cd` |

### Current subject

From a checkout at the sealed BC-002 commit (or landed `main`), the exact
preparation and foreground fixture command are:

```powershell
pnpm install --offline --frozen-lockfile
pnpm typecheck
pnpm --filter @pc-sdk/web build
$env:PC_BROWSER_PORT = '55824'
Remove-Item Env:PC_BROWSER_AUTO_EXIT_MS -ErrorAction SilentlyContinue
pnpm --filter @pc-sdk/server exec tsx test/browser-baseline-fixture.ts
```

The fixture prints one `browser-baseline-fixture-ready` JSON line. In another
shell, `Invoke-RestMethod http://127.0.0.1:55824/health` must report version
`bc-002-fixture` before a browser opens. For the final non-browser self-check,
the same command used port `0` and `PC_BROWSER_AUTO_EXIT_MS=500`; it selected
ephemeral port `54149`, exited zero, removed `pc-sdk-test-FdNOUO`, and left no
listener.

### Preserved subject

The preserved artifact is inert under `docs/`. Reproduction copies it
byte-for-byte into a disposable detached historical worktree, so its relative
imports resolve only against the historical server APIs:

```powershell
$repo = 'E:\Claude Code Projects\Personal\PC-SDK-Next'
$check = 'E:\Claude Code Projects\Personal\PC-SDK-Next-bc-002-preserved-check'
$sha = 'e233aa54c58dca163e98cf6011e79a0b91bd2d6f'

git -C $repo worktree add --detach $check $sha
Copy-Item -LiteralPath `
  (Join-Path $repo 'docs\research\browser-baseline-preserved-fixture.ts') `
  -Destination (Join-Path $check 'apps\server\test\browser-baseline-fixture.ts')
pnpm --dir $check install --offline --frozen-lockfile
pnpm --dir $check typecheck
pnpm --dir $check --filter @pc-sdk/web build
```

The tested hidden start and health assertions were equivalent to:

```powershell
$wrapper = Join-Path $env:TEMP `
  ('pc-sdk-next-bc002-preserved-recheck-' +
    [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$ownedRoot = Join-Path $wrapper 'owned-fixture-root'
$stdout = Join-Path $wrapper 'stdout.log'
$stderr = Join-Path $wrapper 'stderr.log'
New-Item -ItemType Directory -Path $wrapper | Out-Null

$node = (Get-Command node).Source
$tsx = Join-Path $check 'apps\server\node_modules\tsx\dist\cli.mjs'
$fixture = Join-Path $check 'apps\server\test\browser-baseline-fixture.ts'
$proc = Start-Process -FilePath $node `
  -ArgumentList @("`"$tsx`"", "`"$fixture`"") `
  -WorkingDirectory (Join-Path $check 'apps\server') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
  -Environment @{
    PC_BROWSER_BASELINE_ROOT = $ownedRoot
    PC_BROWSER_BASELINE_PORT = '55823'
    PC_BROWSER_BASELINE_AUTO_EXIT_MS = '12000'
    ANTHROPIC_API_KEY = 'fixture-must-scrub'
    ANTHROPIC_AUTH_TOKEN = 'fixture-must-scrub'
    CLAUDE_CONFIG_DIR = (Join-Path $wrapper 'must-not-use-real-claude')
    CODEX_HOME = (Join-Path $wrapper 'must-not-use-real-codex')
  }

$deadline = [DateTime]::UtcNow.AddSeconds(10)
$health = $null
do {
  if ($proc.HasExited) { throw "fixture exited early: $($proc.ExitCode)" }
  try {
    $health = Invoke-RestMethod http://127.0.0.1:55823/health -TimeoutSec 1
  } catch {
    Start-Sleep -Milliseconds 100
  }
} while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline)
if ($null -eq $health) { throw 'health endpoint did not become ready' }

$projects = Invoke-RestMethod http://127.0.0.1:55823/api/projects -TimeoutSec 2
$accounts = Invoke-RestMethod http://127.0.0.1:55823/api/accounts -TimeoutSec 2
$projectNames = @($projects.projects | ForEach-Object name) -join ','
if ($health.version -ne 'bc002-preserved-e233aa54') {
  throw "unexpected health version: $($health.version)"
}
if ($projectNames -ne 'Command,Alpha,Beta') {
  throw "unexpected projects: $projectNames"
}
if ($accounts.accounts.Count -ne 1 -or $accounts.accounts[0].id -ne 'fixture') {
  throw 'unexpected fixture accounts'
}
if (-not $accounts.accounts[0].configDir.StartsWith(
    $ownedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'fixture account escaped the owned temp root'
}

if (-not $proc.WaitForExit(20000)) {
  Stop-Process -Id $proc.Id -Force
  throw 'fixture did not auto-exit'
}
$out = Get-Content -Raw -LiteralPath $stdout
$err = if ((Get-Item -LiteralPath $stderr).Length -gt 0) {
  Get-Content -Raw -LiteralPath $stderr
} else { '' }
if ($proc.ExitCode -ne 0 -or $err.Length -ne 0) {
  throw "fixture failed: exit=$($proc.ExitCode) stderr=$err"
}
if ($out -notmatch 'browser-baseline-preserved-ready' -or
    $out -notmatch 'browser-baseline-preserved-stopped') {
  throw 'ready/stopped receipts were not both emitted'
}
if (Test-Path -LiteralPath $ownedRoot) { throw 'owned root survived exit' }
if (Get-NetTCPConnection -LocalPort 55823 -State Listen -ErrorAction SilentlyContinue) {
  throw 'fixture port survived exit'
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$resolvedWrapper = [IO.Path]::GetFullPath($wrapper).TrimEnd('\')
if (-not $resolvedWrapper.StartsWith(
    $tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "refusing wrapper cleanup outside temp: $resolvedWrapper"
}
Remove-Item -LiteralPath $resolvedWrapper -Recurse -Force

git -C $check diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'historical tracked diff exists' }
git -C $check diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'historical staged diff exists' }
git -C $repo worktree remove --force $check

$checkGit = $check.Replace('\', '/')
if (@(git -C $repo worktree list --porcelain) -contains "worktree $checkGit") {
  throw 'historical worktree remains registered'
}
if (Test-Path -LiteralPath $check) {
  $workspaceParent = [IO.Path]::GetFullPath((Split-Path $repo -Parent)).TrimEnd('\')
  $resolvedCheck = [IO.Path]::GetFullPath($check).TrimEnd('\')
  $resolvedParent = Split-Path $resolvedCheck -Parent
  if ((Split-Path $resolvedCheck -Leaf) -ne 'PC-SDK-Next-bc-002-preserved-check' -or
      -not $resolvedParent.Equals(
        $workspaceParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing unexpected residue cleanup: $resolvedCheck"
  }
  $users = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains(
      $resolvedCheck, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($users.Count -ne 0) { throw 'a process still references worktree residue' }
  Remove-Item -LiteralPath $resolvedCheck -Recurse -Force
}
```

The retest required health version `bc002-preserved-e233aa54`, exact projects
`Command,Alpha,Beta`, one `fixture` account whose config directory was beneath
`$ownedRoot`, empty stderr, exit code zero, both ready/stopped JSON receipts,
owned-root removal, and closed port `55823`. It passed all assertions. The
offline install reused `471/471` packages with zero downloads; historical
workspace typecheck and production build passed. The check worktree was then
deregistered, exact unregistered dependency residue was path-validated and
removed, and no matching temp root remained.

## Browser evidence matrix

Evidence kinds follow the slice contract: `direct` means observed through the
real production bundle in the browser; `guard-backed` names the deterministic
test that owns a durable or unsafe-to-manufacture invariant; `unavailable`
records an uncaptured claim with an explicit owner. “Fixture-backed” below is
only an input qualifier on direct evidence, not a fourth evidence kind. No row
substitutes browser observation for durable-state contract tests.

### Gate classification

| ID; subject revision; fixture/state; viewport | Interaction | Expected | Observed | Evidence kind and artifact/guard | Console/network result | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| R1; preserved `e233aa54` + preserved artifact, current `36ac71c` + current fixture; capture viewports `1440x900`/`760x720`/`480x720` | Offline locked preparation, typecheck, production build, fake-only start, health check, capture, teardown | Fixed subjects can be rebuilt and served without stable data or provider/MCP acquisition | Both built and served; current tracked fixture and preserved tracked reproduction artifact define the inputs; hashes and cleanup receipts are below | Direct receipts plus `apps/server/test/browser-baseline-fixture.ts` and `docs/research/browser-baseline-preserved-fixture.ts` | Fixture stderr empty; PID/socket snapshot found listener plus loopback browser connections only, not a complete request ledger | Pass; tracked historical artifact retest and cleanup succeeded |
| R2; preserved `e233aa54`, preserved fake fixture, onboarding/populated shell; `1440x900`/`760x720`/`480x720` | Walk onboarding and open retained surfaces, rails, settings, scratchpad, roster, fake chat, project spaces, reload | Retained baseline surfaces are reachable, isolated, and usable without unexplained shell drift | All named surfaces opened; eight built-ins; fake reply replayed once; Alpha/Beta/Command did not bleed | Direct; preserved screenshots and detailed rows below | Console warning/error collection empty; failed-request ledger unavailable | Pass for inspected states; request-ledger claim unavailable and not inferred |
| R3; preserved `e233aa54` + preserved fixture and current `36ac71c` + current fixture, populated shell; `1440x900`/`760x720`/`480x720` | Compare source blobs, geometry, overflow, and modal/composer stress | Accepted behavior changes remain inside the inherited shell | Seven core blobs match; desktop/narrow measurements match; no document overflow; inherited `101.197px` composer at `480px` | Direct plus exact Git blob receipts; `apps/web/test/shell-guards.test.ts` | Console warning/error collections empty; no complete network ledger | Pass for shell identity; narrow limitation owned by N7 |
| R4; current `36ac71c`, current Alpha/Beta fixture sessions; `1440x900` | Switch projects and compare rendered conversations/resources | No cross-project flash or content bleed | Each project's seeded reply remained absent from the other | Direct (fixture-backed input); `apps/web/test/ws-client.test.ts`, `apps/server/test/e2e.test.ts` | Console warning/error collection empty | Pass |
| R5; current `36ac71c`, current active/history/resume fixture; `1440x900` | Open recent/Browse all, view history, resume, return live | Selection and continuation state are explicit; history is read-only; raw native/attempt IDs stay hidden | Runtime/account/model/effort, read-only history, back-to-live, and native-resumed status rendered without raw IDs | Direct plus guards: `apps/server/test/runtime-session-selection.test.ts`, `apps/server/test/session-service.test.ts`, `apps/web/test/sessions.test.ts`, `packages/db/test/runtime-session-selection.test.ts` | Console warning/error collection empty | Pass for Claude/current path; Codex/handoff remains N5 |
| R6; current `36ac71c`, current seeded/rich turns and transcript; `1440x900` | Inspect user/assistant/activity/tool/control/telemetry/system/agent projections | One ordered safe projection; no private reasoning/raw tool payload/provider-native identity | Typed lifecycle, notice, compaction, context, terminal, and agent provenance rendered safely | Direct plus guards: `apps/server/test/conversation-relay.test.ts`, `apps/server/test/sdk-import-guard.test.ts`, `apps/server/test/sdk-tool-mapping.test.ts`, `apps/web/test/chat-store.test.ts`, `apps/web/test/chat-render.test.ts` | Console warning/error collection empty | Pass |
| R7; current `36ac71c`, current hanging-turn fixture; `1440x900` | Queue two, edit first, remove second, interrupt, observe replacement | FIFO/revision/removal persist; replacement waits for positive interrupt receipt | Edited first item delivered only after `Interrupt confirmed`; second stayed removed | Direct (fixture-backed input) plus `apps/server/test/conversation-control.test.ts`, `apps/server/test/session-service.test.ts`, `packages/db/test/send-queue.test.ts` | Deliberate abort was typed UI evidence, not a request failure; console empty | Pass; negative receipt variants are guard-backed |
| R8; current `36ac71c`, current Alpha/Beta/account quota fixture; `1440x900` | Inspect exact, unavailable, remaining-source normalization, stale/rejected, unavailable account | No invented context percentage; quota always presents used while retaining source/confidence/freshness | Exact Alpha, unavailable Beta, `64% used`, remaining `18%` normalized to `82% used`, stale `93%`, and unavailable work state rendered | Direct (fixture-backed input) plus `apps/web/test/context-bar.test.ts`, `apps/web/test/subscription-quota-panel.test.ts`, `packages/contracts/test/context.test.ts`, `packages/app-services/test/subscription-quota.test.ts` | Console warning/error collection empty; no provider acquisition occurred | Pass |
| R9; current `36ac71c`, current Alpha runs/contracts/activity fixture; `1440x900` | Open activity categories and agent transcript | Running, merge-ready, conflict, stranded, and provenance remain distinct and safe | All seeded categories rendered; transcript exposed app-owned run/revision/selection facts without raw native IDs | Direct plus `apps/web/test/agent-transcript.test.ts`, `apps/web/test/contracts-view.test.ts`, `packages/db/test/specialist-execution-stamps.test.ts` | Console warning/error collection empty | Pass |
| R10; current `36ac71c`, current reload/two-tab fixture; `1440x900` | Count rich reply/abort before and after reload; send one convergence probe across tabs | Same ordered projection, no duplicate/orphan effect, both tabs converge | Counts stayed one; probe appeared exactly once in each tab | Direct plus `apps/server/test/conversation-relay.test.ts`, `apps/server/test/kill-recovery.test.ts`, `apps/web/test/chat-store.test.ts`, `apps/web/test/ws-client.test.ts`, `packages/db/test/conversation-events.test.ts` | Console warning/error collections empty in both tabs | Pass for deterministic reload/two-tab case; broader crash permutations are guard-backed |
| R11; current `36ac71c`, current typed-failure fixture; `1440x900` | Inspect typed failures while navigating unrelated surfaces | Failure stays explicit and does not become success or block unrelated UI | Abort/interrupted/confirmed, unavailable, read-only, conflict, and stranded states remained distinct; navigation stayed usable | Direct for observed states; negative interrupt timeout/rejection is guard-backed by `apps/server/test/conversation-control.test.ts` and `apps/server/test/session-service.test.ts` | No unexpected console warning/error; browser failed-request ledger unavailable | Pass for observed/guard-backed states; no ledger claim |
| R12; preserved `e233aa54` + current `36ac71c`, App Settings/modal; `1440x900`/`480x720` | Test App Settings Escape/Close and modal fit | A usable dismissal exists; keyboard behavior is honestly classified | Close worked and modal fit; Escape failed identically in both subjects; full focus traversal was not captured | Direct for dismissal/modal; full traversal `unavailable` | Console warning/error collection empty | Classified inherited N7 backlog, not a Next regression or N1 ambiguity |

R1 through R12 are the official gate rows. The subject-specific tables below
expand their direct observations; they inherit the explicit revision, fixture,
viewport, expected result, evidence kind, console/network boundary, and
disposition from the corresponding R-row rather than forming a second,
incomplete matrix.

The missing developer-tools request ledger and full focus traversal are typed
`unavailable`, not silently treated as passes. Each has a bounded disposition:
process/socket plus fixture-source evidence supports only the stated fake-only
network boundary, while the inherited dismissal/focus limitation belongs to N7.
Neither contradicts an implemented/verified requirement or leaves a subjective
shell classification unresolved, so the N1 characterization gate can close
without manufacturing evidence.

### Preserved baseline

| State / viewport | Interaction | Observed result | Evidence and disposition |
| --- | --- | --- | --- |
| Forced onboarding / desktop | Walked Welcome, folder selection, and completion | Welcome advanced to folder selection and then directly to “You're set.” | Direct; preserved onboarding flow characterized. |
| Populated shell / `1440x900` | Opened Command, Alpha, Beta, chat, Agents, App Settings, Project Settings, scratchpad, and collapsed/expanded Activity | All primary inherited surfaces opened; the Agents roster contained eight built-ins. Browser title was `PC-SDK`. | Direct; primary-shell characterization passed. |
| Fake conversation / desktop | Sent a deterministic turn and reloaded | “Preserved baseline reply.” appeared exactly once and remained exactly once after reload. | Direct plus fake fixture; replay did not duplicate the reply. |
| Alpha/Beta/Command / desktop | Switched among all three spaces | Conversation content did not bleed across spaces. | Direct; inherited project/space isolation characterized. |
| App Settings / desktop and `480x720` | Tested close controls and Escape | Close control dismissed the modal. Escape did not. At `480x720` the modal occupied exactly `480x720` and remained usable. | Direct; inherited accessibility backlog, not a Next regression. |
| Layout / `1440x900` | Measured document, shell header, and tabs | Document/body `scrollWidth` and `clientWidth` were both `1440`; header was about `31.998px`, tab strip about `39.316px`; no console warning/error. | Direct; desktop layout passed. |
| Layout / `760x720` | Measured rails, composer, and document overflow | No horizontal overflow; composer about `345.385px`; vertical separators at about `192.094px` and `567.254px`; no console warning/error. | Direct; required narrow layout passed. |
| Stress / `480x720` | Measured composer and modal | No document-level horizontal overflow; composer narrowed to about `101.197px`; settings remained usable. | Direct; inherited very-narrow usability limitation recorded. |

### Current PC-SDK Next

| State / viewport | Interaction | Observed result | Evidence and disposition |
| --- | --- | --- | --- |
| Seeded Alpha / `1440x900` | Loaded the active conversation and expanded its projections | Ordered user/assistant content, safe tool lifecycle, a notice, compaction, exact context, provider-neutral quota, running/merge-ready/conflict activity, and the stranded-worktree state rendered. Browser title was `PC-SDK Next`. | Direct plus fixture-backed; canonical projection passed without private reasoning. |
| Context and quota / desktop | Inspected Alpha, switched to Beta, and inspected the quota rail | Alpha showed exact `42,000` used / `180,000` usable / `200,000` total context. Beta showed `Unavailable · unsupported by this runtime`, not a fabricated number or replay conflict. The fixture supplied `64% used` exact account quota, a native `18% remaining` model window normalized to `82% used` approximate, a stale `93% used` rejected window, and an unavailable work account; source/confidence/staleness semantics rendered provider-neutrally. | Direct projection plus exact fixture input; context/quota honesty passed. |
| Alpha/Beta / desktop | Switched Alpha to Beta and back | Alpha's reply was absent from Beta; Beta's reply was absent after returning to Alpha. | Direct; project/session isolation passed. |
| Session provenance / desktop | Opened recent sessions, resumed history, then used Browse all and selected a historical row | The menu showed runtime/account/model/effort and resume status without native IDs. Resume reported native-resumed provenance. Browse-all selection showed “Viewing a past session (read-only),” Back to live, an explicit Resume control, and read-only context. | Direct; current/historical/resumed semantics passed. |
| Active turn and queued sends / desktop | Started the hanging fake turn, queued two messages, edited the first, removed the second, and requested interrupt | Queue controls retained FIFO state. The first became “First queued message edited.”; the second disappeared. The UI showed `turn failed · abort`, `interrupted`, and `Interrupt confirmed` before releasing the edited message. | Direct plus scripted hang; edit/remove and positive-receipt interrupt ordering passed. |
| Rich follow-up / desktop | Allowed the released queued message to complete | Safe tool states, compaction, exact context, notice, and “Recovered after the confirmed interrupt. The rich follow-up turn completed normally.” rendered. | Direct plus fake script; post-interrupt progression passed. |
| Reload equivalence / desktop | Counted terminal projections before and after reload | Rich reply count remained one; abort label count remained one. | Direct; live/replay equivalence passed for the exercised journey. |
| Two-tab convergence / desktop | Opened a second tab, compared replay, and sent “Two-tab convergence probe.” from tab one | Both tabs converged on one rich reply, one abort projection, and the same context. The probe appeared exactly once in each tab. | Direct; multi-tab convergence passed for this deterministic case. |
| Agent transcript / desktop | Opened a seeded run transcript | Run ID, runtime/account/model/effort, specialist revision, and clean-start/native-ID-bound presence rendered with safe transcript content. Raw native session and continuation-attempt IDs did not render. | Direct; provider-neutral provenance and safe activity passed. |
| Secondary surfaces / desktop | Opened Agents, scratchpad, Project Settings, and App Settings | Agents showed eight built-ins; scratchpad showed only the isolated fixture note; project and app settings opened. | Direct; no daily-driver content was observed. |
| Account menu / desktop | Inspected fixture account paths before and after the fixture-only correction | The first fixture revision exposed real user-home paths, correctly classified as a fixture defect. The corrected final reload showed only `pc-sdk-test-mo1ykJ\fixture-credentials\personal` and `...\work`. | Direct defect detection and direct corrected-fixture recheck; product behavior is not implicated. |
| Layout / `1440x900` | Compared geometry to preserved subject | Header, tab, project-settings, and Activity positions/sizes matched the preserved measurements; document/body had no horizontal overflow; no console warning/error. | Direct; desktop shell parity passed. |
| Layout / `760x720` | Measured rails/composer and reviewed console | No horizontal overflow; composer about `345.385px`; separators about `192.094px` and `567.254px`; no console warning/error. | Direct; required narrow layout passed. |
| Stress / `480x720` | Measured composer, opened settings, and tested Escape | No horizontal overflow; composer about `101.197px`; modal filled exactly `480x720`; Escape did not dismiss it, matching the preserved subject. | Direct; inherited narrow/accessibility limitations recorded for N7. |

Browser console warning/error collections were empty for both current tabs and
the preserved tab during the recorded journeys. They remained empty after the
final corrected-fixture reload. The evidence does not claim that a browser
developer-tools request ledger or packet trace was captured.

## Canonical captures

The screenshots are review artifacts, not pixel-diff golden tests. Current
captures contain richer accepted state than the preserved fixtures, so source
blob and measured-geometry parity—not equal PNG hashes—is the shell-identity
proof.

| Artifact | Viewport | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `docs/research/browser-baseline-assets/preserved-desktop.png` | `1440x900` | `47,199` | `42fe1112303aa989d724d5363090fc575e0b5511ae4ebda1062cce887166767a` |
| `docs/research/browser-baseline-assets/preserved-narrow.png` | `760x720` | `33,915` | `fc55b4c308bf3ac33cac388accdc72accd91a589633f0223122315453b23c7f4` |
| `docs/research/browser-baseline-assets/current-desktop.png` | `1440x900` | `88,138` | `f2b5fe9c64930b42b7f12e6b517a103fcde23c50610e4316dc79486ac74d22c0` |
| `docs/research/browser-baseline-assets/current-narrow.png` | `760x720` | `72,437` | `6fd01d142157a6dfed0ff1d959e03d6513658e139f910da608286a1ed4847d4a` |

## Production bundle evidence

Both pinned subjects passed their workspace typecheck and production web build
after offline locked dependency preparation. The larger current JavaScript and
CSS bundles are expected because N2/N3 behavior was added without replacing the
shell.

| Subject | Asset | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Current | `index-B4CTmHTr.js` | `689,272` | `862bd04a87b43dda03c09b5cb3e7ba15e75bdb20502d7171eee93e844df74d52` |
| Current | `index-CTb6js0L.css` | `175,939` | `3f579caec702fce80b2ce86876f8ef1e8635ec76345139c012829ea678699ba7` |
| Preserved | `index-CPLmWjOX.js` | `622,506` | `b894626422a790570843724270e7dadad1544efd75caf6b0809b5e3eeb19b381` |
| Preserved | `index-Dm6tl28H.css` | `174,903` | `647e43875e7addcde411e49c76f183c1af7c3da49e5f649bb906f9aae7c00608` |

The following Git blob IDs are identical at preserved commit `e233aa5` and
current base `36ac71c`:

| Shell source | Shared blob ID |
| --- | --- |
| `apps/web/src/components/Shell.tsx` | `ceb5695c1895907c0f3128440d541e05aa90242e` |
| `apps/web/src/components/LeftRail.tsx` | `ee71a286535748174705f18ea8257cc38d613929` |
| `apps/web/src/components/ActivityPanel.tsx` | `10697e12331e13a587662b5e6026d0ada4f62a18` |
| `apps/web/src/components/StatusBar.tsx` | `49820c7b5bac4e56d8a66a9dbfd0f3b3929e1c8f` |
| `apps/web/src/components/Tabs.tsx` | `13d66ec6eb7e2dda56ba9faf15c3d72b58ed1f0d` |
| `apps/web/src/components/ConversationHeader.tsx` | `840fd5fc0a2c79f9529c4b66cc331a6766c76802` |
| `apps/web/src/index.css` | `9c6ca69166087085e09898c44b4b2a028b14da5c` |

## BC-001 backlog reconciliation

| BC-001 characterization item | Status and current disposition | Exact implementation/guard evidence |
| --- | --- | --- |
| Restart with active turn/queued sends; duplicate client message; multi-tab ordering; session switch during delivery | **Closed on the current path.** CF-003 owns durable restart/idempotency/control; BC-002 directly covers edit/remove, project/session isolation, reload, and two-tab convergence. | `packages/db/test/send-queue.test.ts`; `apps/server/test/conversation-control.test.ts`; `apps/server/test/session-service.test.ts`; `apps/server/test/kill-recovery.test.ts`; `apps/web/test/chat-store.test.ts`; `apps/web/test/ws-client.test.ts` |
| Live/replay equivalence, insert/broadcast crash window, reconnect deltas, duplicate/conflicting sequence, reordered deltas | **Closed.** CF-001/CF-002 own transactional persistence/projection; BC-002 adds a direct reload/two-tab case. | `packages/db/test/conversation-events.test.ts`; `packages/db/test/live-outbox.test.ts`; `apps/server/test/conversation-relay.test.ts`; `apps/web/test/chat-store.test.ts` |
| Positive interrupt success/failure/timeout receipts | **Closed.** BC-002 directly observes positive confirmation; negative/timeout variants are guard-backed. | `packages/db/test/send-queue.test.ts`; `apps/server/test/conversation-control.test.ts`; `apps/server/test/session-service.test.ts` |
| Safe activity; provider thinking/private reasoning never reaches persistence/presentation | **Closed.** CF-004 supplies the safe families; BC-002 observes only safe lifecycle summaries. | `apps/server/test/sdk-import-guard.test.ts`; `apps/server/test/sdk-tool-mapping.test.ts`; `packages/db/test/tool-lifecycle-migration.test.ts`; `apps/web/test/chat-render.test.ts`; `apps/web/test/chat-store.test.ts` |
| Immutable orchestrator selection and resume routing | **Split/closed for the implemented Claude orchestrator path.** RS-001 owns stamps and fail-closed continuation; Codex/handoff remains N5. | `packages/db/test/runtime-session-selection.test.ts`; `apps/server/test/runtime-session-selection.test.ts`; `apps/server/test/session-service.test.ts`; `apps/web/test/sessions.test.ts` |
| Adapter conformance | **Partial.** Claude capability/selection/context/quota guards exist; peer Codex and shared parity remain N5. | `packages/contracts/test/runtime.test.ts`; `apps/server/test/runtime-registry.test.ts`; `apps/server/test/claude-adapter-runtime.test.ts`; `apps/server/test/claude-adapter-result.test.ts`; `apps/server/test/claude-adapter-quota.test.ts` |
| Immutable specialist revision reconstruction | **Closed.** RS-003 owns immutable revision/run selection; BC-002 directly observes transcript provenance. | `packages/db/test/specialist-execution-stamps.test.ts`; `packages/db/test/specialist-execution-migration.test.ts`; `apps/server/test/dispatch-guards.test.ts`; `apps/server/test/kill-recovery.test.ts`; `apps/web/test/agent-transcript.test.ts` |
| Least-privilege environment canaries | **Open N4 `SEC-003`.** The fake fixture is not a production child-environment proof. | `apps/server/src/runner/account-env.ts` and `apps/server/test/account-env.test.ts` prove only the current narrower scrubbing boundary. |
| Two independent processes contending for one repository | **Open N4 `OPS-005`/`WT-004`.** Landing exclusion remains process-local. | `apps/server/src/dispatch/service.ts`; existing `apps/server/test/landing-guards.test.ts` does not supply the missing cross-process contention proof. |
| Crash/restart across pre-attach delivery and repository phases | **Partial.** Envelope and several seal/merge/teardown phases are guarded; exact readiness crash/recovery UI remains N4. | `apps/server/test/kill-recovery.test.ts`; `apps/server/test/worktree-profile.test.ts`; `apps/server/test/landing-guards.test.ts` |
| Explicit no-op readiness and approved-abandonment receipts | **Open N4 `WT-002`/`WT-005`/`WT-006`.** Absence still cannot mean positive completion. | `apps/server/src/dispatch/worktrees.ts`; current `apps/server/test/worktree-profile.test.ts` covers command-bearing profiles, not the missing positive no-op/abandonment receipts. |

BC-001's four product-decision checkpoints are also reconciled: new private
thinking is forbidden and legacy thinking is retain-only/nonprojected; legacy
continuation fails closed; explicit no-op readiness remains an N4 delivery
receipt; and specialist permissions remain an N4/N6 policy checkpoint.

## Process/socket and cleanup receipt

At capture time, each fixture process was an explicit test-fixture command with
empty stderr:

| Subject | PID | Port | Listener | Disposable data/run boundary |
| --- | ---: | ---: | --- | --- |
| Preserved | `51452` | `55823` | wildcard IPv6 `::` | `C:\Users\emers\AppData\Local\Temp\pc-sdk-next-bc002-e233aa-1783866629253` |
| Current final fixture | `190104` | `55824` | wildcard IPv6 `::` | DB root `C:\Users\emers\AppData\Local\Temp\pc-sdk-test-mo1ykJ`; wrapper root `C:\Users\emers\AppData\Local\Temp\pc-sdk-next-bc002-current-final-1783867865768` |

Earlier current fixture processes `53308` and `141708` were stopped, their
ports closed, and their disposable data removed before the final fixture run.
The stable source checkout was observed clean at
`c7a717903a09f12d50f79e04ec550603dfb0e97f` on its own `main`, ahead of its
origin by four user-owned commits, and was not mutated. PC-SDK Next `main` was
clean and aligned with `origin/main` at `36ac71c` before BC-002.

Final disposable-fixture cleanup passed. Exact command-line matching preceded
termination of PIDs `51452` and `190104`; ports `55823` and `55824` then had no
listener. Every recursive deletion target was resolved and checked beneath
`C:\Users\emers\AppData\Local\Temp` before removing the preserved/current run
roots, earlier current wrapper roots, and `pc-sdk-test-mo1ykJ`. The detached
baseline had no tracked or staged diff (only its temporary untracked fixture).
Git deregistered the detached worktree but reported a nonempty dependency
residue; the exact now-unregistered path was revalidated and removed, and the
fixture-cleanup worktree list contained only Next `main` and the BC-002 feature
worktree. After landing proof, the clean feature worktree and its exact
unregistered dependency residue were also removed.
The stable checkout remained at `c7a7179` with its pre-existing clean
`main...origin/main [ahead 4]` status.

## Closing gates

Completed before this draft:

- current locked offline install reused all `471` packages with zero downloads;
- current workspace typecheck and production web build passed;
- preserved detached-worktree locked offline preparation, workspace typecheck,
  and production web build passed;
- the final current fixture passed server typecheck and an auto-exit startup/
  cleanup self-check after the settled-conversation and credential-root fixes;
- all four canonical PNGs were hash-verified and visually inspected.
- the final 14-path scope audit, 139-reference local-path audit, and
  `git diff --check` passed;
- full feature-tree `pnpm ci:check` passed, including every workspace
  typecheck/test, all `331/331` server tests, and the dead-import guard.

Landing closeout also passed: evidence commit `871c7986`, feature tip `5f9325b`,
landing merge `9278a6f`, and feature/merge tree `75c83dd` have positive ancestry
and exact tree receipts. Full post-merge `pnpm ci:check` passed (`331/331` server
tests), `origin/main` reached the exact landing merge, and the feature worktree
was removed.

## Gate disposition and next dependency

No subjective visual or behavior decision is required: the inspected shell
sources and geometry match, and every material observed current delta follows
accepted requirements. N1 is closed. The smallest next N4 slice is SF-001
data-directory single-instance admission; SF-002 then
adds cross-process repository exclusion, and `SEC-003` owns least-privilege
child environments. `OPS-006` loopback binding plus the narrow/accessibility
findings remain N7 unless explicitly reordered. N5 Codex parity remains after
the shared safety prerequisites.
