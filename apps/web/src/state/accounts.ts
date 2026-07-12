// Account switcher — a core subsystem (AGENTS.md). Each account is a Claude
// login (config dir) the server selects via CLAUDE_CONFIG_DIR. Switching a
// project's account ends its session and mints a new one (sessions live per
// config dir): the server broadcasts `session-changed`, the chat store follows.
//
// This store is the UI selection AND the server round-trip. It seeds the
// registry from GET /api/accounts, seeds the active project's account from
// GET /api/projects/:id/account, and POSTs the change. `selectedId` drives the
// header control + usage display; the server is the source of truth.

import { create } from 'zustand';
import { getJson, postJson } from '@/api/http';
import {
  isSessionSummary,
  type SessionChangedFrame,
  type SessionSummary,
  type SessionUpdatedFrame,
} from '@pc/contracts';

export type AccountId = string;

export interface AccountInfo {
  id: AccountId;
  label: string;
  /** Display-only; the server holds the real path + selects it in the query env. */
  configDir: string;
}

/** Offline fallback for first paint before GET /api/accounts lands. Matches the
 *  registry default in AGENTS.md; replaced by the server list on load. */
export const DEFAULT_ACCOUNTS: AccountInfo[] = [
  { id: 'personal', label: 'Personal', configDir: 'C:\\Users\\emers\\.claude' },
  { id: 'work', label: 'Work', configDir: 'C:\\Users\\emers\\.claude-work' },
];

/** Title-case the account id — the server registry carries no display label. */
function labelFor(id: string): string {
  return id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
}

interface AccountsListResponse {
  accounts: Array<{ id: string; configDir: string }>;
  defaultAccountId: string;
}

interface AccountSwitchResponse {
  accountId: string;
  switched: boolean;
  session?: SessionSummary | null;
}

const accountsApi = {
  list: () => getJson<AccountsListResponse>('/api/accounts'),
  getForProject: (projectId: string) =>
    getJson<{ accountId: string }>(`/api/projects/${encodeURIComponent(projectId)}/account`),
  setForProject: (projectId: string, accountId: string) =>
    postJson<AccountSwitchResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/account`,
      { accountId },
    ),
};

export type SwitchStatus = 'idle' | 'pending' | 'error';

interface AccountsState {
  accounts: AccountInfo[];
  /** Project whose default/stamped session the singleton header represents. */
  projectId: string | null;
  /** The account shown as active in the header + used for usage display. Seeded
   *  from the active session stamp when present, otherwise the project default. */
  selectedId: AccountId;
  /** Browser-safe active stamp/provenance. Native identity is presence-only. */
  activeSession: SessionSummary | null;
  /** Invalidates a slower project-default read after authoritative session state. */
  sessionStampVersion: number;
  /** Round-trip state for the header control (positive receipt — no silent fail). */
  status: SwitchStatus;
  /** The account id mid-switch (spinner target), or null. */
  pendingId: AccountId | null;
  error: string | null;
  /** Local-only selection (display); the real, server-backed switch is switchAccount. */
  select: (id: AccountId) => void;
  /** Bind all subsequent reads and socket updates to exactly one project. */
  bindProject: (projectId: string | null) => void;
  /** Synchronize the header from a strictly guarded session lifecycle frame. */
  applySessionChanged: (frame: SessionChangedFrame) => void;
  /** Apply provenance/identity presence without treating it as a boundary. */
  applySessionUpdated: (frame: SessionUpdatedFrame) => void;
  /** Load the registry list from the server (replaces the stub). */
  loadRegistry: () => Promise<void>;
  /** Seed selectedId from a project's current default account. */
  loadForProject: (projectId: string) => Promise<void>;
  /** POST a project's account change; on success the server ends the session +
   *  broadcasts `session-changed` (the chat store follows over the WS). */
  switchAccount: (projectId: string, accountId: string) => Promise<void>;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  accounts: DEFAULT_ACCOUNTS,
  projectId: null,
  selectedId: DEFAULT_ACCOUNTS[0]!.id,
  activeSession: null,
  sessionStampVersion: 0,
  status: 'idle',
  pendingId: null,
  error: null,

  select: (selectedId) =>
    set((state) => state.activeSession?.selection ? state : { selectedId }),

  bindProject: (projectId) =>
    set((state) => state.projectId === projectId ? state : ({
      projectId,
      activeSession: null,
      sessionStampVersion: state.sessionStampVersion + 1,
      status: 'idle',
      pendingId: null,
      error: null,
    })),

  applySessionChanged: (frame) =>
    set((state) => {
      if (state.projectId !== frame.projectId) return state;
      const stampedAccountId = frame.session?.selection?.accountId;
      return {
        activeSession: frame.session,
        selectedId: stampedAccountId ?? state.selectedId,
        // A null snapshot confirms only that no app session is active; it does
        // not supersede the independent project-default account read.
        sessionStampVersion: state.sessionStampVersion + (stampedAccountId ? 1 : 0),
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
        selectedId: frame.session.selection?.accountId ?? state.selectedId,
        sessionStampVersion: state.sessionStampVersion + 1,
      };
    }),

  loadRegistry: async () => {
    try {
      const res = await accountsApi.list();
      const accounts = res.accounts.map((a) => ({
        id: a.id,
        label: labelFor(a.id),
        configDir: a.configDir,
      }));
      if (accounts.length > 0) set({ accounts });
    } catch {
      /* keep the fallback list; the header still renders */
    }
  },

  loadForProject: async (projectId) => {
    get().bindProject(projectId);
    const versionAtRead = get().sessionStampVersion;
    try {
      const { accountId } = await accountsApi.getForProject(projectId);
      const current = get();
      if (
        current.projectId !== projectId ||
        current.sessionStampVersion !== versionAtRead ||
        current.activeSession?.selection
      ) return;
      set({ selectedId: accountId, status: 'idle', pendingId: null, error: null });
    } catch {
      /* a failed read isn't a switch failure — leave the current selection */
    }
  },

  switchAccount: async (projectId, accountId) => {
    if (get().status === 'pending') return;
    get().bindProject(projectId);
    set({ status: 'pending', pendingId: accountId, error: null });
    try {
      const res = await accountsApi.setForProject(projectId, accountId);
      if (get().projectId !== projectId) return;
      const session = res.session && isSessionSummary(res.session) && res.session.projectId === projectId
        ? res.session
        : null;
      // Preserve the positive HTTP receipt while accepting the stamped summary
      // when supplied. The guarded WS frame remains the reconnect authority.
      set((state) => ({
        selectedId: session?.selection?.accountId ?? res.accountId,
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
  },
}));
