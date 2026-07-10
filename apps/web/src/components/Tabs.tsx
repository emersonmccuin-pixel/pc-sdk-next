// Underline-active tab strip above the Center column. Vendored look from
// PC-PTY-Chat (Section 32.1); dead tabs (work/workflows/files) removed.
// Constants live in tabs-config.ts (no JSX) so tests can import them directly.
import { TABS, COMMAND_TABS } from './tabs-config';
import type { Tab } from './tabs-config';
export type { Tab } from './tabs-config';
export { TABS, COMMAND_TABS };

const LABEL: Record<(typeof TABS)[number], string> = {
  orchestrator: 'chat',
  agents: 'agents',
};

/** Friendly label for any Tab value (used by App's breadcrumb). */
export function tabLabel(t: Tab): string {
  return t === 'project-settings' ? 'project settings' : LABEL[t];
}

export function TabBar({
  value,
  onChange,
  tabs = TABS,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
  /** Override the tab list (e.g. COMMAND_TABS for the Command surface). */
  tabs?: ReadonlyArray<(typeof TABS)[number]>;
}) {
  return (
    <div
      className="flex items-stretch gap-0.5 border-b border-border bg-background px-4"
      style={{ height: 40 }}
    >
      {tabs.map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`group relative inline-flex items-center gap-2 px-4 text-xs uppercase tracking-[0.06em] transition-colors ${
              active ? 'text-primary' : 'text-muted-foreground hover:text-accent'
            }`}
            style={{
              borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
              background: active ? 'rgba(212, 166, 74, 0.05)' : 'transparent',
            }}
          >
            <span>{LABEL[t]}</span>
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        onClick={() => onChange('project-settings')}
        title="Project settings"
        aria-label="Project settings"
        className={`inline-flex items-center px-4 text-sm transition-colors ${
          value === 'project-settings'
            ? 'text-primary'
            : 'text-muted-foreground hover:text-accent'
        }`}
        style={{
          borderBottom: `2px solid ${value === 'project-settings' ? 'var(--primary)' : 'transparent'}`,
          background: value === 'project-settings' ? 'rgba(212, 166, 74, 0.05)' : 'transparent',
        }}
      >
        ⚙
      </button>
    </div>
  );
}
