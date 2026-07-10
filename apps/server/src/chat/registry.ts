// One SessionService per project, lazily created and wired to the WS hub room.

import type { ServerFrame, UsageSnapshot } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { RuntimeSessionFactory } from '../runner/runtime.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { SessionService } from './session-service.ts';

export interface SessionRegistryDeps {
  hub: ProjectWebSocketHub<ULID>;
  mintSession: RuntimeSessionFactory;
  cwd?: string;
  askTimeoutMs?: number;
  onRateLimit?: (snapshot: UsageSnapshot) => void;
  orchestratorRev?: () => number | null;
}

export class SessionRegistry {
  private readonly services = new Map<ULID, SessionService>();
  private readonly deps: SessionRegistryDeps;

  constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
  }

  get(projectId: ULID): SessionService {
    let svc = this.services.get(projectId);
    if (!svc) {
      svc = new SessionService({
        projectId,
        broadcast: (frame: ServerFrame) => this.deps.hub.broadcast(projectId, frame),
        mintSession: this.deps.mintSession,
        cwd: this.deps.cwd,
        askTimeoutMs: this.deps.askTimeoutMs,
        onRateLimit: this.deps.onRateLimit,
        orchestratorRev: this.deps.orchestratorRev,
      });
      this.services.set(projectId, svc);
    }
    return svc;
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.services.values()].map((s) => s.dispose()));
    this.services.clear();
  }
}
