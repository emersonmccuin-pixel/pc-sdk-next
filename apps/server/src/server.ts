// Server assembly — Hono HTTP + `ws` on one Node listener. Wires the session
// registry, resource relay drain, WS upgrade routing, and (optionally) static
// serving of a built web app. Injectable runtime-session factory: prod resolves
// an adapter at the composition root, tests pass a FakeRuntime.

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import type { UsageSnapshot } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type {
  RuntimeContinuationRequest,
  RuntimeSelection,
  RuntimeSelectionValidation,
  RuntimeSessionFactory,
} from './runner/runtime.ts';
import type { DispatchService } from './dispatch/service.ts';
import type { AccountRegistry } from './runner/account-env.ts';
import type { UsageCache } from './usage/cache.ts';
import { SessionRegistry } from './chat/registry.ts';
import { ConversationRelay } from './chat/conversation-relay.ts';
import { ResourceRelay } from './resources/relay.ts';
import { createHttpApp } from './http/index.ts';
import { runBootRecovery } from './boot-recovery.ts';
import { ProjectWebSocketHub } from './ws/hub.ts';
import { attachSocket, type RouterSocket } from './ws/router.ts';

export interface StartServerOptions {
  mintSession: RuntimeSessionFactory;
  resolveNewSessionSelection: (
    input: { projectId: ULID; accountId?: string },
  ) => Promise<RuntimeSelectionValidation>;
  preflightRuntimeSession: (
    selection: RuntimeSelection,
    continuation: RuntimeContinuationRequest,
  ) => Promise<RuntimeSelectionValidation>;
  port?: number;
  /** Stable local-process identity returned by /health. Launchers must verify
   *  this before treating an occupied port as their own instance. */
  instanceId?: string;
  /** Absolute path to a built web app (apps/web/dist). Absent/missing tolerated. */
  webDist?: string | null;
  cwd?: string;
  askTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** Composition root defers chat execution until dispatch/MCP boot is ready. */
  deferConversationQueueDrain?: boolean;
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  /** Rev of the orchestrator agent row — SessionService re-mints the backend
   *  between turns when it changes (prompt/model edits apply next message). */
  orchestratorRev?: () => number | null;
  version?: string;
  /** Account switcher registry — mounts the accounts + usage HTTP routes. */
  accounts?: AccountRegistry;
  orchestratorRuntimeId?: string;
  /** Usage cache — served by the `/api/usage` re-prime route. */
  usage?: UsageCache;
  /** Phase-3 dispatch service — mounts the agent-run routes when set. */
  dispatch?: DispatchService;
  /** In-app engine restart hook (composition root owns the respawn). */
  onRestartRequest?: () => void;
  /** Run boot recovery before listening. Default true. */
  runRecovery?: boolean;
  /** Resource-relay drain cadence (ms). Default 250. */
  drainIntervalMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  hub: ProjectWebSocketHub<ULID>;
  registry: SessionRegistry;
  relay: ResourceRelay;
  conversationRelay: ConversationRelay;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  if (opts.runRecovery !== false) runBootRecovery();

  const hub = new ProjectWebSocketHub<ULID>();
  const relay = new ResourceRelay({ hub });
  const conversationRelay = new ConversationRelay({ hub });
  relay.primeToHead();
  // Recovery runs before the listener exists. Consume its canonical outbox now
  // so cold replay carries the evidence without a stale live redelivery later.
  conversationRelay.drain();
  const registry = new SessionRegistry({
    hub,
    conversationRelay,
    mintSession: opts.mintSession,
    resolveNewSessionSelection: opts.resolveNewSessionSelection,
    preflightRuntimeSession: opts.preflightRuntimeSession,
    cwd: opts.cwd,
    askTimeoutMs: opts.askTimeoutMs,
    interruptTimeoutMs: opts.interruptTimeoutMs,
    onRateLimit: opts.onRateLimit,
    orchestratorRev: opts.orchestratorRev,
  });

  const app = createHttpApp({
    registry,
    version: opts.version,
    instanceId: opts.instanceId ?? process.env.PC_INSTANCE_ID ?? 'pc-sdk-next',
    accounts: opts.accounts,
    orchestratorRuntimeId: opts.orchestratorRuntimeId,
    usage: opts.usage,
    dispatch: opts.dispatch,
    onRestartRequest: opts.onRestartRequest,
  });

  // Static serving (SPA) — only when a built web dir is present.
  const webDist = opts.webDist && existsSync(opts.webDist) ? resolve(opts.webDist) : null;
  if (webDist) {
    app.get('*', async (c) => {
      const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
      const file = resolveStaticFile(webDist, urlPath);
      if (!file) return c.notFound();
      const bytes = new Uint8Array(readFileSync(file));
      return new Response(bytes, { headers: { 'content-type': contentType(file) } });
    });
  }

  const port = opts.port ?? Number(process.env.PC_PORT ?? 5124);

  const server = await new Promise<Server>((resolveServer) => {
    const s = serve({ fetch: app.fetch, port }, () => resolveServer(s as unknown as Server));
  });
  const actualPort = addressPort(server) ?? port;

  // Standalone/test servers are fully composed at listen. Production defers
  // this one-way gate until index.ts finishes dispatch and MCP bootstrap.
  if (!opts.deferConversationQueueDrain) registry.kickRecoveredQueues();

  // WS on the same listener.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const projectId = url.searchParams.get('projectId');
    if (url.pathname !== '/ws' || !projectId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(ws as unknown as RouterSocket, projectId as ULID, { hub, registry, relay });
    });
  });

  const drainIntervalMs = opts.drainIntervalMs ?? 250;
  const drainTimer = setInterval(() => {
    try {
      relay.drain();
    } catch (err) {
      console.warn('[pc-sdk][resource-relay] drain failed:', err instanceof Error ? err.message : err);
    }
    try {
      conversationRelay.drain();
    } catch (err) {
      console.warn('[pc-sdk][conversation-relay] drain failed:', err instanceof Error ? err.message : err);
    }
  }, drainIntervalMs);
  if (typeof drainTimer.unref === 'function') drainTimer.unref();

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    hub,
    registry,
    relay,
    conversationRelay,
    async close() {
      clearInterval(drainTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await registry.disposeAll();
      // Idle keep-alive sockets would otherwise hold close() open ~5s.
      (server as Server & { closeIdleConnections?: () => void }).closeIdleConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function addressPort(server: Server): number | null {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : null;
}

/** Resolve a request path to a file inside `root`, with SPA fallback to
 *  index.html. Returns null if nothing serveable (path traversal is rejected). */
function resolveStaticFile(root: string, urlPath: string): string | null {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let candidate = resolve(root, `.${sep}${rel}`);
  if (!candidate.startsWith(root)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  candidate = join(root, 'index.html');
  return existsSync(candidate) ? candidate : null;
}

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
