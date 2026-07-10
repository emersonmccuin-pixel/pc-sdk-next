// DEV-only — rendered in Shell under import.meta.env.DEV so Vite tree-shakes it
// out of production. Trimmed to a reload affordance; the PTY-supervisor restart
// loop (dev-controls client, exit-75 respawn) is gone. A dev restart endpoint
// can be re-added here once the server sibling exposes one.

export function DevControls() {
  return (
    <div className="pointer-events-none fixed bottom-2 right-2 z-50">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="hover:text-foreground"
          title="Reload frontend"
        >
          reload
        </button>
      </div>
    </div>
  );
}
