// Create-project modal. Probes the target folder (POST /api/fs/probe) to derive
// the create mode, then POST /api/projects. The native folder browser is gone
// (files browser deleted); the folder path is entered directly — prefilled from
// the Projects folder setting.

import { useEffect, useState } from 'react';

import { fsApi, type FolderProbe } from '@/features/fs/client';
import { projectsApi, type Project } from '@/features/projects/client';
import { createProjectModeFromProbe } from '@/features/projects/createMode';

interface CreateProjectModalProps {
  /** Global Projects folder setting — prefilled as the path base. */
  projectsFolder?: string;
  onClose: () => void;
  onOpenAppSettings: () => void;
  onCreated: (project: Project) => void;
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; probe: FolderProbe }
  | { status: 'error'; message: string };

export function CreateProjectModal({
  projectsFolder,
  onClose,
  onOpenAppSettings,
  onCreated,
}: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [probeState, setProbeState] = useState<ProbeState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function probe(path: string) {
    if (!path.trim()) {
      setProbeState({ status: 'idle' });
      return;
    }
    setProbeState({ status: 'checking' });
    fsApi
      .probeFolder(path.trim())
      .then((p) => setProbeState({ status: 'ready', probe: p }))
      .catch((e) => setProbeState({ status: 'error', message: (e as Error).message }));
  }

  const mode = probeState.status === 'ready' ? createProjectModeFromProbe(probeState.probe) : null;
  const canCreate = !busy && name.trim().length > 0 && mode !== null;

  async function submit() {
    if (!canCreate || mode === null) return;
    setBusy(true);
    setErr(null);
    try {
      const project = await projectsApi.createProject({
        name: name.trim(),
        folder_path: folderPath.trim(),
        mode,
      });
      onCreated(project);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40" onClick={onClose}>
      <div
        className="flex w-[520px] flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Create project</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            ×
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3 px-4 py-4"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              className="bg-muted px-2 py-1 text-sm"
            />
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Folder</span>
            {projectsFolder ? (
              <p className="text-[11px] text-muted-foreground">
                Projects folder:{' '}
                <code className="bg-muted px-1 font-mono">{projectsFolder}</code>
              </p>
            ) : (
              <p className="text-[11px] text-warning">
                No Projects folder set yet.{' '}
                <button type="button" onClick={onOpenAppSettings} className="underline hover:text-foreground">
                  Open App Settings
                </button>{' '}
                to choose where projects live.
              </p>
            )}
            <input
              value={folderPath}
              onChange={(e) => {
                setFolderPath(e.target.value);
                setProbeState({ status: 'idle' });
              }}
              onBlur={() => probe(folderPath)}
              placeholder={projectsFolder ? `${projectsFolder}\\my-project` : 'C:\\path\\to\\project'}
              className="w-full bg-muted px-2 py-1 font-mono text-xs"
            />
            <ProbePreview state={probeState} />
          </div>

          {err && <div className="text-xs text-destructive">{err}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProbePreview({ state }: { state: ProbeState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'checking') return <div className="text-xs text-muted-foreground">Checking…</div>;
  if (state.status === 'error') return <div className="text-xs text-destructive">{state.message}</div>;
  const { probe } = state;
  if (!probe.exists) return <div className="text-xs text-destructive">Folder does not exist.</div>;
  if (!probe.isDirectory) return <div className="text-xs text-destructive">Path is not a directory.</div>;
  if (probe.isGitRepo) {
    return (
      <div className="text-xs text-success">
        Existing git repo — PC-SDK adopts it as-is. Nothing is written to your repo.
      </div>
    );
  }
  if (!probe.hasFiles) {
    return <div className="text-xs text-success">Empty folder — will git init here and commit the scaffold.</div>;
  }
  return (
    <div className="text-xs text-warning">
      {probe.fileCount} existing {probe.fileCount === 1 ? 'entry' : 'entries'}, no .git — will commit as{' '}
      <code className="bg-muted px-1">Initial import</code> then add scaffold.
    </div>
  );
}
