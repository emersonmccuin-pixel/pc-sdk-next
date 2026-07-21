// Host self-preservation guard — real incident (2026-07-20): asked to
// "restart the server", the orchestrator ran a shell command that killed its
// OWN host process (the PC-SDK server) mid-turn. These pin the guard's
// deny/allow boundary: it fires only on this exact process's pid/port (or the
// launcher/watchdog tasks), and stays out of the way of everything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShellCommandSafety, type HostGuardContext } from '../src/chat/tool-safety.ts';

const HOST: HostGuardContext = { pid: 41234, port: 5124 };

function bash(command: string) {
  return evaluateShellCommandSafety('Bash', { command }, HOST);
}

test('denies taskkill against the server\'s own pid', () => {
  const verdict = bash('taskkill /PID 41234 /F');
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /pid 41234/);
});

test('denies PowerShell Stop-Process against the server\'s own pid', () => {
  const verdict = bash('powershell -Command "Stop-Process -Id 41234 -Force"');
  assert.equal(verdict.allowed, false);
});

test('denies plain kill against the server\'s own pid', () => {
  const verdict = bash('kill -9 41234');
  assert.equal(verdict.allowed, false);
});

test('denies a taskkill that targets the server\'s own port', () => {
  const verdict = bash(
    'for /f "tokens=5" %a in (\'netstat -ano ^| findstr :5124\') do taskkill /PID %a /F',
  );
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /port 5124/);
});

test('denies schtasks manipulation of the launcher task', () => {
  const verdict = bash('schtasks /Change /TN "PC-SDK-Next-Launch" /Disable');
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /PC-SDK-Next-Launch/);
});

test('denies net stop against the watchdog task', () => {
  const verdict = bash('net stop "PC-SDK-Next-Watchdog"');
  assert.equal(verdict.allowed, false);
});

test('allows taskkill against an unrelated pid', () => {
  const verdict = bash('taskkill /PID 99999 /F');
  assert.deepEqual(verdict, { allowed: true });
});

test('allows an agent killing its own spawned test process by a different pid', () => {
  const verdict = bash('kill 55555');
  assert.deepEqual(verdict, { allowed: true });
});

test('allows a command that merely mentions the port number without a kill verb', () => {
  const verdict = bash('curl http://localhost:5124/health');
  assert.deepEqual(verdict, { allowed: true });
});

test('allows a command that merely mentions the pid number without a kill verb', () => {
  const verdict = bash('echo "server pid is 41234"');
  assert.deepEqual(verdict, { allowed: true });
});

test('allows plain unrelated commands', () => {
  assert.deepEqual(bash('git status'), { allowed: true });
  assert.deepEqual(bash('pnpm test'), { allowed: true });
  assert.deepEqual(bash('ls -la'), { allowed: true });
});

test('skips the port check when the port is unknown (0)', () => {
  const verdict = evaluateShellCommandSafety('Bash', { command: 'taskkill /PID 1 /F' }, { pid: 999, port: 0 });
  assert.deepEqual(verdict, { allowed: true });
});

test('non-Bash tools are never inspected', () => {
  const verdict = evaluateShellCommandSafety('Edit', { command: 'taskkill /PID 41234 /F' }, HOST);
  assert.deepEqual(verdict, { allowed: true });
});

test('a command with no command field is allowed', () => {
  assert.deepEqual(evaluateShellCommandSafety('Bash', {}, HOST), { allowed: true });
  assert.deepEqual(evaluateShellCommandSafety('Bash', undefined, HOST), { allowed: true });
});
