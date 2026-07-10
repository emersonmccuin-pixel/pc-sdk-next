// One SessionService per project, lazily created and wired to the WS hub room.

import type { ServerFrame, UsageSnapshot } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { BackendFactory } from '../runner/backend.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { SessionService } from './session-service.ts';

export interface SessionRegistryDeps {
  hub: ProjectWebSocketHub<ULID>;
  backendFactory: BackendFactory;
  cwd?: string;
  askTimeoutMs?: number;
  onRateLimit?: (snapshot: UsageSnapshot) => void;
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
        backendFactory: this.deps.backendFactory,
        cwd: this.deps.cwd,
        askTimeoutMs: this.deps.askTimeoutMs,
        onRateLimit: this.deps.onRateLimit,
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
