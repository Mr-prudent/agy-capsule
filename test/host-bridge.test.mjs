import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentApi, installAsyncHostRoutes, installEpipeGuard } from '../agy-capsule/sidecars/agy_capsule/host_bridge.mjs';

test('agentapi runs asynchronously so the event loop keeps ticking', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy bridge '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake_agentapi.mjs');
  // Stands in for the slow language-server call: echoes args after 300 ms.
  writeFileSync(fake, "setTimeout(() => process.stdout.write(JSON.stringify({ args: process.argv.slice(2) })), 300);");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  t.after(() => clearInterval(timer));
  const env = { ...process.env, ANTIGRAVITY_AGENTAPI_EXE: 'ls.exe' };
  // Real child process; only the binary is swapped for `node <fake>`.
  const execFileImpl = (file, args, opts, cb) => execFile(process.execPath, [fake, ...args.slice(1)], opts, cb);
  const result = await runAgentApi(['get-conversation-metadata', 'abc'], { env, execFileImpl });
  assert.deepEqual(result.args, ['get-conversation-metadata', 'abc']);
  assert.ok(ticks >= 5, `timers must fire while agentapi runs (got ${ticks})`);
});

test('agentapi arguments, env and errors mirror sidecar_sdk', async () => {
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, ''); };
  const env = { ANTIGRAVITY_AGENTAPI_EXE: 'C:/ls.exe' };
  assert.deepEqual(await runAgentApi(['x'], { env, projectId: 'p1', execFileImpl }), {});
  assert.equal(calls[0].file, 'C:/ls.exe');
  assert.deepEqual(calls[0].args, ['agentapi', 'x']);
  assert.equal(calls[0].opts.env.ANTIGRAVITY_PROJECT_ID, 'p1');

  await runAgentApi(['y'], { env: {}, execFileImpl });
  assert.equal(calls[1].file, 'agentapi');
  assert.deepEqual(calls[1].args, ['y']);

  const failing = (f, a, o, cb) => cb(Object.assign(new Error('boom'), { code: 'EPIPE' }));
  await assert.rejects(runAgentApi(['z'], { env: {}, execFileImpl: failing }), /boom/);
});

test('host routes replace the SDK handlers with async commands', async () => {
  const routes = new Map();
  const app = { api: (path, handler) => routes.set(path, handler) };
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => { calls.push(args); cb(null, '{"ok":true}'); };
  installAsyncHostRoutes(app, { env: {}, execFileImpl });
  assert.deepEqual(await routes.get('/_sidecar/get-conversation-metadata')({ conversationId: 'c1' }), { ok: true });
  await routes.get('/_sidecar/send-message')({ conversationId: 'c1', message: 'hi', title: 'T' });
  await routes.get('/_sidecar/new-conversation')({ message: 'go' });
  assert.deepEqual(calls, [
    ['get-conversation-metadata', 'c1'],
    ['send-message', '--title', 'T', 'c1', 'hi'],
    ['new-conversation', '--model', 'flash', 'go'],
  ]);
});

test('EPIPE is ignored, other fatal errors still exit 1', () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const exits = [];
  proc.exit = code => exits.push(code);
  installEpipeGuard(proc);
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  proc.stdout.emit('error', epipe);
  proc.stderr.emit('error', epipe);
  proc.emit('uncaughtException', epipe);
  proc.emit('unhandledRejection', epipe);
  assert.deepEqual(exits, []);
  assert.throws(() => proc.stdout.emit('error', new Error('other')), /other/);
  const origError = console.error;
  console.error = () => {};
  try {
    proc.emit('uncaughtException', new Error('real'));
    proc.emit('unhandledRejection', new Error('real'));
  } finally { console.error = origError; }
  assert.deepEqual(exits, [1, 1]);
});
