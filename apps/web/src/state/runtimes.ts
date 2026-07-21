// Runtime switcher — mirrors the account switcher (`state/accounts.ts`)
// exactly, but one level up: each entry is a registered agent-runtime adapter
// (Claude, Codex, …) rather than a login. Switching a project's runtime ends
// its session and mints a new one — a runtime change is always a session
// boundary (docs/agent-runtime-architecture.md "Sessions and switching"), and
// a Claude session is never resumed as a Codex thread or vice versa.
//
// This store is the UI selection AND the server round-trip. It seeds the
// registry from GET /api/runtimes (availability + discovered models per
// account), seeds the active project's runtime from GET /api/projects/:id/
// runtime, and POSTs the change. The server broadcasts `session-changed`;
// the chat store follows.

import { create } from 'zustand';
import { getJson, postJson } from '@/api/http';
import {
  isSessionSummary,
  type RuntimeCapabilities,
  type RuntimeModel,
  type RuntimeModelDiscovery,
  type SessionChangedFrame,
  type SessionSummary,
  type SessionUpdatedFrame,
} from '@pc/contracts';

export type RuntimeId = string;

export interface RuntimeAccountInfo {
  id: string;
  capabilities: RuntimeCapabilities | null;
  models: RuntimeModel[];
  /** True when this account can actually run a turn today — model discovery
   *  succeeded. False renders as visibly unavailable with `reasonCode`, never
   *  hidden and never silently clickable. */
  available: boolean;
  reasonCode: string | null;
}

export interface RuntimeInfo {
  id: RuntimeId;
  label: string;
  accounts: RuntimeAccountInfo[];
}

/** Offline fallback for first paint before GET /api/runtimes lands. Claude is
 *  always the server default runtime; Codex only shows once discovered. */
export const DEFAULT_RUNTIMES: RuntimeInfo[] = [
  { id: 'claude-agent-sdk', label: 'Claude', accounts: [] },
];

function labelFor(id: string): string {
  if (id === 'claude-agent-sdk') return 'Claude';
  if (id === 'openai-codex') return 'Codex';
  return id;
}

interface RuntimesListResponse {
  ok: boolean;
  runtimes: Array<{
    runtimeId: string;
    accounts: Array<{ id: string; capabilities: RuntimeCapabilities | null; models: RuntimeModelDiscovery | null }>;
  }>;
}

interface RuntimeSwitchResponse {
  runtimeId: string;
  switched: boolean;
  session?: SessionSummary | null;
}

/** Body for POST /api/projects/:id/runtime. `runtimeId` alone is the
 *  pre-existing runtime-switch shape; `accountId`/`model`/`effort` are
 *  optional additions for the header model/effort pickers. */
export interface RuntimeSelectionPatch {
  runtimeId: string;
  accountId?: string;
  model?: string;
  effort?: string | null;
}

const runtimesApi = {
  list: () => getJson<RuntimesListResponse>('/api/runtimes'),
  getForProject: (projectId: string) =>
    getJson<{ runtimeId: string }>(`/api/projects/${encodeURIComponent(projectId)}/runtime`),
  setForProject: (projectId: string, patch: RuntimeSelectionPatch) =>
    postJson<RuntimeSwitchResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/runtime`,
      patch,
    ),
};

/** An account is usable today exactly when model discovery succeeded — no
 *  model, no turn. Anything else is visibly unavailable with its typed reason
 *  (never hidden, never a fabricated fallback code). */
function accountAvailability(
  models: RuntimeModelDiscovery | null,
  capabilities: RuntimeCapabilities | null,
): { available: boolean; models: RuntimeModel[]; reasonCode: string | null } {
  if (models?.status === 'available') return { available: true, models: models.models, reasonCode: null };
  if (models) return { available: false, models: [], reasonCode: models.code };
  if (capabilities && capabilities.modelDiscovery.status !== 'supported') {
    return { available: false, models: [], reasonCode: capabilities.modelDiscovery.code };
  }
  return { available: false, models: [], reasonCode: 'runtime-unavailable' };
}

function toRuntimeInfo(row: RuntimesListResponse['runtimes'][number]): RuntimeInfo {
  return {
    id: row.runtimeId,
    label: labelFor(row.runtimeId),
    accounts: row.accounts.map((a) => ({
      id: a.id,
      capabilities: a.capabilities,
      ...accountAvailability(a.models, a.capabilities),
    })),
  };
}

export type SwitchStatus = 'idle' | 'pending' | 'error';

interface RuntimesState {
  runtimes: RuntimeInfo[];
  /** Project whose default/stamped runtime the singleton header represents. */
  projectId: string | null;
  selectedId: RuntimeId;
  /** False while the bound project's stamped/default selection is unresolved. */
  selectionResolved: boolean;
  activeSession: SessionSummary | null;
  sessionStampVersion: number;
  status: SwitchStatus;
  pendingId: RuntimeId | null;
  error: string | null;
  bindProject: (projectId: string | null) => void;
  applySessionChanged: (frame: SessionChangedFrame) => void;
  applySessionUpdated: (frame: SessionUpdatedFrame) => void;
  loadRegistry: () => Promise<void>;
  loadForProject: (projectId: string) => Promise<void>;
  switchRuntime: (projectId: string, runtimeId: string) => Promise<void>;
  /** Same-runtime model change (header model picker). Carries the active
   *  session's current account forward so only the model moves; effort is
   *  intentionally NOT carried forward (a new model's supported effort values
   *  can differ) — it falls back to the runtime's administered default,
   *  mirroring switchRuntime/switchAccount, which already reset the model the
   *  same way on every mint. Still mints a fresh session: see
   *  SessionService.changeSelection for why a same-runtime selection change
   *  can't continue the row in place today. */
  setModel: (projectId: string, model: string) => Promise<void>;
  /** Same-runtime, same-model effort change (header effort picker). `effort:
   *  null` clears back to the runtime's default (no override). */
  setEffort: (projectId: string, effort: string | null) => Promise<void>;
}

export const useRuntimes = create<RuntimesState>((set, get) => {
  /** Shared round-trip for switchRuntime/setModel/setEffort — same request
   *  shape, same pending/error handling, same session-adoption rules. */
  async function applySelectionChange(
    projectId: string,
    patch: RuntimeSelectionPatch,
    pendingId: RuntimeId | null,
  ): Promise<void> {
    if (get().status === 'pending') return;
    get().bindProject(projectId);
    set({ status: 'pending', pendingId, error: null });
    try {
      const res = await runtimesApi.setForProject(projectId, patch);
      if (get().projectId !== projectId) return;
      const session = res.session && isSessionSummary(res.session) && res.session.projectId === projectId
        ? res.session
        : null;
      set((state) => ({
        selectedId: session?.selection?.runtimeId ?? res.runtimeId,
        selectionResolved: true,
        activeSession: session ?? (res.switched ? null : state.activeSession),
        sessionStampVersion: state.sessionStampVersion + (res.switched || session ? 1 : 0),
        status: 'idle',
        pendingId: null,
        error: null,
      }));
    } catch (err) {
      if (get().projectId !== projectId) return;
      set({ status: 'error', pendingId: null, error: (err as Error).message });
    }
  }

  return {
    runtimes: DEFAULT_RUNTIMES,
    projectId: null,
    selectedId: DEFAULT_RUNTIMES[0]!.id,
    selectionResolved: true,
    activeSession: null,
    sessionStampVersion: 0,
    status: 'idle',
    pendingId: null,
    error: null,

    bindProject: (projectId) =>
      set((state) => state.projectId === projectId ? state : ({
        projectId,
        activeSession: null,
        selectionResolved: projectId === null,
        sessionStampVersion: state.sessionStampVersion + 1,
        status: 'idle',
        pendingId: null,
        error: null,
      })),

    applySessionChanged: (frame) =>
      set((state) => {
        if (state.projectId !== frame.projectId) return state;
        const stampedRuntimeId = frame.session?.selection?.runtimeId;
        return {
          activeSession: frame.session,
          selectedId: stampedRuntimeId ?? state.selectedId,
          selectionResolved: stampedRuntimeId ? true : state.selectionResolved,
          status: stampedRuntimeId ? 'idle' : state.status,
          pendingId: stampedRuntimeId ? null : state.pendingId,
          error: stampedRuntimeId ? null : state.error,
          sessionStampVersion: state.sessionStampVersion + (stampedRuntimeId ? 1 : 0),
        };
      }),

    applySessionUpdated: (frame) =>
      set((state) => {
        if (
          state.projectId !== frame.projectId ||
          state.activeSession?.id !== frame.session.id
        ) return state;
        return {
          activeSession: frame.session,
          selectedId: frame.session.selection?.runtimeId ?? state.selectedId,
          selectionResolved: frame.session.selection ? true : state.selectionResolved,
          status: frame.session.selection ? 'idle' : state.status,
          pendingId: frame.session.selection ? null : state.pendingId,
          error: frame.session.selection ? null : state.error,
          sessionStampVersion: state.sessionStampVersion + 1,
        };
      }),

    loadRegistry: async () => {
      try {
        const res = await runtimesApi.list();
        const runtimes = res.runtimes.map(toRuntimeInfo);
        if (runtimes.length > 0) set({ runtimes });
      } catch {
        /* keep the fallback list; the header still renders */
      }
    },

    loadForProject: async (projectId) => {
      get().bindProject(projectId);
      if (!get().selectionResolved) {
        set({ status: 'pending', pendingId: null, error: null });
      }
      const versionAtRead = get().sessionStampVersion;
      try {
        const { runtimeId } = await runtimesApi.getForProject(projectId);
        const current = get();
        if (
          current.projectId !== projectId ||
          current.sessionStampVersion !== versionAtRead ||
          current.activeSession?.selection
        ) return;
        set({
          selectedId: runtimeId,
          selectionResolved: true,
          status: 'idle',
          pendingId: null,
          error: null,
        });
      } catch {
        const current = get();
        if (
          current.projectId === projectId &&
          current.sessionStampVersion === versionAtRead &&
          !current.selectionResolved
        ) {
          set({
            status: 'error',
            pendingId: null,
            error: 'Runtime selection unavailable. Retry or reconnect.',
          });
        }
      }
    },

    switchRuntime: (projectId, runtimeId) =>
      applySelectionChange(projectId, { runtimeId }, runtimeId),

    setModel: (projectId, model) => {
      const sel = get().activeSession?.selection;
      const runtimeId = sel?.runtimeId ?? get().selectedId;
      return applySelectionChange(projectId, {
        runtimeId,
        ...(sel?.accountId ? { accountId: sel.accountId } : {}),
        model,
      }, null);
    },

    setEffort: (projectId, effort) => {
      const sel = get().activeSession?.selection;
      // No active stamped selection to keep the model fixed under — nothing
      // to apply (the effort picker is disabled in this state; see
      // EffortSwitcher).
      if (!sel?.model) return Promise.resolve();
      return applySelectionChange(projectId, {
        runtimeId: sel.runtimeId,
        accountId: sel.accountId,
        model: sel.model,
        effort,
      }, null);
    },
  };
});
