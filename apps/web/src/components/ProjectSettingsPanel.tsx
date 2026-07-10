// Per-project settings. Trimmed vs. PC-PTY-Chat: the Stages + Field-schemas
// sections are gone (kanban lives in AInativePM), and the MCP-servers +
// orchestrator-tools sections are deferred to their own phases (MCP manager =
// Phase 4, specialists = Phase 3). What survives: project info (name / git
// remote / integration branch / remote control) + the danger zone.

import { useEffect, useState } from 'react';

import { projectsApi, type Project } from '@/features/projects/client';
import { DeleteProjectFilesModal, SoftDeleteProjectModal } from './ProjectDangerModals';

interface ProjectSettingsPanelProps {
  project: Project;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
}

type SectionId = 'info' | 'danger';

const SECTIONS: { id: SectionId; label: string; danger?: boolean }[] = [
  { id: 'info', label: 'Project info' },
  { id: 'danger', label: 'Danger zone', danger: true },
];

export function ProjectSettingsPanel({
  project,
  onProjectUpdated,
  onProjectDeleted,
}: ProjectSettingsPanelProps) {
  const [active, setActive] = useState<SectionId>('info');

  useEffect(() => {
    setActive('info');
  }, [project.id]);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold uppercase tracking-wider text-foreground">
          {project.name}
        </h1>
        <p className="text-xs text-muted-foreground">Project settings</p>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-card py-2">
          {SECTIONS.map((s) => {
            const isActive = active === s.id;
            const base = 'block w-full border-l-2 px-3 py-2 text-left text-xs ';
            const state = isActive
              ? 'border-primary bg-muted ' +
                (s.danger ? 'text-destructive font-medium' : 'text-primary font-medium')
              : 'border-transparent hover:bg-muted ' +
                (s.danger ? 'text-destructive/80 hover:text-destructive' : 'text-foreground/80');
            return (
              <button key={s.id} onClick={() => setActive(s.id)} className={base + state}>
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
            {active === 'info' && (
              <Section title="Project info">
                <ProjectInfoForm project={project} onSaved={onProjectUpdated} />
              </Section>
            )}
            {active === 'danger' && (
              <Section title="Danger zone">
                <DangerZone project={project} onDeleted={onProjectDeleted} />
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectInfoForm({ project, onSaved }: { project: Project; onSaved: (next: Project) => void }) {
  const [name, setName] = useState(project.name);
  const [gitRemote, setGitRemote] = useState(project.gitRemote ?? '');
  const [remoteControl, setRemoteControl] = useState(project.settings.remoteControl);
  const [integrationBranch, setIntegrationBranch] = useState(project.settings.integrationBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setGitRemote(project.gitRemote ?? '');
    setRemoteControl(project.settings.remoteControl);
    setIntegrationBranch(project.settings.integrationBranch ?? '');
  }, [
    project.id,
    project.name,
    project.gitRemote,
    project.settings.remoteControl,
    project.settings.integrationBranch,
  ]);

  const trimmedName = name.trim();
  const trimmedRemote = gitRemote.trim();
  const trimmedBranch = integrationBranch.trim();
  const dirty =
    trimmedName !== project.name ||
    (trimmedRemote || null) !== (project.gitRemote ?? null) ||
    remoteControl !== project.settings.remoteControl ||
    (trimmedBranch || null) !== (project.settings.integrationBranch ?? null);
  const valid = trimmedName.length > 0;

  async function save() {
    if (busy || !dirty || !valid) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: {
        name?: string;
        git_remote?: string | null;
        settings?: { remoteControl?: 'use-global' | 'on' | 'off'; integrationBranch?: string | null };
      } = {};
      if (trimmedName !== project.name) patch.name = trimmedName;
      const nextRemote = trimmedRemote ? trimmedRemote : null;
      if (nextRemote !== (project.gitRemote ?? null)) patch.git_remote = nextRemote;
      if (remoteControl !== project.settings.remoteControl) {
        patch.settings = { ...patch.settings, remoteControl };
      }
      const nextBranch = trimmedBranch ? trimmedBranch : null;
      if (nextBranch !== (project.settings.integrationBranch ?? null)) {
        patch.settings = { ...patch.settings, integrationBranch: nextBranch };
      }
      const updated = await projectsApi.updateProject(project.id, patch);
      onSaved(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setName(project.name);
    setGitRemote(project.gitRemote ?? '');
    setRemoteControl(project.settings.remoteControl);
    setIntegrationBranch(project.settings.integrationBranch ?? '');
    setErr(null);
  }

  return (
    <div className="space-y-3">
      <Field label="Display name" help={`The folder name on disk and URLs stay locked at ${project.slug}.`}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border border-border bg-background px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Slug" help="Locked after creation.">
        <code className="block break-all bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {project.slug}
        </code>
      </Field>
      <Field label="Folder">
        <code className="block break-all bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {project.folderPath}
        </code>
      </Field>
      <Field label="Git remote" help="Optional. Leave blank to clear.">
        <input
          type="text"
          value={gitRemote}
          onChange={(e) => setGitRemote(e.target.value)}
          placeholder="git@github.com:org/repo.git"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field
        label="Integration branch"
        help="The branch finished work is merged into. Leave blank to detect automatically."
      >
        <input
          type="text"
          value={integrationBranch}
          onChange={(e) => setIntegrationBranch(e.target.value)}
          placeholder="auto-detect"
          className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field
        label="Remote control"
        help="Whether this project's new chat sessions start remote-ready. Each session also has a live toggle in the chat footer."
      >
        <select
          value={remoteControl}
          onChange={(e) => setRemoteControl(e.target.value as 'use-global' | 'on' | 'off')}
          className="w-full border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="use-global">Use global default</option>
          <option value="on">Always on</option>
          <option value="off">Always off</option>
        </select>
      </Field>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy || !dirty || !valid}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={discard}
          disabled={busy || !dirty}
          className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          Discard
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  );
}

function DangerZone({ project, onDeleted }: { project: Project; onDeleted: (projectId: string) => void }) {
  const [softOpen, setSoftOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesNote, setFilesNote] = useState<string | null>(null);

  return (
    <>
      <div className="space-y-4 border border-destructive/40 bg-destructive/5 p-3">
        <div>
          <div className="mb-1 text-sm font-medium text-destructive">Archive project</div>
          <p className="mb-2 text-xs text-foreground/80">
            Hides the project from the rail. Files on disk are untouched. Restorable from "Show archived".
          </p>
          <button
            onClick={() => setSoftOpen(true)}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Archive…
          </button>
        </div>

        <div className="border-t border-destructive/30 pt-3">
          <div className="mb-1 text-sm font-medium text-destructive">Delete PC files on disk</div>
          <p className="mb-2 text-xs text-foreground/80">
            Removes <code className="font-mono">.project-companion/</code> from the project folder. Your
            own files, <code className="font-mono">.git/</code>, README, and{' '}
            <code className="font-mono">.mcp.json</code> stay.
          </p>
          <button
            onClick={() => {
              setFilesNote(null);
              setFilesOpen(true);
            }}
            className="border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            Delete files…
          </button>
          {filesNote && <p className="mt-2 text-xs text-success">{filesNote}</p>}
        </div>
      </div>

      {softOpen && (
        <SoftDeleteProjectModal
          project={project}
          onCancel={() => setSoftOpen(false)}
          onDeleted={(id) => {
            setSoftOpen(false);
            onDeleted(id);
          }}
        />
      )}
      {filesOpen && (
        <DeleteProjectFilesModal
          project={project}
          onCancel={() => setFilesOpen(false)}
          onDone={(removed) => {
            setFilesOpen(false);
            setFilesNote(
              removed.length === 0
                ? 'Nothing to remove — PC scaffold dirs were already gone.'
                : `Removed: ${removed.join(', ')}`,
            );
          }}
        />
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
