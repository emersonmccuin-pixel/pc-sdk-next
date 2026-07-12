import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ULID } from '@pc/domain';

import { ProjectWebSocketHub } from '../src/ws/hub.ts';
import {
  attachSocket,
  type RouterDeps,
  type RouterSocket,
} from '../src/ws/router.ts';

test('subscribe cursors are guarded and replay failures stay inside the socket attempt', () => {
  const handlers = new Map<string, (value?: unknown) => void>();
  const socket: RouterSocket = {
    OPEN: 1,
    readyState: 1,
    send: () => {},
    on: (event, callback) => { handlers.set(event, callback as (value?: unknown) => void); },
  };
  let replays = 0;
  const deps: RouterDeps = {
    hub: new ProjectWebSocketHub<ULID>(),
    registry: {
      get: () => ({ connectSnapshot: () => [] }),
    } as unknown as RouterDeps['registry'],
    relay: {
      catchUp: () => {
        replays += 1;
        throw new Error('forced replay failure');
      },
    } as unknown as RouterDeps['relay'],
  };

  attachSocket(socket, 'project-router-test' as ULID, deps);
  const onMessage = handlers.get('message');
  assert.ok(onMessage);
  assert.doesNotThrow(() => onMessage(JSON.stringify({
    type: 'subscribe', lastVersion: '7',
  })));
  assert.equal(replays, 1);
  assert.doesNotThrow(() => onMessage(JSON.stringify({
    type: 'subscribe', lastVersion: '07',
  })));
  assert.equal(replays, 1, 'non-canonical cursors never reach the replay repository');
});
