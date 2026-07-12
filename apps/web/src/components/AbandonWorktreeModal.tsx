import { useCallback, useEffect, useState } from 'react';

import {
  WORKTREE_ABANDONMENT_REASON_MAX_CHARS,
  type ApproveWorktreeAbandonmentResponse,
  type Contract,
  type ULID,
  type WorktreeAbandonmentPreviewDto,
} from '@pc/contracts';
import { contractsApi } from '@/features/contracts/client';

interface AbandonWorktreeModalProps {
  projectId: ULID;
  contractId: ULID;
  onClose: () => void;
  onSettled?: (contract: Contract) => void;
}

export function abandonmentConfirmationMatches(
  preview: WorktreeAbandonmentPreviewDto | null,
  confirmation: string,
): boolean {
  return preview?.worktreeState.directory === 'present' && confirmation === preview.branch;
}

export function AbandonWorktreeModal({
  projectId,
  contractId,
  onClose,
  onSettled,
}: AbandonWorktreeModalProps) {
  const [preview, setPreview] = useState<WorktreeAbandonmentPreviewDto | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<ApproveWorktreeAbandonmentResponse | null>(null);

  const loadPreview = useCallback(async (afterStaleRefusal = false) => {
    setLoading(true);
    if (!afterStaleRefusal) setError(null);
    try {
      const next = await contractsApi.getAbandonmentPreview(projectId, contractId);
      setPreview(next);
      if (afterStaleRefusal) {
        setError('The worktree changed before approval. Review the refreshed preview and confirm again.');
      }
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [contractId, projectId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const reasonTooLong = reason.length > WORKTREE_ABANDONMENT_REASON_MAX_CHARS;
  const matches = abandonmentConfirmationMatches(preview, confirmation);

  async function approve() {
    if (!preview || !matches || reasonTooLong || busy || settled) return;
    setBusy(true);
    setError(null);
    try {
      const response = await contractsApi.approveAbandonment(projectId, contractId, {
        requestId,
        expectedContractVersion: preview.contractVersion,
        previewDigest: preview.previewDigest,
        confirmation,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setSettled(response);
      onSettled?.(response.contract);
    } catch {
      // Any refused approval invalidates the displayed evidence. Keep the same
      // request id for safe retry, but require a new exact typed confirmation.
      setConfirmation('');
      await loadPreview(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/55 px-3"
      role="dialog"
      aria-modal="true"
      aria-label="Abandon worktree"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col border border-destructive/40 bg-card text-foreground shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-destructive">Abandon worktree</h2>
            <div className="font-mono text-[10px] text-muted-foreground">contract {contractId}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Close abandonment confirmation"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
          {loading && !preview && (
            <div className="text-sm text-muted-foreground">Inspecting the current branch and worktree…</div>
          )}

          {preview && <AbandonmentPreviewDetails preview={preview} />}

          {error && (
            <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && !preview && !settled && (
            <button
              type="button"
              onClick={() => void loadPreview()}
              className="self-start border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Retry preview
            </button>
          )}

          {preview && !settled && (
            <>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  Type the exact branch <code className="bg-muted px-1 font-mono">{preview.branch}</code> to approve.
                </span>
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy || preview.worktreeState.directory !== 'present'}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Reason (optional)</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                  rows={2}
                  maxLength={WORKTREE_ABANDONMENT_REASON_MAX_CHARS + 1}
                  className="resize-y border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                />
                <span className={reasonTooLong ? 'text-destructive' : 'text-muted-foreground/70'}>
                  {reason.length}/{WORKTREE_ABANDONMENT_REASON_MAX_CHARS}
                </span>
              </label>
            </>
          )}

          {settled && <AbandonmentSettlementNotice response={settled} />}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {settled ? 'Close' : 'Cancel'}
          </button>
          {!settled && (
            <button
              type="button"
              onClick={() => void approve()}
              disabled={!matches || reasonTooLong || loading || busy}
              className="bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {busy ? 'Recording approval…' : 'Abandon worktree'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export function AbandonmentPreviewDetails({
  preview,
}: {
  preview: WorktreeAbandonmentPreviewDto;
}) {
  const state = preview.worktreeState;
  const branchTip = preview.branchTip.slice(0, 12);
  return (
    <div className="space-y-3 text-sm">
      <div className="border border-warning/40 bg-warning/10 px-3 py-2 text-foreground/90">
        <strong>This does not merge the branch.</strong> The branch{' '}
        <code className="font-mono">{preview.branch}</code> remains at{' '}
        <code className="font-mono">{branchTip}</code>, while the recorded worktree is removed.
      </div>

      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-xs">
        <dt className="text-muted-foreground">worktree</dt>
        <dd className="break-all" title={preview.worktreePath}>{preview.worktreePath}</dd>
        <dt className="text-muted-foreground">branch</dt>
        <dd className="break-all">{preview.branch}</dd>
        <dt className="text-muted-foreground">tip</dt>
        <dd className="break-all">{preview.branchTip}</dd>
        <dt className="text-muted-foreground">base</dt>
        <dd className="break-all">{preview.baseBranch} @ {preview.validatedBaseSha.slice(0, 12)}</dd>
        <dt className="text-muted-foreground">state digest</dt>
        <dd className="break-all" title={state.worktreeStateDigest}>{state.worktreeStateDigest}</dd>
      </dl>

      <div className="space-y-1 text-xs text-foreground/90">
        {preview.integrationState === 'unmerged' ? (
          <p>The branch has commits not integrated into the validated base. Those commits remain recoverable on the branch.</p>
        ) : (
          <p>No branch-exclusive commit was observed relative to the validated base. The branch is still retained.</p>
        )}

        {state.directory === 'present' ? (
          <>
            <p className={state.status === 'dirty' ? 'text-destructive' : ''}>
              Worktree contents: {state.status}. Observed changes: {state.staged} staged,{' '}
              {state.unstaged} unstaged, {state.untracked} untracked. Any such content is permanently removed from the worktree.
            </p>
            {state.changedPaths.length > 0 && (
              <details className="border border-border/60 px-2 py-1">
                <summary className="cursor-pointer text-muted-foreground">Observed changed paths (bounded)</summary>
                <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5 font-mono text-[11px]">
                  {state.changedPaths.map((path) => <li key={path} className="break-all">{path}</li>)}
                </ul>
              </details>
            )}
          </>
        ) : (
          <p className="text-destructive">
            The recorded worktree directory is missing, so its contents cannot be inspected or approved for automatic removal here.
          </p>
        )}

        <p className="text-destructive">
          Ignored contents are deliberately uninspected. Any ignored files inside the worktree are also removed.
        </p>
      </div>
    </div>
  );
}

export function AbandonmentSettlementNotice({
  response,
}: {
  response: ApproveWorktreeAbandonmentResponse;
}) {
  const receipt = response.contract.abandonmentReceipt;
  const branch = receipt?.branch ?? '(recorded branch)';
  const tip = receipt?.branchTip.slice(0, 12) ?? 'unknown';
  const integrationCopy = receipt?.integrationState === 'no-exclusive-commits'
    ? 'no branch-exclusive commit existed to merge.'
    : 'its branch-only commits were not merged.';
  return response.settlement === 'completed' ? (
    <div className="border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
      Worktree abandonment settled. Branch <code className="font-mono">{branch}</code> remains at{' '}
      <code className="font-mono">{tip}</code>; {integrationCopy}
    </div>
  ) : (
    <div className="border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      User approval is recorded. Worktree cleanup is pending and can be re-driven after restart; the branch remains preserved.
    </div>
  );
}
