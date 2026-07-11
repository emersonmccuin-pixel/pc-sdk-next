// Usage poller — the ACTIVE per-account quota supply. The passive supply
// (SDK `rate_limit_event`s) only fires mid-turn, so after a boot the meter sat
// blank until the user chatted. This polls the same OAuth usage endpoint the
// Claude Code `/usage` screen reads, per registered account, on boot + an
// interval, and feeds `UsageCache.record()` (merge/persist/broadcast for free).
//
// The endpoint is UNOFFICIAL — degrade, never block: any failure (token
// missing/expired, endpoint changed, network down) logs once per distinct
// cause and leaves the passive supply as the fallback. Tokens are read from
// each account's `<configDir>/.credentials.json`; we never refresh them —
// Claude Code owns the refresh, and any SDK turn on that account renews it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageSnapshot } from '@pc/contracts';
import type { Account } from '../runner/account-env.ts';
import type { UsageCache } from './cache.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;

interface OauthWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface OauthLimit {
  kind?: unknown;
  group?: unknown;
  severity?: unknown;
  is_active?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { id?: unknown; display_name?: unknown } | null; surface?: unknown } | null;
}

/** The slice of the OAuth usage response we consume (verified 2026-07-10). */
export interface OauthUsageResponse {
  five_hour?: OauthWindow | null;
  seven_day?: OauthWindow | null;
  limits?: OauthLimit[];
}

/** Map one OAuth usage response to the contract snapshot. Endpoint scale is
 *  0–100; the contract (and the web caps panel) use 0–1. */
export function mapOauthUsage(
  body: OauthUsageResponse,
  accountId: string,
  now = Date.now(),
): UsageSnapshot {
  const mapWindow = (w: OauthWindow | null | undefined) => {
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
    const resetsAtMs = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return {
      utilization: Math.max(0, w.utilization) / 100,
      resetsAt: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
    };
  };
  const fiveHour = mapWindow(body.five_hour);
  const sevenDay = mapWindow(body.seven_day);

  const limits = body.limits ?? [];
  const fableLimit = limits.find(
    (l) => String(l.scope?.model?.display_name ?? '').toLowerCase() === 'fable',
  );
  const fable = fableLimit
    ? mapWindow({ utilization: fableLimit.percent, resets_at: fableLimit.resets_at })
    : null;

  const severities = limits.map((l) => String(l.severity ?? ''));
  const maxUtil = Math.max(fiveHour?.utilization ?? 0, sevenDay?.utilization ?? 0);
  const status: UsageSnapshot['status'] =
    maxUtil >= 1 || severities.some((s) => /reject|exceed|critical|block/i.test(s))
      ? 'rejected'
      : severities.some((s) => /warn|elevat/i.test(s))
        ? 'allowed_warning'
        : 'allowed';

  return { accountId, fiveHour, sevenDay, fable, status, model: null, updatedAt: now };
}

interface PollerDeps {
  accounts: Account[];
  cache: UsageCache;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  readCredentials?: (configDir: string) => Promise<string>;
}

export class UsagePoller {
  private readonly deps: PollerDeps;
  private timer: NodeJS.Timeout | null = null;
  /** Last failure message per account — log only on change, never spam. */
  private readonly lastFailure = new Map<string, string>();

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.deps.intervalMs ?? USAGE_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    await Promise.all(this.deps.accounts.map((a) => this.pollAccount(a)));
  }

  private async pollAccount(account: Account): Promise<void> {
    try {
      const token = await this.readToken(account.configDir);
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      const res = await fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) throw new Error(`usage endpoint HTTP ${res.status}`);
      const body = (await res.json()) as OauthUsageResponse;
      const snapshot = mapOauthUsage(body, account.id);

      // Unchanged windows → skip the record (no outbox churn every 5 minutes).
      const prev = this.deps.cache.get(account.id);
      if (prev && sameQuotaState(prev, snapshot)) return;

      this.deps.cache.record(snapshot);
      if (this.lastFailure.delete(account.id)) {
        console.log(`[pc-sdk][usage] poll recovered for account '${account.id}'`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.lastFailure.get(account.id) !== message) {
        this.lastFailure.set(account.id, message);
        console.warn(`[pc-sdk][usage] poll failed for account '${account.id}': ${message}`);
      }
    }
  }

  private async readToken(configDir: string): Promise<string> {
    const read =
      this.deps.readCredentials ??
      (async (dir: string) => readFile(join(dir, '.credentials.json'), 'utf8'));
    const raw = await read(configDir);
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) throw new Error('no OAuth token in credentials file');
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) {
      throw new Error('OAuth token expired (run a turn on this account to refresh)');
    }
    return oauth.accessToken;
  }
}

function sameQuotaState(a: UsageSnapshot, b: UsageSnapshot): boolean {
  return (
    a.status === b.status &&
    sameWindow(a.fiveHour, b.fiveHour) &&
    sameWindow(a.sevenDay, b.sevenDay) &&
    sameWindow(a.fable, b.fable)
  );
}

function sameWindow(
  a: { utilization: number; resetsAt: number | null } | null,
  b: { utilization: number; resetsAt: number | null } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.utilization === b.utilization && a.resetsAt === b.resetsAt;
}
