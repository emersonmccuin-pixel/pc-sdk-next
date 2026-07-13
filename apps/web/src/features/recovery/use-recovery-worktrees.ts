import { useCallback, useEffect, useState } from 'react';

import type { ULID } from '@pc/contracts';
import { worktreesApi, type StrandedWorktreeDto } from '@/features/worktrees/client';

export type RecoveryWorktreeReadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RecoveryWorktreeRead {
  worktrees: StrandedWorktreeDto[];
  status: RecoveryWorktreeReadStatus;
  error: string | null;
  retry: () => void;
}

interface WorktreeReadState {
  projectId: ULID | null;
  worktrees: StrandedWorktreeDto[];
  status: RecoveryWorktreeReadStatus;
  error: string | null;
}

/** Stranding is a boot-scan durable rather than a hot resource entity. Keep
 * the last positive snapshot while a refresh is pending or failed, and expose
 * that failure separately so stale evidence never becomes empty success. */
export function useRecoveryWorktrees(
  projectId: ULID | null,
  enabled: boolean,
): RecoveryWorktreeRead {
  const [state, setState] = useState<WorktreeReadState>({
    projectId: null,
    worktrees: [],
    status: 'idle',
    error: null,
  });
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((value) => value + 1), []);

  useEffect(() => {
    if (!projectId || !enabled) {
      setState({ projectId: null, worktrees: [], status: 'idle', error: null });
      return;
    }

    let cancelled = false;
    const load = () => {
      setState((current) => ({
        projectId,
        worktrees: current.projectId === projectId ? current.worktrees : [],
        status: 'loading',
        error: null,
      }));
      void worktreesApi
        .listStranded(projectId)
        .then((worktrees) => {
          if (!cancelled) {
            setState({ projectId, worktrees, status: 'ready', error: null });
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState((current) => ({
            projectId,
            worktrees: current.projectId === projectId ? current.worktrees : [],
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    };

    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectId, enabled, retryNonce]);

  return {
    worktrees: state.projectId === projectId ? state.worktrees : [],
    status: state.projectId === projectId ? state.status : enabled ? 'loading' : 'idle',
    error: state.projectId === projectId ? state.error : null,
    retry,
  };
}
