import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startSelfReloadWatcher } from '../agy-capsule/sidecars/agy_capsule/reload.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agy reload '));
  const directory = join(root, 'sidecars', 'agy_capsule');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), '{}');
  writeFileSync(join(directory, 'server.mjs'), '// initial');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory };
}

test('reload waits for an entire install batch and fires once after files settle', async t => {
  const { root, directory } = fixture(t);
  let reloads = 0;
  const stop = startSelfReloadWatcher(directory, () => reloads++, { pollMs: 10, settleMs: 60 });
  t.after(stop);
  writeFileSync(join(directory, 'notes.txt'), 'not runtime code');
  await delay(90);
  assert.equal(reloads, 0);
  const marker = join(root, '.update-in-progress');
  writeFileSync(marker, 'installing');
  writeFileSync(join(directory, 'server.mjs'), '// new version');
  await delay(100);
  assert.equal(reloads, 0, 'No restart while installer is copying');
  writeFileSync(join(directory, 'ui.mjs'), '// newly added module');
  rmSync(marker);
  await delay(25);
  writeFileSync(join(directory, 'ui.mjs'), '// last file in the batch');
  await delay(35);
  assert.equal(reloads, 0, 'Each new write resets the quiet period');
  for (let i = 0; i < 100 && reloads === 0; i++) await delay(10);
  assert.equal(reloads, 1);
  writeFileSync(join(directory, 'server.mjs'), '// would be handled by the next process');
  await delay(100);
  assert.equal(reloads, 1);
});

test('reload detects module removal and plugin manifest changes; stop cancels pending work', async t => {
  const { root, directory } = fixture(t);
  for (const change of [
    () => { writeFileSync(join(root, 'plugin.json'), '{"version":"2"}'); },
    () => { rmSync(join(directory, 'server.mjs')); },
  ]) {
    let reloaded = false;
    const stop = startSelfReloadWatcher(directory, () => { reloaded = true; }, { pollMs: 10, settleMs: 30 });
    t.after(stop);
    change();
    for (let i = 0; i < 100 && !reloaded; i++) await delay(10);
    assert.equal(reloaded, true);
  }
  let reloaded = false;
  const stop = startSelfReloadWatcher(directory, () => { reloaded = true; }, { pollMs: 10, settleMs: 50 });
  writeFileSync(join(directory, 'ui.mjs'), '// changed');
  await delay(20);
  stop();
  await delay(100);
  assert.equal(reloaded, false);
});
