// Real-SDK smoke — one live turn through ClaudeRuntimeAdapter, printing the
// canonical ChatEvents. MANUAL only (needs a Claude Code login); never in CI.
// Mirrors apps/spike/src/chat.ts but exercises the provider-neutral runtime
// seam used by the server.
//
// Run:  pnpm --filter @pc-sdk/server smoke  [--work] ["your prompt"]
// Env:  CLAUDE_CONFIG_DIR is set for you from the account registry.

import { randomUUID } from 'node:crypto';
import { AccountRegistry, DEFAULT_ACCOUNT_ID } from '../src/runner/account-env.ts';
import {
  CLAUDE_RUNTIME_ID,
  ClaudeRuntimeAdapter,
} from '../src/runner/claude-adapter.ts';
import { runTurn } from '../src/chat/turn-runner.ts';

async function main(): Promise<void> {
  const accounts = new AccountRegistry();
  const accountId = process.argv.includes('--work') ? 'work' : DEFAULT_ACCOUNT_ID;
  const prompt =
    process.argv.slice(2).find((a) => !a.startsWith('--')) ??
    'In one sentence, what files are in the current directory? Use your tools.';

  const account = accounts.get(CLAUDE_RUNTIME_ID, accountId);
  if (!account) throw new Error(`unknown account: ${accountId}`);
  console.log(`[smoke] account=${accountId} configDir=${account.configDir}`);
  console.log(`[smoke] cwd=${process.cwd()}`);
  console.log(`[smoke] prompt=${JSON.stringify(prompt)}\n`);

  const adapter = new ClaudeRuntimeAdapter({ accounts });
  const session = await adapter.createSession({
    appSessionId: 'smoke',
    projectId: 'smoke',
    continuationAttemptId: randomUUID(),
    selection: {
      runtimeId: CLAUDE_RUNTIME_ID,
      accountId,
      model: 'opus',
      effort: { kind: 'none' },
    },
    cwd: process.cwd(),
    // Auto-allow every ask in the smoke (no browser to answer).
    ask: (req) => {
      console.log(`[smoke][ask] ${req.toolName} → allow`);
      return {
        requestId: randomUUID(),
        decision: Promise.resolve({ behavior: 'allow', decidedBy: 'user' }),
        cancel: () => {},
      };
    },
  });

  const terminal = await runTurn(session.sendTurn(prompt), {
    emitChat: (event) => console.log(`[chat] ${event.kind}:`, preview(event)),
    emitDelta: () => {
      /* deltas are noisy — count only */
    },
    onRuntimeSessionReceipt: (receipt) => {
      console.log(`[smoke] ${receipt.mode} nativeSessionId=${receipt.nativeSessionId}`);
    },
    onSubscriptionQuota: (batch) => console.log('[subscription-quota]', batch),
    onDropped: (reason, msg) => console.log(`[dropped] ${reason}`, preview(msg)),
  });

  console.log(`\n[smoke] turn terminated: ${terminal}`);
  await session.dispose();
  process.exit(0);
}

function preview(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

void main().catch((err) => {
  console.error('[smoke] failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
