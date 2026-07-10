// Orchestrator chat surface. This mount owns the project socket (heartbeat /
// backoff / epoch / cursor) and the chrome (session switcher header + footer
// StatusBar); the message timeline + composer live in ChatSurface, driven by the
// chat store the socket feeds.

import { useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { ConversationHeader, ConversationHeaderButton } from '@/components/ConversationHeader';
import { StatusBar } from '@/components/StatusBar';
import { SessionSwitcher } from '@/components/SessionSwitcher';
import { useProjectConnection } from '@/state/connection';
import { useProjectSocket } from '@/lib/ws-client';
import { useSessionNav } from '@/state/sessions';
import { ChatSurface } from '@/features/chat/ChatSurface';

export function ChatMount({ project }: { project: Project }) {
  const api = useProjectSocket(project.id);
  const { status, orchestratorHealth } = useProjectConnection();
  const activeSessionId = useSessionNav((s) => s.activeByProject[project.id] ?? null);
  const applyTransition = useSessionNav((s) => s.applyTransition);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const titleRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="flex h-full flex-col bg-background">
      <ConversationHeader
        title={
          <button
            ref={titleRef}
            type="button"
            onClick={() => setSwitcherOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 truncate text-left hover:text-primary"
            title="Switch session"
          >
            <span className="truncate font-medium">{project.name}</span>
            <span className="text-[10px] text-[var(--fg-dim)]">▾</span>
          </button>
        }
        titleText={project.name}
        actions={
          <ConversationHeaderButton onClick={() => setSwitcherOpen((v) => !v)} title="Sessions">
            sessions
          </ConversationHeaderButton>
        }
      />
      {switcherOpen && (
        <SessionSwitcher
          projectId={project.id}
          projectSlug={project.slug}
          activeSessionId={activeSessionId}
          anchorEl={titleRef.current}
          onClose={() => setSwitcherOpen(false)}
          applySessionTransition={(t) => applyTransition(project.id, t)}
        />
      )}
      <ChatSurface project={project} api={api} />
      <StatusBar projectName={project.name} wsStatus={status} orchestratorHealth={orchestratorHealth} />
    </div>
  );
}
