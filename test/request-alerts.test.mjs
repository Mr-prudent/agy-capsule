import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestError } from '../agy-capsule/sidecars/agy_capsule/errors.mjs';
import { summarizeTurnQueue } from '../agy-capsule/sidecars/agy_capsule/metrics.mjs';
import { createPresentation } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';
import { parseGenRow, readConversationSnapshot } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('request failure classification follows reported errors rather than quota percentages', () => {
  for (const [message, kind] of [
    ['quota exceeded', 'quota_exhausted'], ['429 Too Many Requests retry in 30s', 'rate_limited'],
    ['ECONNRESET', 'network_error'], ['401 Unauthorized', 'auth_error'], ['503 Service Unavailable', 'service_unavailable'],
    ['unexpected provider failure', 'unknown'], ['context canceled by user', 'canceled'],
    ['request failed: Post "https://<API>/v1internal:streamGenerateContent?alt=sse": context canceled', 'canceled'], ['User cancelled agent execution.', 'canceled'],
    ['input token count exceeds the maximum context length', 'context_overflow'], ['context deadline exceeded', 'network_error'],
    ['The input token count (737355) exceeds the maximum number of tokens allowed (524288)', 'context_overflow'],
    ['prompt is too long: 200001 tokens > 200000 maximum', 'context_overflow'],
    ['401 permission denied; quota access rejected', 'auth_error'], ['', 'none'],
  ]) assert.equal(classifyRequestError(message).kind, kind, message);
  assert.equal(classifyRequestError('429 retry in 30s').retryAfterSec, 30);
  assert.equal(classifyRequestError('429 Too Many Requests').retryAfterSec, null);
  assert.equal(classifyRequestError('failed at https://example.invalid/private?key=secret').diagnostic, 'failed at <API>');
});

test('colors and request failure capsule are independent, with no cancellation/overflow failure capsule', () => {
  const ui = createPresentation();
  const data = { contextTokens: 75, maxContextTokens: 100, requestError: classifyRequestError('429 Too Many Requests') };
  assert.equal(ui.alertView(data).contextTone, 'warning');
  assert.equal(ui.alertView(data).visible, true);
  assert.equal(ui.alertView(data, { showContextWarnings: false }).visible, true);
  assert.equal(ui.alertView(data, { showContextWarnings: false }).contextTone, '');
  assert.equal(ui.alertView(data, { showRequestErrors: false }).contextTone, 'warning');
  assert.equal(ui.alertView(data, { showRequestErrors: false }).visible, false);
  for (const percent of [90, 100, 125]) assert.equal(ui.alertView({ ...data, contextTokens: percent }).contextTone, 'error');
  for (const error of ['context canceled by user', 'maximum context length exceeded', '']) {
    assert.equal(ui.alertView({ ...data, requestError: classifyRequestError(error) }).visible, false);
  }
  const unknown = ui.alertView({ ...data, requestError: classifyRequestError('unknown failure') }, {}, ui.dictionaries['zh-CN']);
  assert.equal(unknown.label, '未知原因');
});

function vi(value) {
  let n = BigInt(value); const bytes = [];
  while (n >= 128n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
  return Buffer.from([...bytes, Number(n)]);
}
const field = (n, data) => Buffer.concat([vi(n * 8 + 2), vi(data.length), data]);
const retry = text => field(17, field(3, Buffer.from(text)));

test('SQLite decodes the final RetryInfo.error and clears an earlier failed retry after success', () => {
  const error = parseGenRow(3, field(1, retry('429 Too Many Requests')));
  assert.equal(error.requestError.kind, 'rate_limited');
  const recovered = parseGenRow(3, field(1, Buffer.concat([retry('ECONNRESET'), retry('')])));
  assert.equal(recovered.requestError.kind, 'none');
  const cancelled = parseGenRow(4, field(1, retry('context canceled by user')));
  assert.equal(cancelled.requestError.kind, 'canceled');
});

test('summarizeTurnQueue tracks per-turn waits, ignores active tools and prevents double counting', () => {
  const user = { idx: 10, step_type: 14, status: 3, createdAtMs: 100000 };
  const priorReq = { lastStepIndex: 4, stepIndices: [5], generation: { ttft: 90 } };
  const slowReq = { lastStepIndex: 10, stepIndices: [11], generation: { ttft: 35 } };
  const plannerDone = { idx: 11, step_type: 15, status: 3, createdAtMs: 100000, generatingAtMs: 135000, recordedCompletedAtMs: 140000 };
  const toolRunning = { idx: 12, step_type: 132, status: 2, createdAtMs: 140100 };

  const duringTool = summarizeTurnQueue([priorReq, slowReq], [user, plannerDone, toolRunning], 10);
  assert.deepEqual(duringTool.waits, [35], 'ignores prior turns and deduplicates covered planner step');
  assert.equal(duringTool.waitingSinceMs, null, 'active tool must not trigger server queue timer');

  const toolDone = { ...toolRunning, status: 3, recordedCompletedAtMs: 145000 };
  const afterTool = summarizeTurnQueue([priorReq, slowReq], [user, plannerDone, toolDone], 10);
  assert.equal(afterTool.waitingSinceMs, 145000, 'server wait anchors to completed tool timestamp');

  const streamingNext = { idx: 13, step_type: 15, status: 8, createdAtMs: 145050, generatingAtMs: 180050 };
  const duringStream = summarizeTurnQueue([priorReq, slowReq], [user, plannerDone, toolDone, streamingNext], 10);
  assert.deepEqual(duringStream.waits, [35, 35], 'streaming step exposes wait before gen_metadata commits');
  assert.equal(duringStream.waitingSinceMs, null, 'streaming response is no longer waiting in queue');

  const terminal = summarizeTurnQueue([priorReq, slowReq], [user, plannerDone], 10, [{ lastStepIndex: 11, reason: 4, executionId: '' }]);
  assert.equal(terminal.turnTerminal, true);
  assert.equal(terminal.waitingSinceMs, null);
  assert.deepEqual(terminal.waits, [35]);
});

test('third capsule shows server queue warnings with xN multiplier, respects toggle and yields to request errors', () => {
  const ui = createPresentation();
  const t0 = 200000;
  const liveQueue = { userStepIndex: 10, waits: [], waitingSinceMs: t0, hasPendingPlanner: false, turnTerminal: false };

  // Below threshold or not running -> hidden
  assert.equal(ui.alertView({ turnQueue: liveQueue }, { showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 29000, true).visible, false);
  assert.equal(ui.alertView({ turnQueue: liveQueue }, { showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 45000, false).visible, false);

  // Live wait >= 30s while running -> pops up with live seconds
  const live1 = ui.alertView({ turnQueue: liveQueue }, { showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries['zh-CN'], t0 + 35000, true);
  assert.equal(live1.mode, 'queue');
  assert.equal(live1.visible, true);
  assert.equal(live1.label, '排队 35s');
  assert.equal(live1.heading, '服务器排队');
  assert.equal(live1.queueCount, 1);

  // Second slow wait in the same turn -> x2 multiplier
  const multi = { ...liveQueue, waits: [32.4], waitingSinceMs: t0 };
  const live2 = ui.alertView({ turnQueue: multi }, { showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries['zh-CN'], t0 + 40000, true);
  assert.equal(live2.label, '排队×2 40s');
  assert.equal(live2.heading, '服务器排队 ×2');
  assert.equal(live2.queueCount, 2);
  assert.match(live2.diagnostic, /32s, 40s\+/);

  // Turn finished with 2 slow waits -> keeps x2 without live seconds
  const finished = ui.alertView({ turnQueue: { userStepIndex: 10, waits: [31, 45], waitingSinceMs: null, hasPendingPlanner: false, turnTerminal: true } }, { showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 999000, false);
  assert.equal(finished.mode, 'queue');
  assert.equal(finished.label, 'Queue×2');
  assert.equal(finished.heading, 'Server queue ×2');

  // Toggle off hides queue warning
  assert.equal(ui.alertView({ turnQueue: multi }, { showQueueWarnings: false, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 40000, true).visible, false);

  // Request failure takes priority over queue warning on third capsule
  const errAndQueue = ui.alertView({ turnQueue: multi, requestError: classifyRequestError('429 Too Many Requests') }, { showRequestErrors: true, showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 40000, true);
  assert.equal(errAndQueue.mode, 'error');
  assert.equal(errAndQueue.label, 'Rate limited');

  // When request errors are hidden, queue warning still renders if enabled
  const queueOnly = ui.alertView({ turnQueue: multi, requestError: classifyRequestError('429 Too Many Requests') }, { showRequestErrors: false, showQueueWarnings: true, queueWarnSec: 30 }, ui.dictionaries.en, t0 + 40000, true);
  assert.equal(queueOnly.mode, 'queue');
  assert.equal(queueOnly.visible, true);
});

test('SQLite snapshot exposes turnQueue regardless of showTurnMetrics', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-queue-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  const integer = (n, v) => Buffer.concat([vi(n * 8), vi(v)]);
  const ts = (n, sec) => field(n, integer(1, sec));
  const trans = (st, sec) => field(1, Buffer.concat([integer(1, st), ts(2, sec)]));
  db.prepare('INSERT INTO steps VALUES (?,?,?,?)').run(10, 14, 3, ts(1, 100));
  db.prepare('INSERT INTO steps VALUES (?,?,?,?)').run(11, 15, 8, Buffer.concat([ts(1, 101), field(26, trans(8, 136))]));
  db.close();
  const snapOff = readConversationSnapshot(path, false);
  const snapOn = readConversationSnapshot(path, true);
  assert.deepEqual(snapOff.turnQueue.waits, [35]);
  assert.deepEqual(snapOn.turnQueue, snapOff.turnQueue);
});
