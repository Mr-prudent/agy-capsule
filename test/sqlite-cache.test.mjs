import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSnapshotCache } from '../agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs';

test('unchanged SQLite is reused; WAL-only writes and checkpoints refresh it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wal-'));
  const path = join(dir, 'test.db');
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats(value INTEGER); INSERT INTO stats VALUES(1)');
    let reads = 0;
    const cache = createSqliteSnapshotCache(file => {
      reads++;
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare('SELECT value FROM stats').get().value; }
      finally { db.close(); }
    });
    assert.equal(cache.read(path), 1);
    assert.equal(cache.read(path), 1);
    assert.equal(reads, 1);
    const mainBefore = statSync(path).mtimeMs;
    writer.exec('UPDATE stats SET value=2');
    assert.equal(statSync(path).mtimeMs, mainBefore, 'This update lives in WAL, not the main DB');
    assert.equal(cache.read(path), 2);
    assert.equal(reads, 2);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(cache.read(path), 2);
    assert.equal(reads, 3);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unready files do not read; failed refresh retries its own snapshot without leaking another conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unready-'));
  try {
    const a = join(dir, 'a.db'), b = join(dir, 'b.db');
    let fail = false, reads = 0;
    const cache = createSqliteSnapshotCache(file => { reads++; if (fail) throw new Error('busy'); return statSync(file).size; });
    assert.equal(cache.read(a), null);
    writeFileSync(a, ''); assert.equal(cache.read(a), null); assert.equal(reads, 0);
    writeFileSync(a, 'a'); assert.equal(cache.read(a), 1);
    fail = true; writeFileSync(a, 'changed'); assert.equal(cache.read(a), 1);
    writeFileSync(b, 'b'); assert.equal(cache.read(b), null);
    fail = false; assert.equal(cache.read(a), 7);
    rmSync(a); assert.equal(cache.read(a), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('turn metrics can be enabled and disabled on an unchanged database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-metric-mode-'));
  const path = join(dir, 'test.db');
  try {
    writeFileSync(path, 'fixture');
    let reads = 0;
    const cache = createSqliteSnapshotCache((_, includeTurnMetrics) => ({ turnMetrics: includeTurnMetrics ? { requestCount: 2 } : null, read: ++reads }));
    assert.deepEqual(cache.read(path, false), { turnMetrics: null, read: 1 });
    assert.deepEqual(cache.read(path, true), { turnMetrics: { requestCount: 2 }, read: 2 });
    assert.deepEqual(cache.read(path, true), { turnMetrics: { requestCount: 2 }, read: 2 });
    assert.deepEqual(cache.read(path, false), { turnMetrics: null, read: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a write during a read is detected by the next poll rather than frozen under a later stamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-race-'));
  const file = join(dir, 'test.db'); writeFileSync(file, 'a');
  try {
    let reads = 0;
    const cache = createSqliteSnapshotCache(path => {
      const result = statSync(path).size;
      if (++reads === 1) writeFileSync(path, 'updated');
      return result;
    });
    assert.equal(cache.read(file), 1);
    assert.equal(cache.read(file), 7);
    assert.equal(reads, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('metadata-only ctime changes on WAL or DB do not invalidate the cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ctime-'));
  const path = join(dir, 'test.db');
  const wal = path + '-wal';
  const writer = new DatabaseSync(path);
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const bumpCtimeOnly = (file, baseline) => {
    const mode = Number(baseline.mode & 0o777n);
    const deadline = Date.now() + 1000;
    try {
      do {
        chmodSync(file, 0o444);
        chmodSync(file, mode);
        if (statSync(file, { bigint: true }).ctimeNs !== baseline.ctimeNs) break;
        Atomics.wait(sleep, 0, 0, 20);
      } while (Date.now() < deadline);
    } finally {
      chmodSync(file, mode);
    }
    const after = statSync(file, { bigint: true });
    assert.equal(after.ino, baseline.ino);
    assert.equal(after.size, baseline.size);
    assert.equal(after.mtimeNs, baseline.mtimeNs);
    assert.notEqual(after.ctimeNs, baseline.ctimeNs, 'Expected a ctime-only metadata update');
  };
  let dbMode = 0o666, walMode = 0o666;
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats(value INTEGER); INSERT INTO stats VALUES(1)');
    const dbBefore = statSync(path, { bigint: true });
    const walBefore = statSync(wal, { bigint: true });
    dbMode = Number(dbBefore.mode & 0o777n);
    walMode = Number(walBefore.mode & 0o777n);
    let reads = 0;
    const cache = createSqliteSnapshotCache(file => {
      reads++;
      const db = new DatabaseSync(file, { readOnly: true });
      let value;
      try { value = db.prepare('SELECT value FROM stats').get().value; }
      finally { db.close(); }
      if (reads === 1) bumpCtimeOnly(wal, walBefore);
      return value;
    });
    assert.equal(cache.read(path), 1);
    assert.equal(cache.read(path), 1);
    assert.equal(reads, 1);
    bumpCtimeOnly(path, dbBefore);
    assert.equal(cache.read(path), 1);
    assert.equal(reads, 1);
    writer.exec('UPDATE stats SET value=2');
    assert.equal(cache.read(path), 2);
    assert.equal(reads, 2);
  } finally {
    try { chmodSync(wal, walMode); } catch {}
    try { chmodSync(path, dbMode); } catch {}
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
