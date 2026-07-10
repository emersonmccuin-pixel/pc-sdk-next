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

const accountsApi = {
  list: () => getJson<AccountsListResponse>('/api/accounts'),
  getForProject: (projectId: string) =>
    getJson<{ accountId: string }>(`/api/projects/${encodeURIComponent(projectId)}/account`),
  setForProject: (projectId: string, accountId: string) =>
    postJson<{ accountId: string; switched: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/account`,
      { accountId },
    ),
};

export type SwitchStatus = 'idle' | 'pending' | 'error';

interface AccountsState {
  accounts: AccountInfo[];
  /** The account shown as active in the header + used for usage display. Seeded
   *  from the active project; the server is the source of truth. */
  selectedId: AccountId;
  /** Round-trip state for the header control (positive receipt — no silent fail). */
  status: SwitchStatus;
  /** The account id mid-switch (spinner target), or null. */
  pendingId: AccountId | null;
  error: string | null;
  /** Local-only selection (display); the real, server-backed switch is switchAccount. */
  select: (id: AccountId) => void;
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
  selectedId: DEFAULT_ACCOUNTS[0]!.id,
  status: 'idle',
  pendingId: null,
  error: null,

  select: (selectedId) => set({ selectedId }),

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
    try {
      const { accountId } = await accountsApi.getForProject(projectId);
      set({ selectedId: accountId, status: 'idle', pendingId: null, error: null });
    } catch {
      /* a failed read isn't a switch failure — leave the current selection */
    }
  },

  switchAccount: async (projectId, accountId) => {
    if (get().status === 'pending') return;
    set({ status: 'pending', pendingId: accountId, error: null });
    try {
      const res = await accountsApi.setForProject(projectId, accountId);
      // Server confirmed. session-changed rides the WS; we just reflect selection.
      set({ selectedId: res.accountId, status: 'idle', pendingId: null, error: null });
    } catch (err) {
      set({ status: 'error', pendingId: null, error: (err as Error).message });
    }
  },
}));
