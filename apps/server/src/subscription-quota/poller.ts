// Provider-neutral subscription-quota scheduler. Timing, timeout, overlap,
// runtime resolution, and durable submission are app concerns; credential and
// native response knowledge stays behind AgentRuntimeAdapter.

import {
  isSubscriptionQuotaObservationBatch,
  subscriptionQuotaKey,
  type SubscriptionQuotaObservationBatch,
} from '@pc/contracts';
import {
  OlderSubscriptionQuotaObservationError,
  type SubscriptionQuotaService,
} from '@pc/app-services';
import type { Account } from '../runner/account-env.ts';
import type { RuntimeRegistry } from '../runner/runtime.ts';

export const SUBSCRIPTION_QUOTA_POLL_INTERVAL_MS = 5 * 60_000;
export const SUBSCRIPTION_QUOTA_POLL_TIMEOUT_MS = 15_000;

interface SubscriptionQuotaPollerDeps {
  accounts: Account[];
  runtimes: RuntimeRegistry;
  service: SubscriptionQuotaService;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

type AdapterOutcome =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected' };

export class SubscriptionQuotaPoller {
  private readonly deps: SubscriptionQuotaPollerDeps;
  private readonly inFlight = new Map<string, Promise<AdapterOutcome>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly lastFailure = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(deps: SubscriptionQuotaPollerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    const intervalMs = positiveDuration(
      this.deps.intervalMs,
      SUBSCRIPTION_QUOTA_POLL_INTERVAL_MS,
    );
    this.timer = setInterval(() => void this.pollOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async pollOnce(): Promise<void> {
    const generation = this.generation;
    await Promise.all(this.deps.accounts.map((account) =>
      this.pollAccount(account, generation)));
  }

  private async pollAccount(account: Account, generation: number): Promise<void> {
    const key = subscriptionQuotaKey(account.runtimeId, account.id);
    // A timed-out adapter remains in-flight until it actually settles. Future
    // intervals skip it, so an implementation that ignores AbortSignal cannot
    // accumulate overlapping native requests.
    if (this.inFlight.has(key)) return;

    const resolution = this.deps.runtimes.resolve(account.runtimeId);
    if (resolution.status === 'invalid') {
      this.recordUnavailable(account, 'runtime-unavailable', generation);
      return;
    }

    const controller = new AbortController();
    this.controllers.set(key, controller);
    const operation = Promise.resolve().then(() =>
      resolution.adapter.observeSubscriptionQuota(account.id, {
        signal: controller.signal,
      }));
    const settled: Promise<AdapterOutcome> = operation.then(
      (value) => ({ status: 'fulfilled', value }),
      () => ({ status: 'rejected' }),
    );
    let tracked: Promise<AdapterOutcome>;
    tracked = settled.finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    });
    this.inFlight.set(key, tracked);

    const timeoutMs = positiveDuration(
      this.deps.timeoutMs,
      SUBSCRIPTION_QUOTA_POLL_TIMEOUT_MS,
    );
    const outcome = await raceWithTimeout(tracked, timeoutMs);
    if (generation !== this.generation) return;
    if (outcome === 'timeout') {
      controller.abort();
      this.recordUnavailable(account, 'observation-timeout', generation);
      return;
    }
    if (outcome.status === 'rejected') {
      this.recordUnavailable(account, 'runtime-unavailable', generation);
      return;
    }

    const value = outcome.value;
    if (
      !isSubscriptionQuotaObservationBatch(value) ||
      value.runtimeId !== account.runtimeId ||
      value.accountId !== account.id
    ) {
      this.recordUnavailable(account, 'invalid-observation', generation);
      return;
    }
    const receivedAt = observationTime(this.deps.now);
    if (value.observedAt > receivedAt) {
      this.recordUnavailable(account, 'invalid-observation', generation, receivedAt);
      return;
    }
    this.record(value, key, generation);
  }

  private recordUnavailable(
    account: Account,
    reason: Extract<SubscriptionQuotaObservationBatch, {
      availability: 'unavailable';
    }>['reason'],
    generation: number,
    observedAt = observationTime(this.deps.now),
  ): void {
    if (generation !== this.generation) return;
    this.record({
      runtimeId: account.runtimeId,
      accountId: account.id,
      availability: 'unavailable',
      reason,
      observedAt,
    }, subscriptionQuotaKey(account.runtimeId, account.id), generation);
  }

  private record(
    batch: SubscriptionQuotaObservationBatch,
    key: string,
    generation: number,
  ): void {
    if (generation !== this.generation) return;
    try {
      this.deps.service.record(batch);
      if (this.lastFailure.delete(key)) {
        console.log(`[pc-sdk][subscription-quota] observation recovered for ${key}`);
      }
    } catch (error) {
      if (error instanceof OlderSubscriptionQuotaObservationError) return;
      const code = error instanceof Error ? error.name : 'record-failed';
      if (this.lastFailure.get(key) === code) return;
      this.lastFailure.set(key, code);
      console.warn(`[pc-sdk][subscription-quota] record failed for ${key}: ${code}`);
    }
  }
}

function observationTime(now: (() => number) | undefined): number {
  const value = (now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('subscription quota poll clock is invalid');
  }
  return value;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function raceWithTimeout(
  operation: Promise<AdapterOutcome>,
  timeoutMs: number,
): Promise<AdapterOutcome | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, timeoutMs);
    void operation.then((outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}
