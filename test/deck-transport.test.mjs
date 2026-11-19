import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDeckInjector, buildRuntimeBundle } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';

test('CDP installs code once, skips unchanged payloads, updates on navigation, and releases closed pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cdp-'));
  const file = join(dir, 'port'); writeFileSync(file, '12345\n');
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, now: Date.now };
  const owner = Date.now(), hash = buildRuntimeBundle(owner).hash;
  let now = owner, installed = false, path = '/', pageExists = true, hasFooter = true, inspections = 0, injections = 0, pushes = 0, lists = 0, next = { contextTokens: 100 };
  const connections = [];
  class FakeSocket {
    constructor() { this.readyState = 0; connections.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, params: { expression } } = JSON.parse(raw);
      let value;
      if (expression.includes('function installRuntime')) { injections++; installed = true; value = true; }
      else if (expression.includes('.readState(')) value = installed ? { owner, hash, path, hasFooter } : null;
      else if (expression.includes('.apply(')) { pushes++; value = true; }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result: { result: { value } } }) }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  }
  globalThis.WebSocket = FakeSocket;
  Date.now = () => now;
  globalThis.fetch = async () => { lists++; return { ok: true, json: async () => pageExists ? [{ id: 'page', type: 'page', url: 'https://127.0.0.1:5351/', webSocketDebuggerUrl: 'ws://test' }] : [] }; };
  let injector;
  try {
    injector = startDeckInjector(async () => { inspections++; return next; }, { portFile: file, instanceTs: owner });
    await injector.tick(); assert.equal(injections, 1); assert.equal(pushes, 1);
    await injector.tick(); assert.equal(injections, 1); assert.equal(pushes, 1); assert.equal(lists, 1);
    const count = inspections; hasFooter = false; await injector.tick(); assert.equal(inspections, count, 'Non-composer windows must not change the selected conversation'); hasFooter = true;
    next = { contextTokens: 200 }; await injector.tick(); assert.equal(pushes, 2);
    path = '/c/00000000-0000-0000-0000-000000000000'; await injector.tick(); assert.equal(pushes, 3);
    now += 5000; pageExists = false; await injector.tick(); assert.equal(connections[0].readyState, 3);
    pageExists = true; installed = false; now += 5000; await injector.tick(); assert.equal(injections, 2);
    // Closing a socket must flush its pending evaluation instead of waiting 3s.
    connections.at(-1).send = function () { this.close(); };
    let timeout;
    try { await Promise.race([injector.tick(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Pending evaluation was not released')), 300); })]); }
    finally { clearTimeout(timeout); }
  } finally {
    await injector?.stop();
    globalThis.fetch = originals.fetch; globalThis.WebSocket = originals.WebSocket; Date.now = originals.now;
    rmSync(dir, { recursive: true, force: true });
  }
});
