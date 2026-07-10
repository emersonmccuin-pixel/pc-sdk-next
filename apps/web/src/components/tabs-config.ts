// Pure constants — no JSX. Importable by tests without a JSX transform.
// TabBar (JSX) lives in Tabs.tsx and imports from here.
//
// Dead tabs removed vs. PC-PTY-Chat: work-items (kanban lives in AInativePM),
// workflows (no workflow engine), files (files browser deleted). What survives:
// orchestrator chat + the agents/activity surface. `project-settings` is
// reachable via the right-aligned gear, not the main strip.

export const TABS = ['orchestrator', 'agents'] as const;
export type Tab = (typeof TABS)[number] | 'project-settings';

/** Command is a cross-project planning surface; same nav as a normal project. */
export const COMMAND_TABS: ReadonlyArray<(typeof TABS)[number]> = [
  'orchestrator',
  'agents',
] as const;
