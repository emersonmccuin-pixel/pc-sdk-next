import type {
  RuntimeCapabilities,
  RuntimeModelDiscovery,
  RuntimeSelection,
  RuntimeSelectionValidation,
} from '@pc/contracts';
import type {
  MintRuntimeSession,
  RuntimeSession,
  RuntimeSessionFactory,
} from '../src/runner/runtime.ts';

export const TEST_RUNTIME_ID = 'claude-agent-sdk';
export const TEST_SELECTION: RuntimeSelection = {
  runtimeId: TEST_RUNTIME_ID,
  accountId: 'personal',
  model: 'opus',
  effort: { kind: 'none' },
};

export function testCapabilities(
  runtimeId = TEST_RUNTIME_ID,
  accountId = 'personal',
): RuntimeCapabilities {
  return {
    runtimeId,
    accountId,
    nativeContinuation: { status: 'supported' },
    modelDiscovery: { status: 'supported' },
    effortControl: { status: 'supported' },
  };
}

export function testModelDiscovery(): RuntimeModelDiscovery {
  return {
    status: 'available',
    models: ['opus', 'sonnet'].map((id) => ({
      id,
      resolvedId: null,
      label: id,
      description: '',
      effort: { status: 'supported' as const, values: ['low', 'medium', 'high'] },
    })),
  };
}

export function testSessionSelectionDeps() {
  return {
    resolveNewSessionSelection: async (
      input: { projectId: string; accountId?: string },
    ): Promise<RuntimeSelectionValidation> => ({
      status: 'valid',
      selection: {
        ...TEST_SELECTION,
        accountId: input.accountId ?? TEST_SELECTION.accountId,
      },
    }),
    preflightRuntimeSession: async (
      selection: RuntimeSelection,
    ): Promise<RuntimeSelectionValidation> => ({ status: 'valid', selection }),
  };
}

export function runtimeReceiptFor(ctx: MintRuntimeSession) {
  const nativeSessionId = ctx.continuation.mode === 'resume'
    ? ctx.continuation.nativeSessionId
    : `native-${ctx.appSessionId}`;
  return {
    type: 'session-started' as const,
    receipt: {
      mode: ctx.continuation.mode === 'resume' ? 'resumed' as const : 'created' as const,
      continuationAttemptId: ctx.continuationAttemptId,
      selection: ctx.selection,
      nativeSessionId,
      requestedNativeSessionId: ctx.continuation.mode === 'resume'
        ? ctx.continuation.nativeSessionId
        : null,
    },
  };
}

/** Wrap an injected test runtime with the positive native attachment receipt
 * production adapters must emit. The inner send is acquired first so a
 * synchronous delivery failure cannot be disguised as a successful attach. */
export function withRuntimeReceipt(
  factory: (ctx: MintRuntimeSession) => RuntimeSession | Promise<RuntimeSession>,
): RuntimeSessionFactory {
  return async (ctx) => {
    const inner = await factory(ctx);
    let receiptPending = true;
    return {
      sendTurn(text) {
        const stream = inner.sendTurn(text);
        return (async function* () {
          if (receiptPending) {
            receiptPending = false;
            yield runtimeReceiptFor(ctx);
          }
          yield* stream;
        })();
      },
      interrupt: () => inner.interrupt(),
      dispose: () => inner.dispose(),
    };
  };
}
