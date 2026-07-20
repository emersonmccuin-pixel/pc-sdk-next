// Live Codex turn smoke — through the REAL product adapter path.
//
// WHAT THIS PROVES (for real, against the pinned native app-server + the
// machine's ~/.codex ChatGPT login):
//   1. Live model discovery through CodexRuntimeAdapter.listModels (model ids
//      come only from live discovery — never a hardcoded default).
//   2. A real turn minted through CodexRuntimeAdapter.createSession + the live
//      deps (createCodexLiveDeps): a `pong` round-trip whose typed terminal is
//      an `ok` result.
//   3. A longer turn interrupted after its first streaming delta, resolving to a
//      typed `aborted` result (the native turn/completed status=interrupted the
//      session maps to aborted) — respecting the interrupt timing hazard.
//
// Unlike the retired raw-JSONL driver (preserved in git history), this drives the
// SAME CodexRuntimeAdapter + live-peer surface the product uses, so a pass here
// is a pass of the real turn path end to end, not just the native substrate.
//
// PROVEN against pinned 0.144.1 on 2026-07-20 (exit 0): live discovery
// (gpt-5.6-*), a real pong round-trip with an `ok` terminal, and a real interrupt
// resolving to a typed `aborted` terminal. The CX-002 capture contract was
// reconciled to the real thread/turn wire shapes (runtimeWorkspaceRoots-pinned
// write scope, model-default reasoningEffort, itemsView 'notLoaded', terminal
// frames that do not re-list items) so the product turn path runs end to end.
//
// Exit 0 on pass; non-zero on any failure. A missing/expired login is reported as
// a typed unavailable discovery, never faked into a pass. Lives under
// apps/server/scripts so its types resolve against the server tsconfig.
//
//   pnpm --filter @pc-sdk/server exec tsx scripts/codex-live-smoke.ts
//   node apps/server/node_modules/tsx/dist/cli.mjs apps/server/scripts/codex-live-smoke.ts

import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexRuntimeAdapter } from '../src/runner/codex/adapter.ts';
import { createCodexLiveDeps } from '../src/runner/codex/live-peer.ts';
import { CODEX_RUNTIME_ID } from '../src/runner/codex/runtime-peer.ts';
import type { RuntimeEvent } from '../src/runner/runtime.ts';
import type { RuntimeSelection } from '@pc/contracts';

const ACCOUNT_ID = 'codex-live-smoke';
const PONG_TIMEOUT_MS = 90_000;
const INTERRUPT_TIMEOUT_MS = 90_000;

function parseCodexHome(argv: readonly string[]): string {
  const flag = argv.indexOf('--codex-home');
  const requested = flag !== -1 && typeof argv[flag + 1] === 'string'
    ? argv[flag + 1]!
    : join(homedir(), '.codex');
  return realpathSync.native(requested);
}

async function main(): Promise<void> {
  const codexHome = parseCodexHome(process.argv.slice(2));
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-live-smoke-cwd-')));
  const adapter = new CodexRuntimeAdapter(createCodexLiveDeps({ codexHome, cwd }));
  console.log(`SMOKE codexHome=${codexHome} cwd=${cwd}`);

  // 1) Live discovery — the selected model id must come from the live catalog.
  const discovery = await adapter.listModels(ACCOUNT_ID);
  if (discovery.status !== 'available') {
    throw new Error(`live discovery unavailable: ${discovery.status === 'unavailable' ? discovery.code : 'unknown'} (is there a Codex ChatGPT login under ${codexHome}?)`);
  }
  const chosen = discovery.models[0]!;
  console.log(`MODELS=${discovery.models.map((m) => m.id).join(', ')} CHOSEN=${chosen.id}`);
  const selection: RuntimeSelection = {
    runtimeId: CODEX_RUNTIME_ID,
    accountId: ACCOUNT_ID,
    model: chosen.id,
    effort: chosen.effort.status === 'supported' ? { kind: 'none' } : { kind: 'unavailable' },
  };

  // 2) Real pong round-trip through the adapter.
  const pongSession = await adapter.createSession({
    appSessionId: 'codex-live-smoke-pong',
    projectId: 'codex-live-smoke',
    continuationAttemptId: 'codex-live-smoke-pong-attempt',
    selection: structuredClone(selection),
    cwd,
  });
  const pongEvents = await withTimeout(
    collect(pongSession.sendTurn('Reply with exactly the single word: pong')),
    PONG_TIMEOUT_MS,
    'pong turn',
  );
  await pongSession.dispose();
  const pongTerminal = pongEvents.at(-1);
  const pongText = pongEvents
    .filter((e): e is Extract<RuntimeEvent, { type: 'assistant-block' }> => e.type === 'assistant-block')
    .map((e) => (e.block.kind === 'text' ? e.block.text : ''))
    .join('');
  console.log(`PONG outcome=${pongTerminal?.type === 'result' ? pongTerminal.outcome : 'none'} text=${JSON.stringify(pongText)}`);
  if (pongTerminal?.type !== 'result' || !pongTerminal.ok) {
    throw new Error('pong turn did not complete with an ok result');
  }
  if (!/\bpong\b/iu.test(pongText)) {
    throw new Error(`pong turn text unexpected: ${JSON.stringify(pongText)}`);
  }

  // 3) Real interrupt -> typed aborted outcome (issued after the first delta).
  const interruptSession = await adapter.createSession({
    appSessionId: 'codex-live-smoke-interrupt',
    projectId: 'codex-live-smoke',
    continuationAttemptId: 'codex-live-smoke-interrupt-attempt',
    selection: structuredClone(selection),
    cwd,
  });
  const iterator = interruptSession
    .sendTurn('Write a detailed 600-word essay about the history of mechanical clocks. One sentence per line. Do not stop early.')
    [Symbol.asyncIterator]();
  const observed: RuntimeEvent[] = [];
  const interrupted = await withTimeout((async () => {
    let interruptIssued = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      observed.push(next.value);
      if (!interruptIssued && next.value.type === 'delta' && next.value.delta.kind === 'text-delta') {
        // Timing hazard: interrupt only once the turn is genuinely streaming.
        interruptIssued = true;
        await interruptSession.interrupt().catch(() => {});
      }
    }
    return observed.at(-1);
  })(), INTERRUPT_TIMEOUT_MS, 'interrupt turn');
  await interruptSession.dispose();
  console.log(`INTERRUPT outcome=${interrupted?.type === 'result' ? interrupted.outcome : 'none'}`);
  if (interrupted?.type !== 'result' || interrupted.ok || interrupted.outcome !== 'aborted') {
    throw new Error(`interrupt turn expected a typed aborted result, got ${interrupted?.type === 'result' ? interrupted.outcome : 'none'}`);
  }

  console.log('LIVE SMOKE PASS: real adapter pong round-trip + real interrupt (typed aborted) verified');
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`LIVE SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
