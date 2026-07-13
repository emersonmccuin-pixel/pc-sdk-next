import { useCallback, useEffect, useState } from 'react';

import {
  isReviewCheckoutDto,
  type ReviewCheckoutDto,
  type ULID,
} from '@pc/contracts';
import { getJson } from '@/api/http';
import { useConnectionStore } from '@/state/connection';

export type ReviewCheckoutReadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ReviewCheckoutRead {
  reviewCheckouts: ReviewCheckoutDto[];
  status: ReviewCheckoutReadStatus;
  error: string | null;
  retry: () => void;
}

interface ReviewCheckoutReadState {
  projectId: ULID | null;
  reviewCheckouts: ReviewCheckoutDto[];
  status: ReviewCheckoutReadStatus;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseReviewCheckoutListResponse(value: unknown): ReviewCheckoutDto[] {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'ok' && key !== 'reviewCheckouts') ||
    value.ok !== true ||
    !Array.isArray(value.reviewCheckouts) ||
    !value.reviewCheckouts.every(isReviewCheckoutDto)
  ) {
    throw new Error('invalid review checkout response');
  }
  return value.reviewCheckouts;
}

const reviewCheckoutsApi = {
  list: (projectId: ULID) =>
    getJson<unknown>(`/api/projects/${projectId}/review-checkouts`)
      .then(parseReviewCheckoutListResponse),
};

/** Review workspaces have no browser hot-resource stream. Retain the last
 * positive read while periodically refreshing, and keep read failure separate
 * so stale evidence can never masquerade as an empty successful projection. */
export function useReviewCheckouts(
  projectId: ULID | null,
  enabled: boolean,
): ReviewCheckoutRead {
  const [state, setState] = useState<ReviewCheckoutReadState>({
    projectId: null,
    reviewCheckouts: [],
    status: 'idle',
    error: null,
  });
  const [retryNonce, setRetryNonce] = useState(0);
  const connectionEpoch = useConnectionStore((current) => current.epoch);
  const retry = useCallback(() => setRetryNonce((value) => value + 1), []);

  useEffect(() => {
    if (!projectId || !enabled) {
      setState({ projectId: null, reviewCheckouts: [], status: 'idle', error: null });
      return;
    }
    let cancelled = false;
    const load = () => {
      setState((current) => ({
        projectId,
        reviewCheckouts: current.projectId === projectId ? current.reviewCheckouts : [],
        status: 'loading',
        error: null,
      }));
      void reviewCheckoutsApi.list(projectId).then(
        (reviewCheckouts) => {
          if (!cancelled) {
            setState({ projectId, reviewCheckouts, status: 'ready', error: null });
          }
        },
        (error: unknown) => {
          if (cancelled) return;
          setState((current) => ({
            projectId,
            reviewCheckouts: current.projectId === projectId ? current.reviewCheckouts : [],
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        },
      );
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectId, enabled, connectionEpoch, retryNonce]);

  return {
    reviewCheckouts: state.projectId === projectId ? state.reviewCheckouts : [],
    status: state.projectId === projectId ? state.status : enabled ? 'loading' : 'idle',
    error: state.projectId === projectId ? state.error : null,
    retry,
  };
}
