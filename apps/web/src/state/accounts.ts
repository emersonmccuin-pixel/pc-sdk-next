// Account switcher — a core subsystem (AGENTS.md). The registry maps an account
// id to the Claude config dir that selects the login; the server puts the chosen
// dir into the SDK query env via CLAUDE_CONFIG_DIR. Switching account ⇒ new
// session (sessions live in the config dir).
//
// SEAM: the real registry + per-project default + env selection are server-owned
// (GET/PATCH /api/accounts). This file is a typed store + stub registry so the
// header control renders now; a sibling wires the server round-trip.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AccountId = string;

export interface AccountInfo {
  id: AccountId;
  label: string;
  /** Display-only; the server holds the real path + selects it in the query env. */
  configDir: string;
}

/** Stub registry — matches the locked default in AGENTS.md. The server replaces
 *  this via /api/accounts once that endpoint lands. */
export const DEFAULT_ACCOUNTS: AccountInfo[] = [
  { id: 'personal', label: 'Personal', configDir: 'C:\\Users\\emers\\.claude' },
  { id: 'work', label: 'Work', configDir: 'C:\\Users\\emers\\.claude-work' },
];

interface AccountsState {
  accounts: AccountInfo[];
  /** The account the header control shows as active. Per-project default +
   *  per-dispatch override are server concerns; this is the UI selection. */
  selectedId: AccountId;
  setAccounts: (accounts: AccountInfo[]) => void;
  select: (id: AccountId) => void;
}

export const useAccounts = create<AccountsState>()(
  persist(
    (set) => ({
      accounts: DEFAULT_ACCOUNTS,
      selectedId: DEFAULT_ACCOUNTS[0]!.id,
      setAccounts: (accounts) => set({ accounts }),
      select: (selectedId) => set({ selectedId }),
    }),
    { name: 'pc.accounts' },
  ),
);
