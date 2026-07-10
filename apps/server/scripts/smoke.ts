// Real-SDK smoke — one live turn through the SdkBackend, printing the mapped
// RunnerMessages + ChatEvents. MANUAL only (needs a Claude Code login); never in
// CI. Mirrors apps/spike/src/chat.ts but exercises the Phase-2 runner seam.
//
// Run:  pnpm --filter @pc-sdk/server smoke  [--work] ["your prompt"]
// Env:  CLAUDE_CONFIG_DIR is set for you from the account registry.

import { AccountRegistry, DEFAULT_ACCOUNT_ID } from '../src/runner/account-env.ts';
import { SdkBackend } from '../src/runner/sdk-backend.ts';
import { runTurn } from '../src/chat/turn-runner.ts';

async function main(): Promise<void> {
  const accounts = new AccountRegistry();
  const accountId = process.argv.includes('--work') ? 'work' : DEFAULT_ACCOUNT_ID;
  const prompt =
    process.argv.slice(2).find((a) => !a.startsWith('--')) ??
    'In one sentence, what files are in the current directory? Use your tools.';

  const account = accounts.get(accountId);
  if (!account) throw new Error(`unknown account: ${accountId}`);
  console.log(`[smoke] account=${accountId} configDir=${account.configDir}`);
  console.log(`[smoke] cwd=${process.cwd()}`);
  console.log(`[smoke] prompt=${JSON.stringify(prompt)}\n`);

  const backend = new SdkBackend({
    env: accounts.buildEnv(accountId),
    accountId,
    cwd: process.cwd(),
  });

  await backend.startSession({
    appSessionId: 'smoke',
    cwd: process.cwd(),
    // Auto-allow every ask in the smoke (no browser to answer).
    ask: async (req) => {
      console.log(`[smoke][ask] ${req.toolName} → allow`);
      return { behavior: 'allow' };
    },
  });

  const terminal = await runTurn(backend.sendTurn(prompt), {
    emitChat: (event) => console.log(`[chat] ${event.kind}:`, preview(event)),
    emitDelta: () => {
      /* deltas are noisy — count only */
    },
    onSdkSessionId: (id, model) => console.log(`[smoke] sdkSessionId=${id} model=${model}`),
    onRateLimit: (snap) => console.log('[usage]', snap),
    onDropped: (reason, msg) => console.log(`[dropped] ${reason}`, preview(msg)),
  });

  console.log(`\n[smoke] turn terminated: ${terminal}`);
  await backend.dispose();
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
