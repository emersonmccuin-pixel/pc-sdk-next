// First-run gate. Trimmed vs. PC-PTY-Chat: the full installer flow (Claude/git
// install, git identity, browser login) drove server endpoints (/api/onboarding/
// install, /api/preflight, auth) that are the server sibling's domain. Auth here
// is the Max-subscription login in the selected config dir (AGENTS.md), assumed
// present. This compact wizard covers welcome → projects folder → done and
// persists onboardingCompletedAt. Expand from the reference once the server
// exposes the preflight/install/auth routes.

import { useState } from 'react';

type StepId = 'welcome' | 'projects' | 'done';
const STEP_ORDER: StepId[] = ['welcome', 'projects', 'done'];

interface OnboardingWizardProps {
  initialProjectsFolder: string;
  onProjectsFolderChange: (path: string) => void;
  onComplete: () => void;
}

export function OnboardingWizard({
  initialProjectsFolder,
  onProjectsFolderChange,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<StepId>('welcome');
  const [folder, setFolder] = useState(initialProjectsFolder);

  const idx = STEP_ORDER.indexOf(step);
  const folderOk = folder.trim().length > 0;

  function next() {
    if (step === 'welcome') setStep('projects');
    else if (step === 'projects') {
      onProjectsFolderChange(folder.trim());
      setStep('done');
    }
  }

  return (
    <div className="grid h-full place-items-center bg-background text-foreground">
      <div className="flex w-[560px] flex-col gap-6 border border-border bg-card p-8">
        <div className="flex items-center gap-1.5">
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              className={`h-1 flex-1 ${i <= idx ? 'bg-primary' : 'bg-muted'}`}
              aria-hidden
            />
          ))}
        </div>

        {step === 'welcome' && (
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold uppercase tracking-wider text-primary">Welcome to PC-SDK</h1>
            <p className="text-sm leading-relaxed text-foreground/90">
              A chat-driven workspace over your projects: an orchestrator conversation, agents, and MCP
              tools — all running on your Claude subscription login. Two quick steps and you're in.
            </p>
          </div>
        )}

        {step === 'projects' && (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold text-foreground">Where do your projects live?</h1>
            <p className="text-sm text-muted-foreground">
              New projects are created inside this folder by default. You can change it later in App Settings.
            </p>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="C:\\Users\\me\\Projects"
              className="w-full border border-border bg-background px-2 py-1.5 font-mono text-xs"
              autoFocus
            />
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold uppercase tracking-wider text-primary">You're set</h1>
            <p className="text-sm leading-relaxed text-foreground/90">
              Create your first project to start a conversation. PC-SDK turns a folder on disk into a
              workspace scoped to one project at a time.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {step !== 'done' ? (
            <button
              onClick={next}
              disabled={step === 'projects' && !folderOk}
              className="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={onComplete}
              className="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Create your first project
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
