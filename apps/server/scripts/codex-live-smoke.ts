// Live Codex peer smoke — runs the REAL live discovery peer against the pinned
// app-server binary and the machine's existing Codex login, then attempts one
// tiny real turn ("reply with the word pong") through the adapter + live deps.
//
// Discovery is fully live. The turn is presently gated (the live turn transport
// is the next WF-1 slice), so the turn step reports the exact typed failure
// rather than faking success. Requires an existing ChatGPT login under
// CODEX_HOME (default: <home>/.codex; override with --codex-home <path>).
//
//   pnpm --filter @pc-sdk/server exec tsx scripts/codex-live-smoke.ts

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexRuntimeAdapter, CodexRuntimeAdapterError } from '../src/runner/codex/adapter.ts';
import { createCodexLiveDeps } from '../src/runner/codex/live-peer.ts';
import { RuntimeSelectionRejectedError } from '../src/runner/runtime.ts';
import type { RuntimeSelection } from '@pc/contracts';

const ACCOUNT_ID = 'codex-live-smoke';

function parseCodexHome(argv: readonly string[]): string {
  const flag = argv.indexOf('--codex-home');
  const requested = flag !== -1 && typeof argv[flag + 1] === 'string'
    ? argv[flag + 1]!
    : join(homedir(), '.codex');
  return realpathSync.native(requested);
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const codexHome = parseCodexHome(process.argv.slice(2));
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'codex-live-smoke-cwd-')));
  const deps = createCodexLiveDeps({ codexHome, cwd });
  const adapter = new CodexRuntimeAdapter(deps);

  const report: Record<string, unknown> = { codexHome, cwd };

  try {
    const discovery = await adapter.listModels(ACCOUNT_ID);
    report.discovery = discovery.status === 'available'
      ? { status: 'available', modelCount: discovery.models.length, firstModel: discovery.models[0]?.id ?? null }
      : discovery;

    if (discovery.status !== 'available') {
      if (discovery.code === 'account-unavailable') {
        problems.push('Codex login missing/unusable under CODEX_HOME — cannot run the live turn.');
      } else {
        problems.push(`Codex discovery unavailable: ${discovery.code}`);
      }
    } else {
      const model = discovery.models.find((entry) => entry.effort.status === 'supported')
        ?? discovery.models[0]!;
      const effort: RuntimeSelection['effort'] = model.effort.status === 'supported'
        ? { kind: 'selected', value: model.effort.values[0]! }
        : { kind: 'unavailable' };
      const selection: RuntimeSelection = {
        runtimeId: adapter.id,
        accountId: ACCOUNT_ID,
        model: model.id,
        effort,
      };
      report.turn = await attemptPong(adapter, selection, cwd, problems);
    }
  } catch (error) {
    problems.push(`Unexpected live-smoke failure: ${safeCode(error)}`);
    report.discovery = report.discovery ?? { status: 'error' };
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      problems.push('Failed to remove the temporary smoke working directory.');
    }
  }

  report.problems = problems;
  const ok = problems.length === 0 && (report.turn as { outcome?: string } | undefined)?.outcome === 'pong';
  process.stdout.write(`${JSON.stringify({ ok, report }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function attemptPong(
  adapter: CodexRuntimeAdapter,
  selection: RuntimeSelection,
  cwd: string,
  problems: string[],
): Promise<Record<string, unknown>> {
  try {
    const session = await adapter.createSession({
      appSessionId: 'codex-live-smoke-session',
      projectId: 'codex-live-smoke-project',
      continuationAttemptId: 'codex-live-smoke-attempt',
      selection,
      cwd,
    });
    try {
      let text = '';
      for await (const event of session.sendTurn('reply with the word pong')) {
        if (event.type === 'assistant-block' && event.block.kind === 'text') text += event.block.text;
        if (event.type === 'result') {
          const outcome = event.ok && /pong/i.test(text) ? 'pong' : 'no-pong';
          if (outcome !== 'pong') problems.push('Live turn completed but did not reply pong.');
          return { attempted: true, outcome, ok: event.ok };
        }
      }
      problems.push('Live turn ended without a terminal result.');
      return { attempted: true, outcome: 'no-terminal' };
    } finally {
      await session.dispose();
    }
  } catch (error) {
    const code = safeCode(error);
    if (error instanceof CodexRuntimeAdapterError && code === 'session-mint-unavailable') {
      problems.push('Live turn gated: the thread/turn transport is the next WF-1 slice (session-mint-unavailable).');
      return { attempted: true, outcome: 'gated', code };
    }
    problems.push(`Live turn failed: ${code}`);
    return { attempted: true, outcome: 'error', code };
  }
}

function safeCode(error: unknown): string {
  if (error instanceof CodexRuntimeAdapterError || error instanceof RuntimeSelectionRejectedError) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

void main();
