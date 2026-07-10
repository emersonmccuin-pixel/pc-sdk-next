// App-global active center tab. Switching projects keeps you on whichever
// tab you were last on. Default is the orchestrator (chat) surface.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { TABS, type Tab } from '@/components/Tabs';

/** Coerce a persisted tab that's no longer in the nav (e.g. a removed tab like
 *  'work-items') back to the chat default, so a stale localStorage value can't
 *  leave the user on a blank body. */
function safeTab(t: unknown): Tab {
  return t === 'project-settings' || (TABS as readonly string[]).includes(t as string)
    ? (t as Tab)
    : 'orchestrator';
}

interface ActiveCenterTabState {
  tab: Tab;
  setTab: (tab: Tab) => void;
}

export const useActiveCenterTab = create<ActiveCenterTabState>()(
  persist(
    (set) => ({
      tab: 'orchestrator',
      setTab: (tab) => set({ tab: safeTab(tab) }),
    }),
    {
      name: 'pc.center-tab',
      onRehydrateStorage: () => (state) => {
        if (state) state.tab = safeTab(state.tab);
      },
    },
  ),
);
