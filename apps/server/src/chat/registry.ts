// One SessionService per project, lazily created and wired to the WS hub room.

import type { ServerFrame, SubscriptionQuotaObservationBatch } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { listProjectsWithQueuedConversationSends } from '@pc/db';
import type {
  RuntimeContinuationRequest,
  RuntimeSelection,
  RuntimeSelectionValidation,
  RuntimeSessionFactory,
} from '../runner/runtime.ts';
import type { ProjectWebSocketHub } from '../ws/hub.ts';
import { SessionService } from './session-service.ts';
import type { ConversationRelay } from './conversation-relay.ts';

export interface SessionRegistryDeps {
  hub: ProjectWebSocketHub<ULID>;
  conversationRelay?: ConversationRelay;
  mintSession: RuntimeSessionFactory;
  resolveNewSessionSelection: (
    input: { projectId: ULID; accountId?: string },
  ) => Promise<RuntimeSelectionValidation>;
  preflightRuntimeSession: (
    selection: RuntimeSelection,
    continuation: RuntimeContinuationRequest,
  ) => Promise<RuntimeSelectionValidation>;
  cwd?: string;
  askTimeoutMs?: number;
  interruptTimeoutMs?: number;
  onSubscriptionQuota?: (batch: SubscriptionQuotaObservationBatch) => void;
  orchestratorRev?: () => number | null;
}

export class SessionRegistry {
  private readonly services = new Map<ULID, SessionService>();
  private readonly deps: SessionRegistryDeps;
  private queueDrainReady = false;

  constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
  }

  /** Start surviving FIFO work only after the composition root has finished
   * the required boot sequence (live port, dispatch attach, and MCP probe).
   * Constructing the registry must never mint a partially configured runtime. */
  kickRecoveredQueues(): void {
    this.queueDrainReady = true;
    for (const service of this.services.values()) service.enableQueueDrain();
    for (const projectId of listProjectsWithQueuedConversationSends()) {
      const service = this.get(projectId);
      service.enableQueueDrain();
      service.kick();
    }
  }

  get(projectId: ULID): SessionService {
    let svc = this.services.get(projectId);
    if (!svc) {
      svc = new SessionService({
        projectId,
        broadcast: (frame: ServerFrame) => this.deps.hub.broadcast(projectId, frame),
        mintSession: this.deps.mintSession,
        resolveNewSessionSelection: this.deps.resolveNewSessionSelection,
        preflightRuntimeSession: this.deps.preflightRuntimeSession,
        drainConversationOutbox: () => this.deps.conversationRelay?.drain(),
        cwd: this.deps.cwd,
        askTimeoutMs: this.deps.askTimeoutMs,
        interruptTimeoutMs: this.deps.interruptTimeoutMs,
        queueDrainEnabled: this.queueDrainReady,
        onSubscriptionQuota: this.deps.onSubscriptionQuota,
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

  async disposeProject(projectId: ULID): Promise<void> {
    const service = this.services.get(projectId);
    if (!service) return;
    this.services.delete(projectId);
    await service.dispose();
  }
}
