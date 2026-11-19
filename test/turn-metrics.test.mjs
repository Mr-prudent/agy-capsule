import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTurnMetrics } from '../agy-capsule/sidecars/agy_capsule/turn_metrics.mjs';
import { parseGenRow, readConversationSnapshot, UI_HTML } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { buildRuntimeBundle } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPresentation, getPresentationScript } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';
import vm from 'node:vm';

const usage = (read = 100, write = 10, thinking = 5) => ({ read, cachedRead: read * .8, uncachedRead: read * .2, write, thinking });
const request = (idx, lastStepIndex, usages = [usage()]) => ({ generation: { requestIndex: idx }, lastStepIndex, stepIndices: [lastStepIndex + 1], attempts: usages.map(usage => ({ usage })) });
const user = { idx: 10, step_type: 14, status: 3, createdAtMs: 1000 };
const end = { idx: 15, step_type: 15, status: 3, completedAtMs: 21000, executionId: 'run' };
const executor = { lastStepIndex: 15, reason: 4, executionId: 'run' };

test('turn tokens sum repeated inputs and retry attempts; wall time is not summed request time', () => {
  const result = summarizeTurnMetrics([request(0, 4), request(1, 10), request(2, 12, [usage(50, 4, 2), usage(100, 10, 5)])], [user, end], 10, [executor]);
  assert.equal(result.requestCount, 3);
  assert.equal(result.read, 250);
  assert.equal(result.cachedRead, 200);
  assert.equal(result.uncachedRead, 50);
  assert.equal(result.write, 24);
  assert.equal(result.thinking, 12);
  assert.equal(result.duration, 20);
  assert.equal(result.state, 'completed');
  assert.equal(summarizeTurnMetrics([], [{ ...user, idx: 20, createdAtMs: 30000 }], 20).read, 0);
  assert.equal(summarizeTurnMetrics([], [], null), null);
});

test('queued messages reset the scope; active tools keep the clock running; older executor records cannot freeze it', () => {
  const queued = { ...user, idx: 20, status: 11, createdAtMs: 30000 };
  const result = summarizeTurnMetrics([request(0, 10)], [user, end, queued], 20, [executor]);
  assert.equal(result.requestCount, 0);
  assert.equal(result.read, 0);
  assert.equal(result.state, 'queued');
  assert.equal(result.duration, null);
  const tool = { idx: 16, step_type: 132, status: 2, executionId: 'next' };
  assert.equal(summarizeTurnMetrics([], [user, end, tool], 10, [executor]).state, 'running');
  assert.equal(summarizeTurnMetrics([], [user, end, { ...tool, status: 3 }], 10, [executor]).state, 'unknown');
});

test('missing usage and ambiguous associations stay unknown; cancellations need an actual cancellation timestamp', () => {
  const unknown = Object.fromEntries(Object.keys(usage()).map(key => [key, null]));
  const result = summarizeTurnMetrics([request(0, 10, [unknown, usage()])], [user, end], 10, [executor]);
  assert.equal(result.requestCount, 2);
  assert.equal(result.read, null);
  assert.equal(result.write, null);
  assert.equal(result.knownTotals.read, 100);
  assert.equal(result.missingUsageRequests, 1);
  const cancelled = summarizeTurnMetrics([], [user, end], 10, [{ ...executor, reason: 2 }]);
  assert.equal(cancelled.state, 'interrupted');
  assert.equal(cancelled.duration, null, 'Last DONE timestamp is not a cancellation timestamp');
  const oldCancellation = { idx: 11, step_type: 132, status: 6, terminalAtMs: 5000, executionId: 'run' };
  assert.equal(summarizeTurnMetrics([], [user, oldCancellation, end], 10, [{ ...executor, reason: 2 }]).duration, null);
  const actualCancel = { ...end, status: 6, completedAtMs: null, terminalAtMs: 23000 };
  assert.equal(summarizeTurnMetrics([], [user, actualCancel], 10, [{ ...executor, reason: 2 }]).duration, 22);
  const unlinked = { ...request(1, -1), stepIndices: [15] };
  assert.equal(summarizeTurnMetrics([unlinked], [user, end], 10, [executor]).requestCount, null);
  const pending = { ...request(1, 10, []), pendingAttempt: true };
  assert.equal(summarizeTurnMetrics([pending], [user, end], 10).read, null);
});

const vi = value => { let n = BigInt(value); const bytes = []; while (n >= 128n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; } return Buffer.from([...bytes, Number(n)]); };
const integer = (field, n) => Buffer.concat([vi(field * 8), vi(n)]);
const message = (field, data) => Buffer.concat([vi(field * 8 + 2), vi(data.length), data]);
const text = (field, value) => message(field, Buffer.from(value));
const stamp = (field, seconds) => message(field, integer(1, seconds));
const counters = Buffer.concat([integer(2, 20), integer(5, 80), integer(3, 15), integer(10, 10), integer(9, 5)]);
const chat = (retries = [message(2, counters)]) => message(1, Buffer.concat([
  message(4, counters), stamp(11, 2), stamp(12, 3), integer(14, retries.length - 1), ...retries.map(retry => message(17, retry)),
  message(20, Buffer.concat([text(1, 'last_step_index'), text(2, '10')])),
]));

test('protobuf distinguishes preflight, failed retries and reported usage without double counting the final attempt', () => {
  const row = parseGenRow(1, chat([Buffer.concat([message(2, Buffer.alloc(0)), text(3, 'failed')]), message(2, counters)]));
  assert.equal(row.attempts.length, 2);
  assert.equal(row.attempts[0].usage.read, null);
  assert.equal(row.attempts[1].usage.read, 100);
  assert.equal(row.attempts[1].usage.write, 10);
  assert.equal(parseGenRow(2, message(1, message(4, integer(2, 100)))).attempts.length, 0);
});

test('SQLite snapshot integrates latest user timestamps, request attempts and executor termination', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-turn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  const insert = db.prepare('INSERT INTO steps VALUES (?,?,?,?)');
  insert.run(10, 14, 3, stamp(1, 1));
  insert.run(11, 15, 3, Buffer.concat([stamp(1, 2), stamp(8, 21), text(12, 'run')]));
  db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(0, Buffer.concat([chat(), integer(2, 11)]));
  db.prepare('INSERT INTO executor_metadata VALUES (?,?)').run(0, Buffer.concat([integer(1, 4), integer(3, 11), text(9, 'run')]));
  db.close();
  const result = readConversationSnapshot(path);
  assert.equal(result.turnMetrics.requestCount, 1);
  assert.equal(result.turnMetrics.read, 100);
  assert.equal(result.turnMetrics.duration, 20);
  assert.equal(result.turnMetrics.state, 'completed');
  assert.equal(result.contextTokens, 100, 'Existing context occupancy remains request-scoped');
  assert.equal(result.turnSpeed.generation.tps, 3);
  assert.deepEqual(readConversationSnapshot(path, false), { ...result, turnMetrics: null }, 'Disabling turn metrics preserves other telemetry');
});

test('turn display keeps scopes separate, exposes missing usage and updates elapsed time from anchors', () => {
  const ui = createPresentation();
  const data = summarizeTurnMetrics([request(0, 10)], [user, { idx: 11, step_type: 132, status: 2 }], 10);
  const initial = ui.turnMetricsText(data, ui.dictionaries.en, 21000);
  const later = ui.turnMetricsText(data, ui.dictionaries.en, 26000);
  assert.equal(initial.elapsed, '20s');
  assert.equal(later.elapsed, '25s');
  assert.equal(initial.write, '10');
  assert.equal(initial.thinking, '5');
  assert.equal('read' in initial, false);
  assert.doesNotMatch(ui.turnMetricsMarkup(), /turnRead/);
  const missing = { ...data, write: null, thinking: null, missingUsageRequests: 1 };
  assert.equal(ui.turnMetricsText(missing).write, '—');
  assert.match(ui.turnMetricsText(missing).writeTitle, /Recorded: 10/);
  const completed = { ...data, state: 'completed', duration: 20 };
  assert.equal(initial.requests, '1');
  assert.equal(ui.turnMetricsText(completed, ui.dictionaries.en, 999999).elapsed, '20s');
  for (const [sec, expected] of [[1, '1s'], [40, '40s'], [59.9, '59s'], [60, '1m'], [100, '1m40s'], [599, '9m59s'], [600, '10m'], [3599, '59m'], [3600, '1h'], [6000, '1h40m'], [35940, '9h59m'], [36000, '10h']]) {
    assert.equal(ui.turnMetricsText({ ...completed, duration: sec }, ui.dictionaries.en, 999999).elapsed, expected);
  }
  assert.equal(ui.turnMetricsText({ ...completed, requestCount: 4 }, ui.dictionaries.en, 999999).requests, '4');
  assert.equal(ui.turnMetricsText({ ...completed, duration: null }).elapsed, '—');
  assert.equal(ui.turnMetricsText({ ...completed, duration: null, requestCount: null }).requests, '—');
  assert.equal(ui.dictionaries['zh-CN'].turnLabel, '本轮');
  assert.equal(ui.dictionaries['zh-CN'].turnReqsLabel, '请求');
  assert.equal(ui.dictionaries['zh-CN'].turnReqsShort, '请');
  assert.equal(ui.dictionaries['zh-TW'].turnLabel, '本輪');
  assert.equal(ui.dictionaries['zh-TW'].turnReqsLabel, '請求');
  assert.equal(ui.dictionaries['zh-TW'].turnReqsShort, '請');
  const midTurnGap = summarizeTurnMetrics([], [{ ...user, idx: 10, createdAtMs: 1000 }, { idx: 11, step_type: 132, status: 3 }], 10);
  assert.equal(midTurnGap.state, 'unknown');
  assert.equal(ui.turnMetricsText(midTurnGap, ui.dictionaries.en, 16000).elapsed, '15s');
  assert.equal(ui.turnMetricsText({ ...midTurnGap, state: 'failed', duration: 15 }, ui.dictionaries.en, 99000).elapsed, '15s');
});

test('SQLite snapshot treats omitted proto3 last_step_index in executor_metadata as step 0', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-turn-zero-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'zero.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db.prepare('INSERT INTO steps VALUES (?,?,?,?)').run(0, 14, 3, Buffer.concat([stamp(1, 1), text(12, 'run0')]));
  db.prepare('INSERT INTO executor_metadata VALUES (?,?)').run(0, Buffer.concat([integer(1, 2), text(9, 'run0')]));
  db.close();
  const result = readConversationSnapshot(path);
  assert.equal(result.turnMetrics.state, 'interrupted');
});

test('embedded runtime includes turn presentation without relying on module imports', () => {
  const scope = {};
  vm.runInNewContext(getPresentationScript(), scope);
  assert.equal(typeof scope.__agyCapsulePresentation.renderTurnMetrics, 'function');
  assert.match(scope.__agyCapsulePresentation.turnMetricsMarkup(), /data-turn-metrics-block/);
});

test('context and turn four-column strips share equal CSS grid tracks so vertical bars align', () => {
  const ui = createPresentation();
  const deckCode = buildRuntimeBundle(5000).code;
  assert.match(deckCode, /#deck-metrics-strip \.dk-list,\s*#deck-metrics-strip \.turn-bar-list\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
  assert.match(deckCode, /#deck-metrics-strip \.turn-bar-list\s*\{[^}]*grid-template-columns:\s*minmax\(calc\(\(100% - 12px\) \/ 4\),\s*max-content\)\s*minmax\(0,\s*1fr\)\s*calc\(\(100% - 12px\) \/ 4\)\s*calc\(\(100% - 12px\) \/ 4\);/s);
  assert.match(UI_HTML, /\.list,\s*\.turn-bar-list\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
  assert.match(UI_HTML, /\.turn-bar-list\s*\{[^}]*grid-template-columns:\s*minmax\(calc\(\(100% - 18px\) \/ 4\),\s*max-content\)\s*minmax\(0,\s*1fr\)\s*calc\(\(100% - 18px\) \/ 4\)\s*calc\(\(100% - 18px\) \/ 4\);/s);
  assert.match(UI_HTML, /data-preview-group="turn"[^]*?class="pv-detail-card pv-live"><div class="turn-bar-list">/);
  assert.match(ui.turnMetricsMarkup(), /class="turn-bar-short"[^>]*data-i18n="turnReqsShort"[^>]*>Re</);
  assert.match(deckCode, /@container\s*\(max-width:\s*39px\)/);
  assert.match(UI_HTML, /@container\s*\(max-width:\s*39px\)/);
});
