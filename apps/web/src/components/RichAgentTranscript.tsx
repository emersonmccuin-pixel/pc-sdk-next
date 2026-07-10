// Ordered transcript list — TranscriptRow per item, with the "the FIRST user
// turn is the agent's contract" callout the old rich renderer used. No shared
// chat pipeline dependency (see TranscriptRow's note); this is deliberately
// self-contained.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import type { AgentTranscriptItem } from '@/features/agent-runs/transcript';
import { Row, TranscriptRow } from './TranscriptRow';

export function RichAgentTranscript({
  items,
  emptyState,
}: {
  items: AgentTranscriptItem[];
  emptyState?: ReactNode;
}) {
  const contractKey = useMemo(() => {
    for (const item of items) {
      if (item.event.kind === 'user') return item.key;
    }
    return null;
  }, [items]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 text-center text-xs text-muted-foreground">
        {emptyState ?? 'No transcript events yet.'}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <ul className="flex flex-col gap-2">
        {items.map((item) =>
          item.key === contractKey ? (
            <li key={item.key} className="border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Agent contract · the task this agent was given
              </div>
              <ul>
                <TranscriptRow event={item.event} />
              </ul>
            </li>
          ) : (
            <TranscriptRow key={item.key} event={item.event} />
          ),
        )}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}

// Re-exported so callers that only need the bare row (e.g. an inline dispatch
// card, if one lands later) don't have to reach into TranscriptRow.tsx.
export { Row };
