// Usage dashboard (master-plan "usage dashboard", N6 gate: "provider-aware
// usage views"). Lives inside AppSettingsModal as its own tab — same home as
// MCP servers — and lists EVERY registered runtime+account, not just the
// actively selected one. Claude renders its quota windows as today; a runtime
// that doesn't support quota (Codex) renders its typed reason honestly —
// never fake numbers, never hidden from the list.

import { useEffect, useMemo } from 'react';

import { SubscriptionQuotaPanel } from '@/components/SubscriptionQuotaPanel';
import { useRuntimes } from '@/state/runtimes';
import { useAllSubscriptionQuotaSnapshots } from '@/state/subscription-quota-store';
import { buildUsageDashboardRows, capabilityUnavailableCode, usageDashboardRowKey } from './view';
import type { UsageRuntimeAccountRef } from './types';

export function UsageDashboardPanel() {
  const runtimes = useRuntimes((s) => s.runtimes);
  const loadRuntimeRegistry = useRuntimes((s) => s.loadRegistry);
  const snapshots = useAllSubscriptionQuotaSnapshots();

  useEffect(() => {
    void loadRuntimeRegistry();
  }, [loadRuntimeRegistry]);

  const refs: UsageRuntimeAccountRef[] = useMemo(
    () =>
      runtimes.flatMap((runtime) =>
        runtime.accounts.map((account) => ({
          runtimeId: runtime.id,
          runtimeLabel: runtime.label,
          accountId: account.id,
          subscriptionQuota: account.capabilities?.subscriptionQuota ?? null,
        }))),
    [runtimes],
  );

  const rows = useMemo(() => buildUsageDashboardRows(refs, snapshots), [refs, snapshots]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Every registered runtime + account, with subscription quota as that runtime actually
        reports it. Percentages are always used/consumed, never invented — a runtime that
        doesn&apos;t report quota shows its own typed reason instead of a fake number.
      </p>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No runtimes registered yet.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const unsupportedCode = capabilityUnavailableCode(row);
            return (
              <div key={usageDashboardRowKey(row)} className="border border-border">
                <SubscriptionQuotaPanel
                  snapshot={row.snapshot}
                  runtimeId={row.runtimeId}
                  accountId={row.accountId}
                  title={`${row.runtimeLabel} · ${row.accountId}`}
                />
                {unsupportedCode && !row.snapshot && (
                  <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                    Runtime capability: quota {unsupportedCode}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
