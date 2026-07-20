// Live Codex turn smoke gate.
//
// WHAT THIS PROVES (and what it does not):
// This is a REAL end-to-end gate against the pinned native Codex app-server and
// the machine's real ~/.codex ChatGPT login. It (1) discovers the account's
// supported models, (2) round-trips a real turn that must return `pong`, and
// (3) starts a longer turn, interrupts it, and asserts the native
// `turn/completed status=interrupted` outcome (the outcome CodexRuntimeSession
// maps to a typed `aborted` result).
//
// It drives the wire directly here (its own JSONL framing over the child's
// stdio) rather than through CodexRuntimeSession, because the in-process
// product turn path (live-peer.ts `liveRuntimePeerFactory`) is still gated: the
// CX-002 receipt contract hardcodes the `contained-fake` lifecycle and the
// app-server-client is admission-only, so honestly un-gating it requires a
// contract widening not yet landed. This script therefore proves the native
// substrate + login + model + turn + interrupt are real and usable; it does not
// prove the adapter surface. Executable + environment resolution are the SAME
// product code (`resolvePinnedCodexExecutable`, `buildCodexEnvironment`) so the
// spawn shape matches production exactly.
//
// Exit 0 on pass; non-zero on any failure. A missing/expired login is reported
// as a typed failure, never faked into a pass.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildCodexEnvironment } from '../apps/server/src/runner/codex/environment.ts';
import { resolvePinnedCodexExecutable } from '../apps/server/src/runner/codex/executable.ts';

interface JsonRpcResult {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

type Notification = { readonly method: string; readonly params: Record<string, unknown> };

const TURN_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 30_000;

class LiveDriver {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly notificationHandlers = new Set<(n: Notification) => void>();
  private fatal: Error | null = null;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr!.on('data', () => {
      // The real ~/.codex home emits benign operational stderr (stale model
      // cache warnings, failing user MCP servers). It is not turn-fatal here.
    });
    child.on('exit', (code, signal) => {
      this.failAll(new Error(`app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    for (let nl = this.buf.indexOf('\n'); nl !== -1; nl = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
      if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
        this.settle(msg as unknown as JsonRpcResult);
      } else if (hasId && typeof msg.method === 'string') {
        // A server->client request (e.g. an approval). The read-only/never turn
        // used here never triggers one; refuse defensively so nothing hangs.
        this.write({ id: msg.id, error: { code: -32601, message: 'unsupported' } });
      } else if (typeof msg.method === 'string') {
        const notification: Notification = {
          method: msg.method,
          params: (msg.params ?? {}) as Record<string, unknown>,
        };
        for (const handler of [...this.notificationHandlers]) handler(notification);
      }
    }
  }

  private settle(msg: JsonRpcResult): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) entry.reject(new Error(`request ${msg.id}: ${JSON.stringify(msg.error)}`));
    else entry.resolve(msg.result);
  }

  private failAll(error: Error): void {
    if (!this.fatal) this.fatal = error;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private write(value: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ method, id, params });
    return promise;
  }

  notify(method: string): void {
    this.write({ method });
  }

  onNotification(handler: (n: Notification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  dispose(): void {
    try {
      this.child.kill('SIGKILL');
    } catch {
      // best effort
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function assertLogin(codexHome: string): void {
  const authPath = join(codexHome, 'auth.json');
  if (!existsSync(authPath)) {
    throw new Error(`no Codex login: ${authPath} is missing (run \`codex login\`)`);
  }
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as { tokens?: { access_token?: string } };
    const token = auth.tokens?.access_token ?? '';
    const payload = token.split('.')[1];
    if (payload) {
      const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp?: number };
      if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
        // Not fatal by itself: the app-server may refresh. Report it and let the
        // turn be the real arbiter.
        console.warn('WARN: cached access token is JWT-expired; relying on app-server refresh');
      }
    }
  } catch {
    console.warn('WARN: could not introspect auth.json token expiry');
  }
}

async function initialize(driver: LiveDriver, codexHome: string): Promise<void> {
  const init = record(
    await driver.request('initialize', {
      clientInfo: { name: 'pc-sdk-next', title: 'PC-SDK Next', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }),
  );
  if (init.codexHome !== codexHome) {
    throw new Error(`initialize codexHome mismatch: ${String(init.codexHome)} !== ${codexHome}`);
  }
  driver.notify('initialized');
  const account = record(await driver.request('account/read', { refreshToken: false }));
  if (account.requiresOpenaiAuth !== true) {
    throw new Error(`account not a cached ChatGPT login: ${JSON.stringify(account).slice(0, 120)}`);
  }
  console.log(`ACCOUNT ok (${JSON.stringify((account.account as Record<string, unknown>)?.email ?? 'unknown')})`);
}

async function discoverModel(driver: LiveDriver): Promise<string> {
  const models = record(await driver.request('model/list', { includeHidden: false }));
  const data = Array.isArray(models.data) ? (models.data as Array<Record<string, unknown>>) : [];
  const visible = data.filter((m) => m.hidden !== true && typeof m.model === 'string');
  if (visible.length === 0) throw new Error('no visible models for this account');
  const chosen = (visible.find((m) => m.default === true) ?? visible[0]).model as string;
  console.log(`MODELS=${visible.map((m) => m.model).join(', ')} CHOSEN=${chosen}`);
  return chosen;
}

async function startThread(driver: LiveDriver, model: string, cwd: string): Promise<string> {
  const thread = record(
    await driver.request('thread/start', {
      model,
      modelProvider: 'openai',
      serviceTier: null,
      cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      ephemeral: false,
      sessionStartSource: 'startup',
    }),
  );
  const threadId = record(thread.thread).id;
  if (typeof threadId !== 'string') throw new Error('thread/start returned no thread id');
  console.log(`THREAD id=${threadId} sandbox=${JSON.stringify(thread.sandbox)} approvalPolicy=${String(thread.approvalPolicy)}`);
  return threadId;
}

interface TurnOutcome {
  status: string;
  durationMs: number | null;
  text: string;
  sequence: string[];
}

function runTurn(
  driver: LiveDriver,
  threadId: string,
  model: string,
  cwd: string,
  prompt: string,
  onTurnId: (id: string, sawFirstEvent: () => void) => void,
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve, reject) => {
    const sequence: string[] = [];
    let agentText = '';
    let firstEventFired = false;
    let turnId: string | null = null;
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('turn timed out'));
    }, TURN_TIMEOUT_MS);
    // Fire the caller hook only once the turn is genuinely streaming (first
    // agent-message delta). At that point a turn is definitely active and
    // interruptible; firing on turn/started races ahead of an active turn.
    const fireFirst = (): void => {
      if (firstEventFired || turnId === null) return;
      firstEventFired = true;
      onTurnId(turnId, () => {});
    };
    const unsub = driver.onNotification((n) => {
      if (typeof n.params.turnId === 'string' && n.params.turnId !== turnId && turnId !== null) return;
      if (n.method === 'item/agentMessage/delta') sequence.push(`delta`);
      else sequence.push(n.method);
      if (n.method === 'item/agentMessage/delta') fireFirst();
      if (n.method === 'item/completed') {
        const item = n.params.item as Record<string, unknown> | undefined;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') agentText = item.text;
      }
      if (n.method === 'turn/completed') {
        const turn = record(n.params.turn);
        clearTimeout(timer);
        unsub();
        resolve({
          status: String(turn.status),
          durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          text: agentText,
          sequence,
        });
      }
    });
    driver
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model,
        effort: null,
      })
      .then((value) => {
        turnId = record(record(value).turn).id as string;
        console.log(`TURN start turnId=${turnId}`);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        unsub();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

async function main(): Promise<void> {
  const codexHome = realpathSync.native(join(homedir(), '.codex'));
  const cwd = realpathSync.native(process.cwd());
  assertLogin(codexHome);

  const executable = resolvePinnedCodexExecutable();
  const env = buildCodexEnvironment(codexHome);
  const child = spawn(
    executable.command,
    [...executable.argsPrefix, 'app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'],
    { cwd, env, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const driver = new LiveDriver(child);

  try {
    await initialize(driver, codexHome);
    const model = await discoverModel(driver);

    // --- Exercise 1: real pong round-trip ---
    const threadId = await startThread(driver, model, cwd);
    const pong = await runTurn(
      driver,
      threadId,
      model,
      cwd,
      'Reply with exactly the single word: pong',
      () => {},
    );
    console.log(`PONG turn status=${pong.status} durationMs=${pong.durationMs} text=${JSON.stringify(pong.text)}`);
    console.log(`PONG sequence=${pong.sequence.join(' ')}`);
    if (pong.status !== 'completed') throw new Error(`pong turn did not complete: status=${pong.status}`);
    if (!/\bpong\b/i.test(pong.text)) throw new Error(`pong turn text unexpected: ${JSON.stringify(pong.text)}`);

    // --- Exercise 2: real interrupt -> typed aborted outcome ---
    const interruptThread = await startThread(driver, model, cwd);
    const interrupted = await runTurn(
      driver,
      interruptThread,
      model,
      cwd,
      'Write a detailed 600-word essay about the history of mechanical clocks. Put one sentence on each line. Do not stop early.',
      (id) => {
        driver
          .request('turn/interrupt', { threadId: interruptThread, turnId: id })
          .then((r) => console.log(`INTERRUPT accepted response=${JSON.stringify(r)}`))
          .catch((e: unknown) => console.log(`INTERRUPT request error=${String(e)}`));
      },
    );
    console.log(`INTERRUPT turn status=${interrupted.status} durationMs=${interrupted.durationMs}`);
    if (interrupted.status !== 'interrupted') {
      throw new Error(`interrupt turn expected status=interrupted, got ${interrupted.status}`);
    }

    console.log('LIVE SMOKE PASS: real pong round-trip + real interrupt (typed aborted) verified');
  } finally {
    driver.dispose();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`LIVE SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
